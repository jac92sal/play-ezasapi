# =====================================================================
#  sync-videos.ps1 — one-way sync of a local video folder -> R2
#
#  This runs on YOUR Windows machine and PUSHES to Cloudflare. Cloudflare
#  cannot reach into a folder on your PC, so there is no such thing as a
#  Worker cron that "pulls" these videos. Daily automation = Windows Task
#  Scheduler running this script (see install-daily-sync.ps1).
#
#  For every video file in the folder (and subfolders) it:
#    1. Computes the same content fingerprint play.ezasapi.com uses
#       (SHA-256 of first 4MB + last 4MB + file size)
#    2. Asks the site if it's a duplicate (by content OR by filename)
#    3. Uploads only the new ones with rclone (fast multipart, resumable)
#    4. Registers each uploaded file's fingerprint in the site's index,
#       and backfills fingerprints for files already in the bucket that
#       were never indexed
#    5. Reports a heartbeat to /api/sync/heartbeat so the site can show
#       when the sync last ran
#
#  Requirements (one-time):
#    - rclone installed, with an "r2" remote configured for the bucket
#    - the site PIN, supplied via -Pin or the PLAY_PIN environment variable
#
#  Usage:
#    .\sync-videos.ps1                      # uses $env:PLAY_PIN
#    .\sync-videos.ps1 -Pin 1234            # explicit PIN
#    .\sync-videos.ps1 -DryRun              # scan + report, upload nothing
#    .\sync-videos.ps1 -VideoFolder D:\Vids # different source folder
# =====================================================================

[CmdletBinding()]
param(
    # Source folder on this machine. Default is the OneDrive Videos folder.
    [string]$VideoFolder = $(if ($env:PLAY_VIDEO_FOLDER) { $env:PLAY_VIDEO_FOLDER }
                            elseif ($env:OneDrive) { Join-Path $env:OneDrive "Videos" }
                            else { Join-Path $env:USERPROFILE "OneDrive\Videos" }),

    # Site PIN. Never hard-code this — pass it in or set PLAY_PIN.
    [string]$Pin = $env:PLAY_PIN,

    [string]$SiteBase     = $(if ($env:PLAY_SITE_BASE) { $env:PLAY_SITE_BASE } else { "https://play.ezasapi.com" }),
    [string]$RcloneRemote = "r2",
    [string]$Bucket       = "entertainmentvideos",

    # Where to append a run log. Set to "" to disable file logging.
    [string]$LogFile = $(Join-Path $env:LOCALAPPDATA "play-ezasapi\sync-videos.log"),

    # Scan and report what would happen, but upload/register nothing.
    [switch]$DryRun
)

$ErrorActionPreference = "Stop"
$Extensions = @(".mp4", ".m4v", ".webm", ".mov", ".mkv", ".avi", ".ogv")
$FpChunk    = 4MB

# ---------------------------------------------------------------------
# Logging — every line goes to the console and (optionally) to $LogFile,
# so a scheduled run that nobody watched still leaves a trace.
# ---------------------------------------------------------------------
if ($LogFile) {
    $logDir = Split-Path -Parent $LogFile
    if ($logDir -and -not (Test-Path $logDir)) {
        New-Item -ItemType Directory -Path $logDir -Force | Out-Null
    }
}

function Write-Log {
    param([string]$Message, [string]$Level = "INFO")
    $line = "{0} [{1}] {2}" -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss"), $Level, $Message
    if ($Level -eq "WARN") { Write-Warning $Message }
    elseif ($Level -eq "ERROR") { Write-Host $line -ForegroundColor Red }
    else { Write-Host $line }
    if ($LogFile) { Add-Content -Path $LogFile -Value $line -Encoding UTF8 }
}

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

# Run counters — also the body of the heartbeat.
$scanned        = 0
$uploaded       = 0
$skippedName    = 0
$skippedContent = 0
$backfilled     = 0
$session        = $null
$fatal          = $null
$source         = "{0}:{1}" -f $env:COMPUTERNAME, $VideoFolder

function Send-Heartbeat {
    param([bool]$Ok, [string]$ErrorText)
    if (-not $session) { return }   # never signed in; nothing to report to
    if ($DryRun) { Write-Log "Dry run — heartbeat not sent."; return }
    $payload = @{
        ok             = $Ok
        scanned        = $scanned
        uploaded       = $uploaded
        skippedContent = $skippedContent
        skippedName    = $skippedName
        source         = $source
    }
    if ($ErrorText) { $payload.error = $ErrorText }
    try {
        Invoke-RestMethod -Uri "$SiteBase/api/sync/heartbeat" -Method Post `
            -ContentType "application/json" -Body (ConvertTo-Json $payload) `
            -WebSession $session | Out-Null
        Write-Log "Heartbeat sent (ok=$Ok)."
    } catch {
        Write-Log ("Could not send heartbeat: {0}" -f $_.Exception.Message) "WARN"
    }
}

