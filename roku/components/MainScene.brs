' EsteefCast main screen: the PC list, then the full-screen player.

sub init()
    m.list = m.top.FindNode("pcList")
    m.status = m.top.FindNode("status")
    m.video = m.top.FindNode("video")
    m.overlay = m.top.FindNode("overlay")
    m.message = m.top.FindNode("message")
    m.statsBg = m.top.FindNode("statsBg")
    m.stats = m.top.FindNode("stats")

    di = CreateObject("roDeviceInfo")
    m.deviceId = di.GetChannelClientId()
    m.deviceName = di.GetFriendlyName()
    if m.deviceName = invalid or m.deviceName = "" then m.deviceName = "Roku " + di.GetModelDisplayName()
    m.model = di.GetModelDisplayName() + " (" + di.GetModel() + "), Roku OS " + di.GetOSVersion().major + "." + di.GetOSVersion().minor

    m.found = []
    m.items = []
    m.current = invalid   ' the PC being watched: { ip, port, name }
    m.base = ""
    m.token = ""
    m.denied = false
    m.playing = false
    m.waitingHello = false
    m.ticks = 0
    m.pending = []        ' keeps running NetTasks alive

    m.list.ObserveField("itemSelected", "onSelect")
    m.video.ObserveField("state", "onVideoState")

    m.disc = CreateObject("roSGNode", "DiscoveryTask")
    m.disc.ObserveField("hosts", "onHosts")
    m.disc.control = "RUN"

    m.timer = CreateObject("roSGNode", "Timer")
    m.timer.repeat = true
    m.timer.duration = 3
    m.timer.ObserveField("fire", "onTick")
    m.timer.control = "start"

    render()
    m.list.SetFocus(true)
end sub

' ---------- saved addresses ----------
function loadManual() as object
    sec = CreateObject("roRegistrySection", "ecast")
    if sec.Exists("manual")
        v = ParseJson(sec.Read("manual"))
        if type(v) = "roArray" then return v
    end if
    return []
end function

sub saveManual(list as object)
    sec = CreateObject("roRegistrySection", "ecast")
    sec.Write("manual", FormatJson(list))
    sec.Flush()
end sub

' ---------- PC list ----------
sub onHosts()
    m.found = m.disc.hosts
    if m.current = invalid then render()
end sub

sub render()
    focused = m.list.itemFocused
    m.items = []
    seen = {}
    for each h in m.found
        key = h.ip + ":" + h.port.ToStr()
        seen[key] = true
        sub_ = "Online, not sharing yet"
        if h.sharing then sub_ = "Sharing now: " + h.title
        m.items.Push({ kind: "pc", ip: h.ip, port: h.port, name: h.name, label: h.name + "      " + sub_ })
    end for
    for each a in loadManual()
        key = a.ip + ":" + a.port.ToStr()
        if not seen.DoesExist(key)
            m.items.Push({ kind: "pc", ip: a.ip, port: a.port, name: a.ip, label: a.ip + "      Added by address" })
        end if
    end for
    m.items.Push({ kind: "add", label: "Enter address   (if your PC doesn't show up)" })

    content = CreateObject("roSGNode", "ContentNode")
    for each it in m.items
        c = content.CreateChild("ContentNode")
        c.title = it.label
    end for
    m.list.content = content
    if focused <> invalid and focused >= 0 and focused < m.items.Count() then m.list.jumpToItem = focused

    n = m.found.Count()
    if n = 0
        m.status.text = "Looking for PCs on your network... Open EsteefCast on your PC."
    else if n = 1
        m.status.text = "1 PC found"
    else
        m.status.text = n.ToStr() + " PCs found"
    end if
end sub

sub onSelect()
    it = m.items[m.list.itemSelected]
    if it = invalid then return
    if it.kind = "add"
        askAddress()
    else
        connectTo(it)
    end if
end sub

sub askAddress()
    d = CreateObject("roSGNode", "StandardKeyboardDialog")
    d.title = "PC address"
    d.message = ["Type the address shown in EsteefCast on your PC, for example 192.168.1.20"]
    d.buttons = ["Connect", "Cancel"]
    d.ObserveField("buttonSelected", "onAddressButton")
    m.top.dialog = d
end sub

sub onAddressButton()
    d = m.top.dialog
    if d = invalid then return
    choice = d.buttonSelected
    text = d.text
    d.close = true
    if choice <> 0 then return
    text = text.Trim().Replace("http://", "")
    if text = "" then return
    parts = text.Split(":")
    ip = parts[0]
    pcPort = 47801
    if parts.Count() > 1 and Val(parts[1]) > 0 then pcPort = Int(Val(parts[1]))
    list = loadManual()
    exists = false
    for each a in list
        if a.ip = ip and a.port = pcPort then exists = true
    end for
    if not exists
        list.Push({ ip: ip, port: pcPort })
        saveManual(list)
    end if
    render()
    connectTo({ ip: ip, port: pcPort, name: ip })
end sub

' ---------- talking to the PC ----------
sub request(kind as string, path as string, query as object, body as dynamic, timeout as integer)
    t = CreateObject("roSGNode", "NetTask")
    t.request = { kind: kind, url: m.base + path, query: query, body: body, timeout: timeout }
    t.ObserveField("response", "onResponse")
    t.control = "RUN"
    m.pending.Push(t)
end sub

