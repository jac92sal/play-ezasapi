# =====================================================================
#  sync-videos.ps1 — two-way sync between C:\Videos\play.ezasapi.source
#  and the play.ezasapi.com library (R2 bucket "entertainmentvideos")
#
#  First it has the site add any of its videos that are missing from its
#  content index, so a video is recognised by its content, not just its name.
#  Videos are matched by content fingerprint (SHA-256 of first 4MB + last 4MB
#  + file size, the same one the site uses), so a rename is never mistaken
#  for a delete plus an add.
#
#    Added on the PC      -> uploaded to the site (rclone)
#    Added on the site    -> downloaded into the folder (rclone)
#    Renamed on either    -> renamed on the other side to match
#    Deleted on the site  -> the file here goes to the Recycle Bin
#    Deleted on the PC    -> deleted on the site (it stays deleted there)
#  It also makes a JPEG thumbnail with ffmpeg for every video the site has no
#  thumbnail for yet, so the web grid and the Roku channel show real posters.
#
#  To tell "deleted here" from "added on the site", it remembers which videos
#  were on both sides after the last run, in
#  %LOCALAPPDATA%\play-ezasapi\sync-state.json. Safety rules:
#    - The first run of this two-way version deletes nothing on the site; it
#      only records what is on both sides (and downloads what is missing here).
#    - If more than $MaxSiteDeletes videos would be deleted on the site in one
#      run, none are; run again with -Yes to confirm. Those videos are also not
#      downloaded again in the meantime.
#    - If the folder has no videos at all (drive not connected?) it stops.
#    - Files deleted here because of the site go to the Recycle Bin.
#  To bring back a video deleted on the site, upload it again on the website
#  (a copy dropped into this folder would just be deleted again).
#  Use -DryRun to see what it would do without changing anything.
#
#  Requirements (one-time setup — see instructions in chat):
#    - rclone installed, with an "r2" remote configured for the bucket
#    - ffmpeg installed for thumbnails:  winget install Gyan.FFmpeg
#      (without it the sync still runs and just skips thumbnails)
#
#  Run it from the folder that holds this script (not from System32):
#    cd <your clone>\docs
#    $env:PLAY_PIN = "<the site PIN>"     # optional; it prompts if unset
#    .\sync-videos.ps1                    # normal run
#    .\sync-videos.ps1 -DryRun            # only show what would change
#    .\sync-videos.ps1 -Yes               # allow a large batch of site deletes
# =====================================================================
param(
    [switch]$DryRun,
    [switch]$Yes
)

# ===== CONFIG =====
# The folder you drop videos into. Override per shell with $env:PLAY_VIDEO_FOLDER.
$VideoFolder  = if ($env:PLAY_VIDEO_FOLDER) { $env:PLAY_VIDEO_FOLDER } else { "C:\Videos\play.ezasapi.source" }
$SiteBase     = "https://play.ezasapi.com"
# PIN is never stored here. Set it once per shell:  $env:PLAY_PIN = "...."
# or leave it unset and the script prompts for it.
$Pin          = $env:PLAY_PIN
$RcloneRemote = "r2"
$Bucket       = "entertainmentvideos"
$Extensions   = @(".mp4", ".m4v", ".webm", ".mov", ".mkv", ".avi", ".ogv")
# More site deletions than this in one run need -Yes.
$MaxSiteDeletes = 10
# ==================

$ErrorActionPreference = "Stop"
if ([string]::IsNullOrWhiteSpace($Pin)) {
    $secure = Read-Host -Prompt "play.ezasapi PIN" -AsSecureString
    $Pin = [Runtime.InteropServices.Marshal]::PtrToStringAuto(
        [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure))
}
$FpChunk = 4MB

