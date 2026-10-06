sub init()
    ' The backend. Everything below talks to the play-ezasapi Cloudflare Worker.
    m.baseUrl = "https://play.ezasapi.com"
    m.pinLength = 4

    m.top.backgroundUri = ""
    m.top.backgroundColor = "0x0D0F14FF"

    m.grid = m.top.findNode("grid")
    m.player = m.top.findNode("player")
    m.status = m.top.findNode("status")
    m.nowPlaying = m.top.findNode("nowPlaying")
    m.npTitle = m.top.findNode("npTitle")
    m.npTimer = m.top.findNode("npTimer")
    m.npTimer.observeField("fire", "hideNowPlaying")
    m.errorStreak = 0
    m.skipped = 0
    m.allVideos = []    ' every video from the site, newest first
    m.videos = []       ' the ones shown in the grid (after the favorites filter)
    m.currentIndex = -1
    m.favFilter = readRegistry("favFilter")
    if m.favFilter = "" then m.favFilter = "all"
    m.needsRefilter = false
    m.favTasks = []
    m.dialog = invalid
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
    else if m.authTask.status = 200 then
        ' Login worked but no token came back: the site is still running the
        ' old worker that only sets a cookie. Deploy the latest worker.
        askForPin("play.ezasapi.com needs the latest worker deployed, then try again")
    else if m.authTask.status <= 0 then
        askForPin("Couldn't reach play.ezasapi.com. Check the Roku's internet connection")
    else
        askForPin("play.ezasapi.com returned HTTP " + m.authTask.status.toStr())
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

    m.allVideos = result.videos
    m.allVideos.sortBy("uploaded", "r") ' newest first, same default as the web app
    applyFilter("")
end sub

' ---------- favorites filter ----------

' Rebuilds the grid from m.allVideos for the current filter and keeps focus on
' the video with focusKey when it is still listed.
sub applyFilter(focusKey as string)
    m.needsRefilter = false
    m.videos = []
    for each v in m.allVideos
        if matchesFilter(v) then m.videos.push(v)
    end for

    content = CreateObject("roSGNode", "ContentNode")
    focusIndex = 0
    for i = 0 to m.videos.count() - 1
        v = m.videos[i]
        item = content.createChild("ContentNode")
        item.title = prettyName(v.name)
        item.hdPosterUrl = v.thumbUrl
        item.shortDescriptionLine1 = item.title
        item.shortDescriptionLine2 = caption2(v)
        if v.key = focusKey then focusIndex = i
    end for

    m.grid.content = content
    m.grid.visible = true
    if m.videos.count() > 0 then m.grid.jumpToItem = focusIndex
    updateStatus()
    m.grid.setFocus(true)
end sub

function matchesFilter(v as object) as boolean
    if m.favFilter = "all" then return true
    level = favOf(v)
    if m.favFilter = "any" then return level <> ""
    return level = m.favFilter
end function

function favOf(v as object) as string
    if v.fav = invalid then return ""
    return v.fav
end function

function favWord(level as string) as string
    if level = "gold" then return "Gold"
    if level = "silver" then return "Silver"
    if level = "bronze" then return "Bronze"
    return ""
end function

function filterLabel() as string
    if m.favFilter = "any" then return "all favorites"
    if m.favFilter = "all" then return "all videos"
    return favWord(m.favFilter) + " favorites"
end function

' Second caption line: the favorite level (if any), size and upload date.
function caption2(v as object) as string
    text = formatSize(v.size) + "  ·  " + Left(v.uploaded, 10)
    level = favOf(v)
    if level <> "" then text = UCase(level) + "  ·  " + text
    return text
end function

sub updateStatus()
    if m.videos.count() = 0 and m.favFilter <> "all" then
        m.status.text = "No " + filterLabel() + " yet.   *: menu"
    else
        m.status.text = m.videos.count().toStr() + " videos  ·  showing " + filterLabel() + "   *: menu"
    end if
end sub

' ---------- * menu, favorite chooser ----------