sub onResponse(ev as object)
    t = ev.GetRoSGNode()
    res = ev.GetData()
    keep = []
    for each p in m.pending
        if not p.IsSameNode(t) then keep.Push(p)
    end for
    m.pending = keep
    if m.current = invalid then return
    if res.kind = "hello" then onHello(res)
    if res.kind = "state" then onState(res)
end sub

sub connectTo(h as object)
    m.current = { ip: h.ip, port: h.port, name: h.name }
    m.base = "http://" + h.ip + ":" + h.port.ToStr()
    m.token = ""
    m.denied = false
    showMessage("Asking " + h.name + " for permission..." + Chr(10) + "If a prompt appears on the PC, choose Allow.")
    hello()
end sub

sub hello()
    m.waitingHello = true
    request("hello", "/roku/hello", { id: m.deviceId, name: m.deviceName }, invalid, 65000)
end sub

sub onHello(res as object)
    m.waitingHello = false
    if res.ok and res.data <> invalid and res.data.ok = true
        m.token = res.data.token
        if res.data.hostName <> invalid then m.current.name = res.data.hostName
        postLog("connected; " + m.model)
        if res.data.sharing = true
            play()
        else
            showMessage(m.current.name + " isn't sharing right now." + Chr(10) + "It will appear here as soon as it starts.")
        end if
    else if res.data <> invalid and res.data.reason = "denied"
        m.denied = true
        showMessage(m.current.name + " didn't allow this Roku.")
    else
        showMessage("Can't reach " + m.current.name + "." + Chr(10) + "Make sure EsteefCast is running on the PC. Trying again...")
    end if
end sub

sub onState(res as object)
    if not res.ok or res.data = invalid
        if res.code = 403
            m.token = ""   ' the PC forgot this Roku: ask again
        else
            showMessage("Can't reach " + m.current.name + "." + Chr(10) + "Trying again...")
        end if
        return
    end if
    if res.data.sharing = true
        if not m.playing then play()
    else
        if m.playing then stopVideo()
        showMessage(m.current.name + " isn't sharing right now." + Chr(10) + "It will appear here as soon as it starts.")
    end if
end sub

sub onTick()
    m.ticks = m.ticks + 1
    if m.current = invalid or m.denied then return
    if m.token = ""
        if not m.waitingHello then hello()
        return
    end if
    if m.playing
        line = statsText()
        m.stats.text = line
        if m.ticks mod 2 = 0 then postLog(line.Replace(Chr(10), " | "))
    else
        request("state", "/roku/state", { t: m.token }, invalid, 8000)
    end if
end sub

sub postLog(text as string)
    if m.token = "" then return
    request("log", "/roku/log", { t: m.token }, text, 8000)
end sub

' ---------- playing ----------
sub play()
    content = CreateObject("roSGNode", "ContentNode")
    content.url = m.base + "/hls/live.m3u8?t=" + m.token
    content.streamFormat = "hls"
    content.live = true
    content.title = m.current.name
    m.video.content = content
    m.video.visible = true
    m.playing = true
    showMessage("Starting the picture...")
    m.video.control = "play"
    m.video.SetFocus(true)
end sub

sub stopVideo()
    m.video.control = "stop"
    m.video.visible = false
    m.playing = false
end sub

sub onVideoState()
    s = m.video.state
    if s = "playing"
        m.overlay.visible = false
        postLog("playing")
    else if s = "error"
        postLog("error " + m.video.errorCode.ToStr() + ": " + m.video.errorMsg + " / " + m.video.errorStr)
        stopVideo()
        showMessage("The picture stopped (" + m.video.errorMsg + ")." + Chr(10) + "Trying again...")
    else if s = "finished"
        postLog("stream finished")
        stopVideo()
        showMessage("Reconnecting...")
    end if
end sub

function statsText() as string
    v = m.video
    line = "state " + v.state + "   position " + Int(v.position).ToStr() + " s"
    si = v.streamInfo
    if si <> invalid
        if si.measuredBitrate <> invalid then line = line + Chr(10) + "measured " + (si.measuredBitrate / 1000000).ToStr() + " Mbps"
        if si.streamBitrate <> invalid then line = line + "   stream " + (si.streamBitrate / 1000000).ToStr() + " Mbps"
        if si.isUnderrun = true then line = line + "   UNDERRUN"
    end if
    seg = v.streamingSegment
    if seg <> invalid and seg.segUrl <> invalid then line = line + Chr(10) + "segment " + seg.segUrl.Split("?")[0]
    line = line + Chr(10) + m.current.name + " (" + m.current.ip + ")"
    return line
end function

sub showMessage(text as string)
    m.message.text = text
    m.overlay.visible = true
    if not m.playing then m.overlay.SetFocus(true)
end sub

sub leave()
    stopVideo()
    m.overlay.visible = false
    m.statsBg.visible = false
    m.current = invalid
    m.token = ""
    m.denied = false
    render()
    m.list.SetFocus(true)
end sub

function onKeyEvent(key as string, press as boolean) as boolean
    if not press then return false
    if key = "back" and m.current <> invalid
        leave()
        return true
    end if
    if (key = "OK" or key = "options" or key = "info") and m.current <> invalid
        m.statsBg.visible = not m.statsBg.visible
        if m.statsBg.visible and m.playing then m.stats.text = statsText()
        return true
    end if
    return false
end function
