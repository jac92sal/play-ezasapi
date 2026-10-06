# =====================================================================
#  sync-videos.ps1 — one-way sync C:\Videos\play.ezasapi.source -> R2
#
#  First it has the site add any of its videos that are missing from its
#  content index, so a video is recognised by its content, not just its name.
#  Then, for every video file in the folder (and subfolders) it:
#    1. Computes the same content fingerprint play.ezasapi.com uses
#       (SHA-256 of first 4MB + last 4MB + file size)
#    2. Asks the site whether it already has that content (under any name)
#    3. Skips files whose video was DELETED on the site (they stay deleted)
#    4. Keeps names in step when a video was renamed on either side:
#         renamed on the site  -> the file here is renamed to match
#         renamed here         -> the video on the site is renamed to match
#       (it remembers each file's name from the last run in
#        %LOCALAPPDATA%\play-ezasapi\sync-state.json to tell which side
#        changed; on the first run the site's name wins)
#    5. Uploads only content the site has never had, with rclone
#    6. Registers each uploaded file's fingerprint in the site's index
#    7. Makes a JPEG thumbnail with ffmpeg for every video in the folder that
#       the site has no thumbnail for yet (new uploads and older ones), and
#       uploads it, so the web grid and the Roku channel show real posters
#
#  Requirements (one-time setup — see instructions in chat):
#    - rclone installed, with an "r2" remote configured for the bucket
#    - ffmpeg installed for step 5:  winget install Gyan.FFmpeg
#      (without it the sync still runs and just skips thumbnails)
#
#  Run it from the folder that holds this script (not from System32):
#    cd <your clone>\docs
#    $env:PLAY_PIN = "<the site PIN>"     # optional; it prompts if unset
#    .\sync-videos.ps1
# =====================================================================

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

# --- each file's name at the last sync (fingerprint -> key) ---
$StateFile = Join-Path $env:LOCALAPPDATA "play-ezasapi\sync-state.json"
$state = @{}
if (Test-Path $StateFile) {
    try {
        (Get-Content $StateFile -Raw | ConvertFrom-Json).PSObject.Properties |
            ForEach-Object { $state[$_.Name] = [string]$_.Value }
    } catch {
        Write-Warning "Could not read $StateFile; the site's names win this run."
    }
}
function Save-State {
    New-Item -ItemType Directory -Force -Path (Split-Path $StateFile) | Out-Null
    $state | ConvertTo-Json | Set-Content -Path $StateFile -Encoding UTF8
}

function Get-KeyFor([string]$FullName) {
    return $FullName.Substring($VideoFolder.Length).TrimStart("\") -replace "\\", "/"
}
function Get-PathFor([string]$Key) {
    return Join-Path $VideoFolder ($Key -replace "/", "\")
}

# --- scan folder ---
$files = Get-ChildItem -Path $VideoFolder -Recurse -File |
    Where-Object { $Extensions -contains $_.Extension.ToLower() }
Write-Host ("Found {0} video file(s) in {1}" -f $files.Count, $VideoFolder)

$toUpload = @()       # objects: @{ File = <FileInfo>; Key = <relative key>; Fp = <hex> }
$local = @()          # @{ Path; Key } for each file here that is on the site (for thumbnails)
$skippedName = 0
$skippedContent = 0
$skippedDeleted = 0
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
        Write-Host "SKIP (deleted on the site; delete it here too, or upload it on the website to bring it back)"
        $skippedDeleted++
        $state.Remove($fp)
    } elseif (-not $siteKey) {
        if ($check.nameExists) {
            Write-Host "SKIP (a different video already has this name on the site)"
            $skippedName++
        } else {
            Write-Host "NEW"
            $toUpload += @{ File = $f; Key = $key; Fp = $fp }
            $local += @{ Path = $f.FullName; Key = $key }
        }
    } elseif ($siteKey -eq $key) {
        Write-Host "on the site"
        $state[$fp] = $key
        $local += @{ Path = $f.FullName; Key = $key }
    } elseif (Test-Path -LiteralPath (Get-PathFor $siteKey)) {
        Write-Host ("SKIP (same video as '{0}', which is also in this folder)" -f $siteKey)
        $skippedContent++
    } elseif ($state[$fp] -eq $siteKey) {
        # Same name on both sides last time, so it was renamed here: rename it on the site.
        try {
            $null = Invoke-RestMethod -Uri "$SiteBase/api/videos/rename" -Method Post -ContentType "application/json" `
                -Body (ConvertTo-Json @{ key = $siteKey; newKey = $key }) -WebSession $session -TimeoutSec 3600
            Write-Host ("RENAMED on the site (was '{0}')" -f $siteKey)
            $state[$fp] = $key
            $renamedOnSite++
            $local += @{ Path = $f.FullName; Key = $key }
        } catch {
            Write-Host ("could not rename '{0}' on the site: {1}" -f $siteKey, $_.Exception.Message)
            $local += @{ Path = $f.FullName; Key = $siteKey }
        }
    } else {
        # Renamed on the site (or first run): give the file here the site's name.
        $target = Get-PathFor $siteKey
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

$registered = 0
if ($toUpload.Count -eq 0) {
    Write-Host ("Nothing to upload. Skipped: {0} same-content, {1} same-name." -f $skippedContent, $skippedName)
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

# --- thumbnails: one JPEG per video the site has none for ---
# Encodes each path segment so keys with spaces or other characters work in the URL.
function ConvertTo-KeyPath([string]$Key) {
    return (($Key -split "/") | ForEach-Object { [uri]::EscapeDataString($_) }) -join "/"
}

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
if (-not (Get-Command ffmpeg -ErrorAction SilentlyContinue)) {
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
Write-Host ("Done. Uploaded + registered: {0}. Renamed here: {1}, on the site: {2}. Skipped: {3} deleted on the site, {4} same-content, {5} same-name. Thumbnails made: {6}, failed: {7}." -f `
    $registered, $renamedHere, $renamedOnSite, $skippedDeleted, $skippedContent, $skippedName, $thumbsMade, $thumbsFailed)
