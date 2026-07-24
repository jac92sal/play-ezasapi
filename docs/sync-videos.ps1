# =====================================================================
#  sync-videos.ps1 — one-way sync C:\Users\jacob\OneDrive\Videos -> R2
#
#  For every video file in the folder (and subfolders) it:
#    1. Computes the same content fingerprint play.ezasapi.com uses
#       (SHA-256 of first 4MB + last 4MB + file size)
#    2. Asks the site if it's a duplicate (by content OR by filename)
#    3. Uploads only the new ones with rclone (fast multipart, resumable)
#    4. Registers each uploaded file's fingerprint in the site's index
#
#  Requirements (one-time setup — see instructions in chat):
#    - rclone installed, with an "r2" remote configured for the bucket
# =====================================================================

# ===== CONFIG =====
$VideoFolder  = "C:\Users\jacob\OneDrive\Videos"
$SiteBase     = "https://play.ezasapi.com"
$Pin          = "4040"
$RcloneRemote = "r2"
$Bucket       = "entertainmentvideos"
$Extensions   = @(".mp4", ".m4v", ".webm", ".mov", ".mkv", ".avi", ".ogv")
# ==================

$ErrorActionPreference = "Stop"
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

# --- scan folder ---
$files = Get-ChildItem -Path $VideoFolder -Recurse -File |
    Where-Object { $Extensions -contains $_.Extension.ToLower() }
Write-Host ("Found {0} video file(s) in {1}" -f $files.Count, $VideoFolder)

$toUpload = @()       # objects: @{ File = <FileInfo>; Key = <relative key>; Fp = <hex> }
$skippedName = 0
$skippedContent = 0

foreach ($f in $files) {
    $key = $f.FullName.Substring($VideoFolder.Length).TrimStart("\") -replace "\\", "/"
    Write-Host ("  {0} ... " -f $key) -NoNewline
    $fp = Get-Fingerprint $f.FullName
    $check = Invoke-RestMethod -Uri "$SiteBase/api/upload/check" -Method Post -ContentType "application/json" `
        -Body (ConvertTo-Json @{ name = $key; fingerprint = $fp }) -WebSession $session
    if ($check.contentDuplicateOf) {
        Write-Host ("SKIP (same content already in bucket as '{0}')" -f $check.contentDuplicateOf)
        $skippedContent++
    } elseif ($check.nameExists) {
        Write-Host "SKIP (filename already in bucket)"
        $skippedName++
    } else {
        Write-Host "NEW"
        $toUpload += @{ File = $f; Key = $key; Fp = $fp }
    }
}

if ($toUpload.Count -eq 0) {
    Write-Host ("Nothing to upload. Skipped: {0} same-content, {1} same-name." -f $skippedContent, $skippedName)
    exit 0
}

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
$registered = 0
foreach ($u in $toUpload) {
    try {
        $r = Invoke-RestMethod -Uri "$SiteBase/api/upload/register" -Method Post -ContentType "application/json" `
            -Body (ConvertTo-Json @{ key = $u.Key; fingerprint = $u.Fp }) -WebSession $session
        if ($r.ok) { $registered++ }
    } catch {
        Write-Warning ("Could not register {0}: {1}" -f $u.Key, $_.Exception.Message)
    }
}

Remove-Item $listFile -ErrorAction SilentlyContinue
Write-Host "---------------------------------------------"
Write-Host ("Done. Uploaded + registered: {0}. Skipped: {1} same-content, {2} same-name." -f $registered, $skippedContent, $skippedName)
