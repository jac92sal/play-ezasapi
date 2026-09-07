sub init()
    ' The backend. Everything below talks to the play-ezasapi Cloudflare Worker.
    m.baseUrl = "https://play.ezasapi.com"
    m.pinLength = 4

    m.top.backgroundUri = ""
    m.top.backgroundColor = "0x0D0F14FF"

    m.grid = m.top.findNode("grid")
    m.player = m.top.findNode("player")
    m.status = m.top.findNode("status")
    m.videos = []
    m.currentIndex = -1
    m.submitting = false
    m.token = readRegistry("token")

    m.grid.observeField("itemSelected", "onItemSelected")
    m.player.observeField("state", "onPlayerState")

    if m.token <> "" then
        loadVideos()
    else
        askForPin("Enter the play.ezasapi PIN")
    end if
end sub

' ---------- PIN / auth ----------

sub askForPin(message as string)
    dialog = CreateObject("roSGNode", "PinDialog")
    dialog.title = "play.ezasapi"
    dialog.message = message
    dialog.buttons = ["Unlock"]
    dialog.pinPad.pinLength = m.pinLength
    dialog.pinPad.secureMode = true
    dialog.observeField("pin", "onPinEntered")
    dialog.observeField("buttonSelected", "onPinButton")
    m.pinDialog = dialog
    m.top.dialog = dialog
end sub

sub onPinEntered()
    pin = m.pinDialog.pin
    if Len(pin) >= m.pinLength then submitPin(pin)
end sub

sub onPinButton()
    submitPin(m.pinDialog.pin)
end sub

sub submitPin(pin as string)
    if m.submitting or pin = "" then return
    m.submitting = true
    m.pinDialog.close = true
    m.status.text = "Checking PIN…"

    m.authTask = CreateObject("roSGNode", "ApiTask")
    m.authTask.baseUrl = m.baseUrl
    m.authTask.mode = "auth"
    m.authTask.pin = pin
    m.authTask.observeField("status", "onAuthDone")
    m.authTask.control = "RUN"
end sub

sub onAuthDone()
    m.submitting = false
    result = m.authTask.result
    if m.authTask.status = 200 and result <> invalid and result.token <> invalid then
        m.token = result.token
        writeRegistry("token", m.token)
        loadVideos()
    else if m.authTask.status = 401 then
        askForPin("Wrong PIN, try again")
    else
        askForPin("Couldn't reach play.ezasapi.com (HTTP " + m.authTask.status.toStr() + ")")
    end if
end sub

' ---------- video list ----------

sub loadVideos()
    m.status.text = "Loading videos…"
    m.videosTask = CreateObject("roSGNode", "ApiTask")
    m.videosTask.baseUrl = m.baseUrl
    m.videosTask.mode = "videos"
    m.videosTask.token = m.token
    m.videosTask.observeField("status", "onVideosDone")
    m.videosTask.control = "RUN"
end sub

sub onVideosDone()
    code = m.videosTask.status
    result = m.videosTask.result

    if code = 401 then
        ' Token no longer valid (PIN was changed). Ask again.
        m.token = ""
        writeRegistry("token", "")
        askForPin("Enter the play.ezasapi PIN")
        return
    end if
    if code <> 200 or result = invalid or result.videos = invalid then
        m.status.text = "Couldn't load videos (HTTP " + code.toStr() + "). Press * to retry."
        return
    end if

    m.videos = result.videos
    m.videos.sortBy("uploaded", "r") ' newest first, same default as the web app

    content = CreateObject("roSGNode", "ContentNode")
    for each v in m.videos
        item = content.createChild("ContentNode")
        item.title = prettyName(v.name)
        item.hdPosterUrl = v.thumbUrl
        item.shortDescriptionLine1 = item.title
        item.shortDescriptionLine2 = formatSize(v.size) + "  ·  " + Left(v.uploaded, 10)
    end for

    m.grid.content = content
    m.grid.visible = true
    m.status.text = m.videos.count().toStr() + " videos"
    m.grid.setFocus(true)
end sub

' ---------- playback ----------

sub onItemSelected()
    playIndex(m.grid.itemSelected)
end sub

sub playIndex(index as integer)
    if index < 0 or index >= m.videos.count() then return
    m.currentIndex = index
    v = m.videos[index]

    content = CreateObject("roSGNode", "ContentNode")
    content.title = prettyName(v.name)
    content.url = v.streamUrl
    content.streamFormat = "mp4"

    m.player.content = content
    m.player.visible = true
    m.player.setFocus(true)
    m.player.control = "play"
end sub

sub onPlayerState()
    state = m.player.state
    if state = "finished" then
        ' Autoplay next, like the web player.
        if m.currentIndex + 1 < m.videos.count() then
            playIndex(m.currentIndex + 1)
        else
            stopPlayer()
        end if
    else if state = "error" then
        m.status.text = "Playback error: " + m.player.errorMsg
        stopPlayer()
    end if
end sub

sub stopPlayer()
    m.player.control = "stop"
    m.player.visible = false
    m.grid.setFocus(true)
end sub

function onKeyEvent(key as string, press as boolean) as boolean
    if not press then return false
    if m.player.visible then
        if key = "back" then
            stopPlayer()
            return true
        end if
    else if key = "options" and not m.grid.visible then
        loadVideos()
        return true
    end if
    return false
end function

' ---------- helpers ----------

function prettyName(name as string) as string
    noExt = CreateObject("roRegex", "\.[^.]+$", "").replaceAll(name, "")
    return CreateObject("roRegex", "[_-]+", "").replaceAll(noExt, " ")
end function

function formatSize(bytes as dynamic) as string
    if bytes >= 1073741824 then return oneDecimal(bytes / 1073741824) + " GB"
    if bytes >= 1048576 then return oneDecimal(bytes / 1048576) + " MB"
    if bytes >= 1024 then return Int(bytes / 1024).toStr() + " KB"
    return Int(bytes).toStr() + " B"
end function

function oneDecimal(value as dynamic) as string
    return Str(Int(value * 10) / 10).trim()
end function

function readRegistry(key as string) as string
    section = CreateObject("roRegistrySection", "playezasapi")
    if section.exists(key) then return section.read(key)
    return ""
end function

sub writeRegistry(key as string, value as string)
    section = CreateObject("roRegistrySection", "playezasapi")
    section.write(key, value)
    section.flush()
end sub