try {
    Write-Log "=== sync-videos starting ==="
    Write-Log "Source: $VideoFolder"
    Write-Log "Target: $SiteBase (bucket $Bucket via rclone remote '$RcloneRemote')"
    if ($DryRun) { Write-Log "DRY RUN — nothing will be uploaded." }

    # --- sanity checks ---
    if (-not $Pin) {
        throw "No PIN supplied. Pass -Pin <pin> or set the PLAY_PIN environment variable."
    }
    if (-not (Test-Path $VideoFolder)) { throw "Folder not found: $VideoFolder" }
    if (-not (Get-Command rclone -ErrorAction SilentlyContinue)) {
        throw "rclone not found. Install it first: winget install Rclone.Rclone"
    }

    # --- log in to the site ---
    Write-Log "Signing in to $SiteBase ..."
    $session = New-Object Microsoft.PowerShell.Commands.WebRequestSession
    $auth = Invoke-RestMethod -Uri "$SiteBase/api/auth" -Method Post -ContentType "application/json" `
        -Body (ConvertTo-Json @{ pin = $Pin }) -WebSession $session
    if (-not $auth.ok) { throw "PIN rejected" }

    # --- scan folder ---
    $files = Get-ChildItem -Path $VideoFolder -Recurse -File |
        Where-Object { $Extensions -contains $_.Extension.ToLower() }
    $scanned = @($files).Count
    Write-Log ("Found {0} video file(s)." -f $scanned)

    $toUpload   = @()   # @{ File; Key; Fp }
    $toBackfill = @()   # @{ Key; Fp } — already in bucket, fingerprint missing

    foreach ($f in $files) {
        $key = $f.FullName.Substring($VideoFolder.Length).TrimStart("\") -replace "\\", "/"
        $fp = Get-Fingerprint $f.FullName
        $check = Invoke-RestMethod -Uri "$SiteBase/api/upload/check" -Method Post `
            -ContentType "application/json" `
            -Body (ConvertTo-Json @{ name = $key; fingerprint = $fp }) -WebSession $session

        if ($check.contentDuplicateOf) {
            Write-Log ("  SKIP  {0} (same content already in bucket as '{1}')" -f $key, $check.contentDuplicateOf)
            $skippedContent++
        } elseif ($check.nameExists) {
            # Already uploaded, but the fingerprint index doesn't know about it
            # (e.g. uploaded by an older script, or by rclone outside this flow).
            # Register it now so future runs can dedupe it by content.
            Write-Log ("  SKIP  {0} (filename already in bucket; will index fingerprint)" -f $key)
            $skippedName++
            $toBackfill += @{ Key = $key; Fp = $fp }
        } else {
            Write-Log ("  NEW   {0} ({1:N1} MB)" -f $key, ($f.Length / 1MB))
            $toUpload += @{ File = $f; Key = $key; Fp = $fp }
        }
    }

    if ($DryRun) {
        Write-Log ("DRY RUN summary: {0} new, {1} same-content, {2} same-name ({3} of those need indexing)." `
            -f $toUpload.Count, $skippedContent, $skippedName, $toBackfill.Count)
        Send-Heartbeat -Ok $true
        exit 0
    }

    # --- upload with rclone ---
    if ($toUpload.Count -gt 0) {
        $listFile = Join-Path $env:TEMP "r2-sync-files.txt"
        $toUpload | ForEach-Object { $_.Key } | Set-Content -Path $listFile -Encoding UTF8
        Write-Log ("Uploading {0} file(s) with rclone ..." -f $toUpload.Count)

        & rclone copy $VideoFolder ("{0}:{1}" -f $RcloneRemote, $Bucket) `
            --files-from $listFile `
            --transfers 4 --s3-upload-concurrency 8 --s3-chunk-size 64M `
            --retries 5 --progress
        $rc = $LASTEXITCODE
        Remove-Item $listFile -ErrorAction SilentlyContinue
        if ($rc -ne 0) { throw "rclone exited with code $rc" }
    } else {
        Write-Log "No new files to upload."
    }

    # --- register fingerprints so future syncs & web uploads see these files ---
    # /api/upload/register verifies the object exists in R2 before indexing, so
    # a file rclone failed to transfer simply won't be registered.
    $pending = @()
    $pending += $toUpload   | ForEach-Object { @{ Key = $_.Key; Fp = $_.Fp; New = $true } }
    $pending += $toBackfill | ForEach-Object { @{ Key = $_.Key; Fp = $_.Fp; New = $false } }

    if ($pending.Count -gt 0) {
        Write-Log ("Registering {0} fingerprint(s) ..." -f $pending.Count)
        foreach ($u in $pending) {
            $ok = $false
            foreach ($attempt in 1..3) {
                try {
                    $r = Invoke-RestMethod -Uri "$SiteBase/api/upload/register" -Method Post `
                        -ContentType "application/json" `
                        -Body (ConvertTo-Json @{ key = $u.Key; fingerprint = $u.Fp }) `
                        -WebSession $session
                    if ($r.ok) { $ok = $true }
                    break
                } catch {
                    if ($attempt -eq 3) {
                        Write-Log ("Could not register {0}: {1}" -f $u.Key, $_.Exception.Message) "WARN"
                    } else {
                        Start-Sleep -Seconds ([Math]::Pow(2, $attempt))
                    }
                }
            }
            if ($ok) {
                if ($u.New) { $uploaded++ } else { $backfilled++ }
            } elseif ($u.New) {
                Write-Log ("Upload of {0} did not verify in R2." -f $u.Key) "WARN"
            }
        }
    }

    Write-Log "---------------------------------------------"
    Write-Log ("Done. Uploaded: {0}. Backfilled index entries: {1}. Skipped: {2} same-content, {3} same-name." `
        -f $uploaded, $backfilled, $skippedContent, $skippedName)
    Send-Heartbeat -Ok $true
    exit 0
}
catch {
    $fatal = $_.Exception.Message
    Write-Log ("FAILED: {0}" -f $fatal) "ERROR"
    Send-Heartbeat -Ok $false -ErrorText $fatal
    exit 1
}