sub openMenu()
    m.menuActions = ["all", "any", "gold", "silver", "bronze", "setfav", "refresh"]
    labels = ["Show all videos", "Show all favorites", "Show Gold", "Show Silver", "Show Bronze", "Set favorite for this video", "Refresh list"]
    for i = 0 to 4
        if m.menuActions[i] = m.favFilter then labels[i] = labels[i] + "  (showing)"
    end for
    if m.videos.count() = 0 then
        ' Nothing focused to set a favorite on.
        m.menuActions.delete(5)
        labels.delete(5)
    end if
    showDialog("play.ezasapi", "Showing " + filterLabel(), labels, "onMenuChoice")
end sub

sub onMenuChoice(event as object)
    action = m.menuActions[event.getRoSGNode().buttonSelected]
    closeDialog()
    if action = "refresh" then
        loadVideos()
    else if action = "setfav" then
        index = m.grid.itemFocused
        if index >= 0 and index < m.videos.count() then openFavChooser(m.videos[index])
    else
        m.favFilter = action
        writeRegistry("favFilter", m.favFilter)
        focusKey = ""
        index = m.grid.itemFocused
        if index >= 0 and index < m.videos.count() then focusKey = m.videos[index].key
        applyFilter(focusKey)
    end if
end sub

sub openFavChooser(v as object)
    m.favTarget = v
    m.favChoices = ["gold", "silver", "bronze", ""]
    labels = ["Gold", "Silver", "Bronze", "Not a favorite"]
    current = favOf(v)
    for i = 0 to 3
        if m.favChoices[i] = current then labels[i] = labels[i] + "  (current)"
    end for
    showDialog("Favorite", prettyName(v.name), labels, "onFavChoice")
end sub

sub onFavChoice(event as object)
    level = m.favChoices[event.getRoSGNode().buttonSelected]
    v = m.favTarget
    closeDialog()
    if v <> invalid then setFav(v, level)
end sub

' Saves a favorite level ("" clears it). The grid updates at once and is put
' back if the site rejects the change.
sub setFav(v as object, level as string)
    previous = favOf(v)
    if previous = level then return
    applyFavLocally(v.key, level)

    task = CreateObject("roSGNode", "ApiTask")
    task.baseUrl = m.baseUrl
    task.mode = "fav"
    task.token = m.token
    task.videoKey = v.key
    task.fav = level
    task.addFields({ previousFav: previous })
    task.observeField("status", "onFavSaved")
    ' Keep a reference until it finishes; several saves can be in flight.
    m.favTasks.push(task)
    task.control = "RUN"
end sub

sub onFavSaved(event as object)
    task = event.getRoSGNode()
    for i = m.favTasks.count() - 1 to 0 step -1
        if m.favTasks[i].isSameNode(task) then m.favTasks.delete(i)
    end for
    if task.status = 200 then return
    applyFavLocally(task.videoKey, task.previousFav)
    if task.status = 401 then
        m.status.text = "Favorite not saved: sign in again (press * to refresh)"
    else
        m.status.text = "Favorite not saved (HTTP " + task.status.toStr() + ")"
    end if
end sub

sub applyFavLocally(key as string, level as string)
    for each v in m.allVideos
        if v.key = key then
            if level = "" then v.delete("fav") else v.fav = level
        end if
    end for
    ' Update captions in place; drop or add items only when the grid is in front,
    ' so a change during playback never shifts what Down/Up play next.
    for i = 0 to m.videos.count() - 1
        if m.videos[i].key = key then
            item = m.grid.content.getChild(i)
            if item <> invalid then item.shortDescriptionLine2 = caption2(m.videos[i])
        end if
    end for
    if m.favFilter <> "all" then
        if m.player.visible then
            m.needsRefilter = true
        else
            applyFilter(key)
        end if
    end if
    if m.player.visible then showNowPlaying("")
end sub

sub showDialog(title as string, message as string, buttons as object, handler as string)
    dialog = CreateObject("roSGNode", "Dialog")
    dialog.title = title
    dialog.message = message
    dialog.buttons = buttons
    dialog.observeField("buttonSelected", handler)
    dialog.observeField("wasClosed", "onDialogClosed")
    m.dialog = dialog
    m.top.dialog = dialog
end sub

