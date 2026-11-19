sub init()
    m.top.functionName = "work"
end sub

' request: { kind, url, query (assocarray, escaped here), body (POST if set), timeout (ms) }
' response: { kind, ok, code, data (parsed JSON or invalid) }
sub work()
    req = m.top.request
    xfer = CreateObject("roUrlTransfer")
    port = CreateObject("roMessagePort")
    xfer.SetMessagePort(port)

    url = req.url
    if req.query <> invalid
        sep = "?"
        for each k in req.query
            url = url + sep + k + "=" + xfer.Escape(req.query[k])
            sep = "&"
        end for
    end if
    xfer.SetUrl(url)

    timeoutMs = 10000
    if req.timeout <> invalid then timeoutMs = req.timeout

    res = { kind: req.kind, ok: false, code: 0, data: invalid }
    started = false
    if req.body <> invalid
        xfer.AddHeader("Content-Type", "text/plain")
        started = xfer.AsyncPostFromString(req.body)
    else
        started = xfer.AsyncGetToString()
    end if

    if started
        msg = wait(timeoutMs, port)
        if type(msg) = "roUrlEvent"
            res.code = msg.GetResponseCode()
            body = msg.GetString()
            if body <> invalid and body <> "" then res.data = ParseJson(body)
            res.ok = (res.code = 200)
        else
            xfer.AsyncCancel()
            res.code = -1
        end if
    end if
    m.top.response = res
end sub