function Get-Fingerprint([string]$Path) {
    $sha = [System.Security.Cryptography.SHA256]::Create()
    $fs = [System.IO.File]::OpenRead($Path)
    try {
        $size = $fs.Length
        if ($size -le (2 * $FpChunk)) {
            $buf = New-Object byte[] $size
            $read = 0
            while ($read -lt $size) { $read += $fs.Read($buf, $read, $size - $read) }
            [void]$sha.TransformBlock($buf, 0, $size, $null, 0)
        } else {
            $buf = New-Object byte[] $FpChunk
            $read = 0
            while ($read -lt $FpChunk) { $read += $fs.Read($buf, $read, $FpChunk - $read) }
            [void]$sha.TransformBlock($buf, 0, $FpChunk, $null, 0)
            [void]$fs.Seek($size - $FpChunk, [System.IO.SeekOrigin]::Begin)
            $read = 0
            while ($read -lt $FpChunk) { $read += $fs.Read($buf, $read, $FpChunk - $read) }
            [void]$sha.TransformBlock($buf, 0, $FpChunk, $null, 0)
        }
        $sizeBytes = [System.Text.Encoding]::UTF8.GetBytes([string]$size)
        [void]$sha.TransformFinalBlock($sizeBytes, 0, $sizeBytes.Length)
        return ([System.BitConverter]::ToString($sha.Hash) -replace "-", "").ToLower()
    } finally {
        $fs.Dispose()
        $sha.Dispose()
    }
}

# --- sanity checks ---
if (-not (Test-Path $VideoFolder)) { throw "Folder not found: $VideoFolder" }
$rclone = Get-Command rclone -ErrorAction SilentlyContinue
if (-not $rclone) { throw "rclone not found. Install it first: winget install Rclone.Rclone" }

