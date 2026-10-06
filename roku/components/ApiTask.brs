sub init()
    m.top.functionName = "execute"
end sub

sub execute()
    if m.top.mode = "auth" then
        resp = request("POST", m.top.baseUrl + "/api/auth", FormatJson({ pin: m.top.pin }), "")
    else
        resp = request("GET", m.top.baseUrl + "/api/videos", "", m.top.token)
        if resp.code = 200 and resp.body.videos <> invalid then
            decorate(resp.body.videos)
        end if
    end if
    m.top.result = resp.body
    m.top.status = resp.code
end sub

' Adds ready-to-use thumbUrl / streamUrl to each video. Poster and Video nodes
' cannot send headers, so the auth token travels as a ?auth= query parameter,
' which the worker accepts alongside the browser cookie.
sub decorate(videos as object)
    xfer = CreateObject("roUrlTransfer")
    for each v in videos
        parts = v.key.split("/")
        encoded = ""
        for i = 0 to parts.count() - 1
            if i > 0 then encoded = encoded + "/"
            encoded = encoded + xfer.escape(parts[i])
        end for
        v.thumbUrl = m.top.baseUrl + "/api/thumb/" + encoded + "?auth=" + m.top.token
        v.streamUrl = m.top.baseUrl + "/api/stream/" + encoded + "?auth=" + m.top.token
    end for
end sub

function request(method as string, url as string, payload as string, token as string) as object
    xfer = CreateObject("roUrlTransfer")
    port = CreateObject("roMessagePort")
    xfer.setMessagePort(port)
    xfer.setCertificatesFile("common:/certs/ca-bundle.crt")
    xfer.initClientCertificates()
    xfer.retainBodyOnError(true)
    xfer.setUrl(url)
    xfer.addHeader("Accept", "application/json")
    if token <> "" then xfer.addHeader("Authorization", "Bearer " + token)

    started = false
    if method = "POST" then
        xfer.addHeader("Content-Type", "application/json")
        started = xfer.asyncPostFromString(payload)
    else
        started = xfer.asyncGetToString()
    end if

    code = 0
    body = {}
    if started then
        event = wait(30000, port)
        if type(event) = "roUrlEvent" then
            code = event.getResponseCode()
            text = event.getString()
            if text <> "" then
                parsed = ParseJson(text)
                if parsed <> invalid then body = parsed
            end if
        else
            xfer.asyncCancel()
        end if
    end if
    return { code: code, body: body }
end function
