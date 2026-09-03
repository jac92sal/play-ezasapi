# =====================================================================
#  pull-videos.ps1 — download the R2 library DOWN to this PC
#
#  The opposite direction from sync-videos.ps1. Use this to get a local
#  working copy of everything in the bucket so you can review, rename,
#  and weed out files.
#
#  Safe by design:
#    - Never deletes anything, locally or in R2.
#    - Skips files you already have (matches on size + mod time).
#    - Resumable: interrupt it and run again, it picks up where it left off.
#
#  Requirements: rclone with an "r2" remote configured for the bucket
#  (same one sync-videos.ps1 uses).
#
#  Usage:
#    .\pull-videos.ps1 -WhatIf          # show what WOULD download, no transfer
#    .\pull-videos.ps1                  # download everything missing
#    .\pull-videos.ps1 -Dest D:\Videos  # somewhere with more room
# =====================================================================

[CmdletBinding()]
param(
    # Where to put them. Defaults to a NEW folder beside your Videos folder,
    # so the pull can't tangle with the folder sync-videos.ps1 reads from.
    [string]$Dest = $(if ($env:PLAY_PULL_DEST) { $env:PLAY_PULL_DEST }
                      elseif ($env:OneDrive) { Join-Path $env:OneDrive "Videos-R2-Pull" }
                      else { Join-Path $env:USERPROFILE "Videos-R2-Pull" }),

    [string]$RcloneRemote = "r2",
    [string]$Bucket       = "entertainmentvideos",

    # Parallel file transfers. Lower it if your connection struggles.
    [int]$Transfers = 4,

    # Show what would happen without transferring anything.
    [switch]$WhatIf,

    [string]$LogFile = $(Join-Path $env:LOCALAPPDATA "play-ezasapi\pull-videos.log")
)

$ErrorActionPreference = "Stop"

if ($LogFile) {
    $dir = Split-Path -Parent $LogFile
    if ($dir -and -not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
}
function Write-Log {
    param([string]$Message, [string]$Level = "INFO")
    $line = "{0} [{1}] {2}" -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss"), $Level, $Message
    if ($Level -eq "WARN") { Write-Warning $Message } else { Write-Host $line }
    if ($LogFile) { Add-Content -Path $LogFile -Value $line -Encoding UTF8 }
}

if (-not (Get-Command rclone -ErrorAction SilentlyContinue)) {
    throw "rclone not found. Install it first: winget install Rclone.Rclone"
}

$remote = "{0}:{1}" -f $RcloneRemote, $Bucket

Write-Log "=== pull-videos starting ==="
Write-Log "From: $remote"
Write-Log "To:   $Dest"

# --- how big is this going to be? ---
Write-Log "Measuring the bucket ..."
$sizeJson = & rclone size $remote --json 2>$null
if ($LASTEXITCODE -ne 0) { throw "rclone could not read $remote. Is the 'r2' remote configured?" }
$size = $sizeJson | ConvertFrom-Json
$neededGB = [math]::Round($size.bytes / 1GB, 2)
Write-Log ("Bucket holds {0} objects, {1} GB." -f $size.count, $neededGB)

# --- do we have room? ---
if (-not (Test-Path $Dest)) { New-Item -ItemType Directory -Path $Dest -Force | Out-Null }
$driveLetter = (Get-Item $Dest).PSDrive.Name
$free = (Get-PSDrive $driveLetter).Free
$freeGB = [math]::Round($free / 1GB, 2)
Write-Log ("Drive {0}: has {1} GB free." -f $driveLetter, $freeGB)
if ($free -lt $size.bytes) {
    throw ("Not enough space: need {0} GB, only {1} GB free on {2}:. " -f $neededGB, $freeGB, $driveLetter) +
          "Re-run with -Dest pointing at a bigger drive."
}

# --- transfer ---
# 'copy' only ever adds/updates on the destination; it never deletes.
$args = @(
    "copy", $remote, $Dest,
    "--transfers", $Transfers,
    "--checkers", 8,
    "--progress",
    "--stats", "10s",
    "--retries", 5,
    "--low-level-retries", 10
)
if ($WhatIf) {
    $args += "--dry-run"
    Write-Log "DRY RUN — listing what would transfer, nothing will be written."
}

& rclone @args
$rc = $LASTEXITCODE
if ($rc -ne 0) { Write-Log "rclone exited with code $rc" "WARN"; throw "Download did not finish cleanly (code $rc). Re-run to resume." }

if ($WhatIf) {
    Write-Log "Dry run complete."
} else {
    $local = Get-ChildItem -Path $Dest -File -Recurse
    Write-Log ("Done. {0} file(s), {1} GB now in {2}" -f $local.Count, [math]::Round(($local | Measure-Object Length -Sum).Sum / 1GB, 2), $Dest)
    Write-Log "Nothing was deleted from R2 — this was a one-way download."
}