# --- log in to the site ---
Write-Host "Signing in to $SiteBase ..."
$session = New-Object Microsoft.PowerShell.Commands.WebRequestSession
$auth = Invoke-RestMethod -Uri "$SiteBase/api/auth" -Method Post -ContentType "application/json" `
    -Body (ConvertTo-Json @{ pin = $Pin }) -WebSession $session
if (-not $auth.ok) { throw "PIN rejected" }
# Send the token as a header too, so every call is signed in even if the cookie isn't kept.
if ($auth.token) { $session.Headers["Authorization"] = "Bearer " + $auth.token }

# --- make sure every video on the site is in its content index ---
# Videos uploaded before the index existed (or straight to the bucket) are
# fingerprinted on the site, a few per request. Later runs finish at once.
Write-Host "Checking the site's content index (the first run on a big library takes a few minutes) ..."
$after = $null
$siteDuplicates = @()
do {
    $uri = "$SiteBase/api/index/backfill?limit=10"
    if ($after) { $uri += "&after=" + [uri]::EscapeDataString($after) }
    $r = Invoke-RestMethod -Uri $uri -Method Post -WebSession $session -TimeoutSec 600
    if ($r.added -gt 0) { Write-Host ("  indexed {0} more video(s)" -f $r.added) }
    $siteDuplicates += @($r.duplicates)
    $after = $r.next
} while ($after)
if ($siteDuplicates.Count -gt 0) {
    Write-Host ("  {0} video(s) on the site are exact copies of another one; delete the copy you don't want on the site:" -f $siteDuplicates.Count)
    foreach ($d in $siteDuplicates) { Write-Host ("    '{0}'  is a copy of  '{1}'" -f $d.key, $d.duplicateOf) }
}

# --- videos on both sides at the last sync (fingerprint -> key) ---
# "_twoWay" marks a state file written by this two-way version. Without it
# (first run after updating) nothing is deleted on the site.
$StateFile = Join-Path $env:LOCALAPPDATA "play-ezasapi\sync-state.json"
$state = @{}
$twoWay = $false
if (Test-Path $StateFile) {
    try {
        (Get-Content $StateFile -Raw | ConvertFrom-Json).PSObject.Properties | ForEach-Object {
            if ($_.Name -eq "_twoWay") { $twoWay = $true } else { $state[$_.Name] = [string]$_.Value }
        }
    } catch {
        Write-Warning "Could not read $StateFile; the site's names win and nothing is deleted on the site this run."
    }
}
function Save-State {
    if ($DryRun) { return }
    $out = @{ "_twoWay" = "1" }
    foreach ($k in $state.Keys) { $out[$k] = $state[$k] }
    New-Item -ItemType Directory -Force -Path (Split-Path $StateFile) | Out-Null
    $out | ConvertTo-Json | Set-Content -Path $StateFile -Encoding UTF8
}

function Get-KeyFor([string]$FullName) {
    return $FullName.Substring($VideoFolder.Length).TrimStart("\") -replace "\\", "/"
}
function Get-PathFor([string]$Key) {
    return Join-Path $VideoFolder ($Key -replace "/", "\")
}
# Encodes each path segment so keys with spaces or other characters work in the URL.
function ConvertTo-KeyPath([string]$Key) {
    return (($Key -split "/") | ForEach-Object { [uri]::EscapeDataString($_) }) -join "/"
}
# Characters Windows does not allow in file names; such site videos are not downloaded.
function Test-WindowsSafeKey([string]$Key) {
    return -not ($Key -match '[<>:"|?*\\]' -or ($Key -split "/" | Where-Object { $_ -match '[ .]$' }))
}
# Deletes a file here by sending it to the Recycle Bin, so it can be restored.
function Remove-ToRecycleBin([string]$Path) {
    if ($PSVersionTable.PSEdition -eq "Desktop" -or $IsWindows) {
        Add-Type -AssemblyName Microsoft.VisualBasic
        [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile($Path,
            [Microsoft.VisualBasic.FileIO.UIOption]::OnlyErrorDialogs,
            [Microsoft.VisualBasic.FileIO.RecycleOption]::SendToRecycleBin)
    } else {
        Remove-Item -LiteralPath $Path
    }
}
if ($DryRun) { Write-Host "DRY RUN: nothing will be changed on the site or in the folder." }

# --- scan folder ---
$files = @(Get-ChildItem -Path $VideoFolder -Recurse -File |
    Where-Object { $Extensions -contains $_.Extension.ToLower() })
Write-Host ("Found {0} video file(s) in {1}" -f $files.Count, $VideoFolder)
if ($files.Count -eq 0 -and $state.Count -gt 0) {
    throw "No videos in $VideoFolder, but the last sync had $($state.Count). Is the drive connected? Stopping so nothing is deleted on the site."
}

$toUpload = @()       # objects: @{ File = <FileInfo>; Key = <relative key>; Fp = <hex> }
$local = @()          # @{ Path; Key } for each file here that is on the site (for thumbnails)
$localFps = @{}       # fingerprint of every video still in the folder
$siteKeysHere = @{}   # site keys that have a file here (so they are not downloaded)
$skippedName = 0
$skippedContent = 0
$deletedHere = 0
$renamedHere = 0
$renamedOnSite = 0

foreach ($f in $files) {
    $key = Get-KeyFor $f.FullName
    Write-Host ("  {0} ... " -f $key) -NoNewline
    $fp = Get-Fingerprint $f.FullName
    $check = Invoke-RestMethod -Uri "$SiteBase/api/upload/check" -Method Post -ContentType "application/json" `
        -Body (ConvertTo-Json @{ name = $key; fingerprint = $fp }) -WebSession $session
    $siteKey = $check.contentDuplicateOf
    if ($null -ne $check.deletedOnSite) {
        # Deleted on the site: delete it here too (to the Recycle Bin).
        $state.Remove($fp)
        if ($DryRun) {
            Write-Host "deleted on the site; would move it to the Recycle Bin"
            $deletedHere++
            continue
        }
        try {
            Remove-ToRecycleBin $f.FullName
            Write-Host "DELETED here (deleted on the site; it is in the Recycle Bin)"
            $deletedHere++
        } catch {
            Write-Host ("deleted on the site, but could not delete it here: {0}" -f $_.Exception.Message)
            $localFps[$fp] = $true
        }
        continue
    }
    $localFps[$fp] = $true
    if (-not $siteKey) {
        if ($check.nameExists) {
            Write-Host "SKIP (a different video already has this name on the site)"
            $skippedName++
        } else {
            Write-Host "NEW"
            $toUpload += @{ File = $f; Key = $key; Fp = $fp }
            $local += @{ Path = $f.FullName; Key = $key }
            $siteKeysHere[$key] = $true
        }
    } elseif ($siteKey -eq $key) {
        Write-Host "on the site"
        $state[$fp] = $key
        $local += @{ Path = $f.FullName; Key = $key }
        $siteKeysHere[$key] = $true
    } elseif (Test-Path -LiteralPath (Get-PathFor $siteKey)) {
        Write-Host ("SKIP (same video as '{0}', which is also in this folder)" -f $siteKey)
        $skippedContent++
        $siteKeysHere[$siteKey] = $true
    } elseif ($state[$fp] -eq $siteKey) {
        # Same name on both sides last time, so it was renamed here: rename it on the site.
        if ($DryRun) {
            Write-Host ("renamed here; would rename '{0}' on the site to match" -f $siteKey)
            $renamedOnSite++
            $siteKeysHere[$siteKey] = $true
            continue
        }
        try {
            $null = Invoke-RestMethod -Uri "$SiteBase/api/videos/rename" -Method Post -ContentType "application/json" `
                -Body (ConvertTo-Json @{ key = $siteKey; newKey = $key }) -WebSession $session -TimeoutSec 3600
            Write-Host ("RENAMED on the site (was '{0}')" -f $siteKey)
            $state[$fp] = $key
            $renamedOnSite++
            $local += @{ Path = $f.FullName; Key = $key }
            $siteKeysHere[$key] = $true
        } catch {
            Write-Host ("could not rename '{0}' on the site: {1}" -f $siteKey, $_.Exception.Message)
            $local += @{ Path = $f.FullName; Key = $siteKey }
            $siteKeysHere[$siteKey] = $true
        }
    } else {
        # Renamed on the site (or first run): give the file here the site's name.
        $siteKeysHere[$siteKey] = $true
        $target = Get-PathFor $siteKey
        if ($DryRun) {
            Write-Host ("would rename it here to '{0}' (its name on the site)" -f $siteKey)
            $renamedHere++
            continue
        }
        try {
            New-Item -ItemType Directory -Force -Path (Split-Path $target) | Out-Null
            Move-Item -LiteralPath $f.FullName -Destination $target
            Write-Host ("RENAMED here to '{0}' (its name on the site)" -f $siteKey)
            $state[$fp] = $siteKey
            $renamedHere++
            $local += @{ Path = $target; Key = $siteKey }
        } catch {
            Write-Host ("on the site as '{0}' (could not rename here: {1})" -f $siteKey, $_.Exception.Message)
            $local += @{ Path = $f.FullName; Key = $siteKey }
        }
    }
}
Save-State

# --- deleted here since the last sync: delete on the site ---
# A video that was on both sides last time and whose content is no longer
# anywhere in the folder was deleted here.
$deleteOnSite = @()   # @{ Fp; Key }
$keepOffPc = @{}      # site keys deleted here; never downloaded back
foreach ($fp in @($state.Keys)) {
    if ($localFps.ContainsKey($fp)) { continue }
    $check = Invoke-RestMethod -Uri "$SiteBase/api/upload/check" -Method Post -ContentType "application/json" `
        -Body (ConvertTo-Json @{ name = $state[$fp]; fingerprint = $fp }) -WebSession $session
    $siteKey = $check.contentDuplicateOf
    if ($null -ne $check.deletedOnSite -or -not $siteKey) {
        $state.Remove($fp)     # gone from the site as well
        continue
    }
    if (Test-Path -LiteralPath (Get-PathFor $siteKey)) {
        # A file with that name is still here (e.g. re-encoded); leave the site alone.
        $state.Remove($fp)
        continue
    }
    $deleteOnSite += @{ Fp = $fp; Key = $siteKey }
    $keepOffPc[$siteKey] = $true
}

$deletedOnSite = 0
$heldBack = 0
if ($deleteOnSite.Count -gt 0) {
    if (-not $twoWay) {
        Write-Host ("First two-way run: {0} video(s) on the site are missing here. Nothing is deleted on the site this time; they are downloaded back instead." -f $deleteOnSite.Count)
        foreach ($d in $deleteOnSite) { $keepOffPc.Remove($d.Key); $state.Remove($d.Fp) }
        $deleteOnSite = @()
    } elseif ($deleteOnSite.Count -gt $MaxSiteDeletes -and -not $Yes) {
        $heldBack = $deleteOnSite.Count
        Write-Warning ("{0} videos were deleted here since the last sync. That is more than {1}, so none were deleted on the site." -f $heldBack, $MaxSiteDeletes)
        Write-Warning "If that is what you want, run again with -Yes. Until then they are not downloaded back:"
        foreach ($d in $deleteOnSite) { Write-Host ("    {0}" -f $d.Key) }
        $deleteOnSite = @()
    }
}
foreach ($d in $deleteOnSite) {
    Write-Host ("  {0} ... " -f $d.Key) -NoNewline
    if ($DryRun) {
        Write-Host "deleted here; would delete it on the site"
        $deletedOnSite++
        continue
    }
    try {
        $null = Invoke-RestMethod -Uri ("$SiteBase/api/videos/" + (ConvertTo-KeyPath $d.Key)) -Method Delete -WebSession $session
        Write-Host "DELETED on the site (deleted here)"
        $state.Remove($d.Fp)
        $deletedOnSite++
    } catch {
        Write-Host ("could not delete it on the site: {0}" -f $_.Exception.Message)
    }
}
Save-State

$registered = 0
if ($toUpload.Count -eq 0) {
    Write-Host "Nothing to upload."
} elseif ($DryRun) {
    Write-Host ("Would upload {0} file(s)." -f $toUpload.Count)
} else {

# --- upload with rclone ---
$listFile = Join-Path $env:TEMP "r2-sync-files.txt"
$toUpload | ForEach-Object { $_.Key } | Set-Content -Path $listFile -Encoding UTF8
Write-Host ("Uploading {0} file(s) with rclone ..." -f $toUpload.Count)

& rclone copy $VideoFolder ("{0}:{1}" -f $RcloneRemote, $Bucket) `
    --files-from $listFile `
    --transfers 4 --s3-upload-concurrency 8 --s3-chunk-size 64M `
    --retries 5 --progress
if ($LASTEXITCODE -ne 0) { throw "rclone exited with code $LASTEXITCODE" }

# --- register fingerprints so future syncs & web uploads see these files ---
Write-Host "Registering fingerprints ..."
foreach ($u in $toUpload) {
    try {
        $r = Invoke-RestMethod -Uri "$SiteBase/api/upload/register" -Method Post -ContentType "application/json" `
            -Body (ConvertTo-Json @{ key = $u.Key; fingerprint = $u.Fp }) -WebSession $session
        if ($r.ok) { $registered++; $state[$u.Fp] = $u.Key }
    } catch {
        Write-Warning ("Could not register {0}: {1}" -f $u.Key, $_.Exception.Message)
    }
}

