sub init()
    m.top.functionName = "loop"
end sub

sub loop()
    port = CreateObject("roMessagePort")
    sock = CreateObject("roDatagramSocket")
    sock.SetMessagePort(port)
    here = CreateObject("roSocketAddress")
    here.SetPort(0)
    sock.SetAddress(here)
    sock.SetBroadcast(true)
    sock.NotifyReadable(true)
    dest = CreateObject("roSocketAddress")
    dest.SetAddress("255.255.255.255:47800")

    found = {}
    clock = CreateObject("roTimespan")
    nextSend = 0
    while not m.top.stop
        now = clock.TotalMilliseconds()
        if now >= nextSend
            sock.SetSendToAddress(dest)
            sock.SendStr("ESTEEFCAST_DISCOVER")
            nextSend = now + 2000
            list = []
            for each k in found
                h = found[k]
                if now - h.seen < 7000 then list.Push(h)
            end for
            m.top.hosts = list
        end if
        msg = wait(250, port)
        if type(msg) = "roSocketEvent" and sock.IsReadable()
            data = sock.ReceiveStr(4096)
            from = sock.GetReceivedFromAddress()
            j = ParseJson(data)
            if j <> invalid and j.app = "EsteefCast" and from <> invalid
                ip = from.GetAddress().Split(":")[0]
                pcPort = 47801
                if j.port <> invalid then pcPort = j.port
                sharing = false
                if type(j.sharing) = "roBoolean" or type(j.sharing) = "Boolean" then sharing = j.sharing
                name = "PC"
                if j.name <> invalid then name = j.name
                title = ""
                if j.title <> invalid then title = j.title
                found[ip + ":" + pcPort.ToStr()] = { ip: ip, port: pcPort, name: name, sharing: sharing, title: title, seen: clock.TotalMilliseconds() }
            end if
        end if
    end while
    sock.Close()
end sub