' Closes the dialog a choice came from. Clears m.dialog right away rather than
' waiting for wasClosed, so the remote keeps working either way.
sub closeDialog()
    dialog = m.dialog
    m.dialog = invalid
    if dialog <> invalid then dialog.close = true
    restoreFocus()
end sub

sub restoreFocus()
    if m.player.visible then
        m.player.setFocus(true)
    else
        m.grid.setFocus(true)
    end if
end sub

' Back (or a choice) closed a dialog: give focus back to what is on screen.
' A dialog that closed after another one opened (menu -> chooser) is ignored.
sub onDialogClosed(event as object)
    closed = event.getRoSGNode()
    if m.dialog = invalid or not m.dialog.isSameNode(closed) then return
    m.dialog = invalid
    restoreFocus()
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

    ' Keep the grid on the video being watched, so Back lands on it.
    m.grid.jumpToItem = index
    showNowPlaying("")
end sub

' Next / previous, used by autoplay and by Down / Up on the remote.
sub playNext(manual as boolean)
    if m.currentIndex + 1 < m.videos.count() then
        playIndex(m.currentIndex + 1)
    else if manual then
        showNowPlaying("  (last video)")
    else
        stopPlayer()
    end if
end sub

sub playPrevious()
    if m.currentIndex > 0 then
        playIndex(m.currentIndex - 1)
    else
        showNowPlaying("  (first video)")
    end if
end sub

sub onPlayerState()
    state = m.player.state
    if state = "playing" then
        m.errorStreak = 0
    else if state = "finished" then
        ' Autoplay next, like the web player.
        playNext(false)
    else if state = "error" then
        ' Some uploads in the bucket are incomplete and cannot play. Skip them
        ' instead of dropping back to the grid, but give up after a long run
        ' of failures (e.g. the network is down) rather than looping forever.
        m.errorStreak = m.errorStreak + 1
        m.skipped = m.skipped + 1
        if m.errorStreak < 10 and m.currentIndex + 1 < m.videos.count() then
            m.status.text = "Skipped " + m.skipped.toStr() + " video(s) that could not play"
            playIndex(m.currentIndex + 1)
        else
            m.status.text = "Playback error: " + m.player.errorMsg
            stopPlayer()
        end if
    end if
end sub

sub showNowPlaying(suffix as string)
    if m.currentIndex < 0 or m.currentIndex >= m.videos.count() then return
    v = m.videos[m.currentIndex]
    position = (m.currentIndex + 1).toStr() + " of " + m.videos.count().toStr()
    level = favOf(v)
    medal = ""
    if level <> "" then medal = "   ·   " + favWord(level) + " favorite"
    m.npTitle.text = prettyName(v.name) + "   ·   " + position + medal + suffix
    m.nowPlaying.visible = true
    m.npTimer.control = "stop"
    m.npTimer.control = "start"
end sub

sub hideNowPlaying()
    m.nowPlaying.visible = false
end sub

sub stopPlayer()
    m.player.control = "stop"
    m.player.visible = false
    hideNowPlaying()
    if m.needsRefilter and m.currentIndex >= 0 and m.currentIndex < m.videos.count() then
        applyFilter(m.videos[m.currentIndex].key)
    else if m.needsRefilter then
        applyFilter("")
    end if
    m.grid.setFocus(true)
end sub

function onKeyEvent(key as string, press as boolean) as boolean
    if not press then return false
    ' Keys a dialog leaves unhandled must not open another one behind it.
    if m.dialog <> invalid then return false
    if m.player.visible then
        ' The Video node keeps Left/Right/OK/Play/Rewind/FastForward for
        ' seeking and pausing; Up/Down/* reach us here.
        if key = "back" then
            stopPlayer()
            return true
        else if key = "down" then
            playNext(true)
            return true
        else if key = "up" then
            playPrevious()
            return true
        else if key = "options" then
            ' *: choose a favorite level for the video that is playing.
            showNowPlaying("")
            if m.currentIndex >= 0 and m.currentIndex < m.videos.count() then
                openFavChooser(m.videos[m.currentIndex])
            end if
            return true
        end if
    else if key = "options" then
        if m.grid.visible then
            openMenu()
        else
            loadVideos()
        end if
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