Remove-Item $listFile -ErrorAction SilentlyContinue
Save-State
}

# --- added on the site: download into the folder ---
$listing = Invoke-RestMethod -Uri "$SiteBase/api/videos" -WebSession $session
$toDownload = @()
$skippedDownload = 0
foreach ($v in $listing.videos) {
    if ($siteKeysHere.ContainsKey($v.key) -or $keepOffPc.ContainsKey($v.key)) { continue }
    if (-not (Test-WindowsSafeKey $v.key)) {
        Write-Host ("  SKIP download '{0}' (its name is not allowed on Windows; rename it on the site)" -f $v.key)
        $skippedDownload++
    } elseif (Test-Path -LiteralPath (Get-PathFor $v.key)) {
        Write-Host ("  SKIP download '{0}' (a different file with that name is already here)" -f $v.key)
        $skippedDownload++
    } else {
        $toDownload += $v
    }
}
$downloaded = 0
if ($toDownload.Count -eq 0) {
    Write-Host "Nothing to download."
} else {
    $gb = ($toDownload | Measure-Object -Property size -Sum).Sum / 1GB
    if ($DryRun) {
        Write-Host ("Would download {0} video(s) added on the site ({1:N1} GB):" -f $toDownload.Count, $gb)
        foreach ($v in $toDownload) { Write-Host ("    {0}" -f $v.key) }
    } else {
        $listFile = Join-Path $env:TEMP "r2-sync-downloads.txt"
        $toDownload | ForEach-Object { $_.key } | Set-Content -Path $listFile -Encoding UTF8
        Write-Host ("Downloading {0} video(s) added on the site ({1:N1} GB) with rclone ..." -f $toDownload.Count, $gb)
        & rclone copy ("{0}:{1}" -f $RcloneRemote, $Bucket) $VideoFolder `
            --files-from $listFile `
            --transfers 4 --multi-thread-streams 4 `
            --retries 5 --progress
        $rcloneExit = $LASTEXITCODE
        Remove-Item $listFile -ErrorAction SilentlyContinue
        # Record whatever arrived, even if rclone failed part-way.
        foreach ($v in $toDownload) {
            $path = Get-PathFor $v.key
            if (-not (Test-Path -LiteralPath $path)) { continue }
            $state[(Get-Fingerprint $path)] = $v.key
            $local += @{ Path = $path; Key = $v.key }
            $downloaded++
        }
        Save-State
        if ($rcloneExit -ne 0) { Write-Warning "rclone exited with code $rcloneExit; $downloaded of $($toDownload.Count) downloaded. The rest are tried again next run." }
    }
}

# --- thumbnails: one JPEG per video the site has none for ---
# Writes one representative frame (the "thumbnail" filter skips black and
# near-identical frames) scaled to at most 640 px wide. Tries 5 s in first,
# then the very start for clips shorter than that.
function New-Thumbnail([string]$VideoPath, [string]$OutPath) {
    foreach ($seek in @("5", "0")) {
        Remove-Item $OutPath -ErrorAction SilentlyContinue
        & ffmpeg -hide_banner -loglevel error -y -ss $seek -i $VideoPath `
            -vf "thumbnail=60,scale='min(640,iw)':-2" -frames:v 1 -q:v 4 $OutPath 2>$null
        if ((Test-Path $OutPath) -and (Get-Item $OutPath).Length -gt 0) { return $true }
    }
    return $false
}

$thumbsMade = 0
$thumbsFailed = 0
if ($DryRun) {
    # Nothing to do: thumbnails are only made for videos already on the site.
} elseif (-not (Get-Command ffmpeg -ErrorAction SilentlyContinue)) {
    Write-Warning "ffmpeg not found, so no thumbnails were made. Install it with: winget install Gyan.FFmpeg"
} else {
    Write-Host "Checking which videos still need a thumbnail ..."
    $listing = Invoke-RestMethod -Uri "$SiteBase/api/videos" -WebSession $session
    $needThumb = @{}
    foreach ($v in $listing.videos) { if (-not $v.hasThumb) { $needThumb[$v.key] = $true } }

    $thumbFile = Join-Path $env:TEMP "play-ezasapi-thumb.jpg"
    foreach ($l in $local) {
        $key = $l.Key
        if (-not $needThumb.ContainsKey($key)) { continue }
        Write-Host ("  thumbnail: {0} ... " -f $key) -NoNewline
        if (-not (New-Thumbnail $l.Path $thumbFile)) {
            Write-Host "FAILED (ffmpeg could not read a frame)"
            $thumbsFailed++
            continue
        }
        try {
            $r = Invoke-RestMethod -Uri ("$SiteBase/api/thumb/" + (ConvertTo-KeyPath $key)) -Method Put `
                -ContentType "image/jpeg" -InFile $thumbFile -WebSession $session
            if ($r.stored) { Write-Host "OK"; $thumbsMade++ } else { Write-Host ("kept existing ({0})" -f $r.reason) }
        } catch {
            Write-Host ("FAILED ({0})" -f $_.Exception.Message)
            $thumbsFailed++
        }
    }
    Remove-Item $thumbFile -ErrorAction SilentlyContinue
}

Write-Host "---------------------------------------------"
$prefix = if ($DryRun) { "Dry run (nothing changed). Would have:" } else { "Done." }
Write-Host ("{0} Uploaded: {1}. Downloaded: {2}. Renamed here: {3}, on the site: {4}. Deleted here: {5}, on the site: {6}{7}. Skipped: {8} same-content, {9} same-name, {10} downloads. Thumbnails made: {11}, failed: {12}." -f `
    $prefix, $(if ($DryRun) { $toUpload.Count } else { $registered }), $(if ($DryRun) { $toDownload.Count } else { $downloaded }),
    $renamedHere, $renamedOnSite, $deletedHere, $deletedOnSite,
    $(if ($heldBack) { " ($heldBack held back; run with -Yes)" } else { "" }),
    $skippedContent, $skippedName, $skippedDownload, $thumbsMade, $thumbsFailed)
