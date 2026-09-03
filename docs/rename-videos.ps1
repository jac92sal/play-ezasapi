# =====================================================================
#  rename-videos.ps1 — apply the renames you typed into video-manifest.csv
#                      DIRECTLY to the R2 bucket
#
#  WHY THIS EXISTS
#  Renaming your local copies and re-running sync-videos.ps1 does NOT
#  rename anything in R2. That sync only ever adds, and it dedupes by
#  file content — so a renamed file is recognised as content you already
#  have and skipped. The old name stays in the bucket forever. This
#  script renames server-side instead, which is also instant: R2 moves
#  the object without re-uploading a single byte.
#
#  HOW TO USE
#    1. Open docs\video-manifest.csv (Excel, or any editor).
#    2. For each file you want renamed, type the new filename in the
#       "new_name_HERE" column. Leave blank to keep the current name.
#       Keep the extension (.mp4 / .m4v / ...).
#    3. Save it as CSV.
#    4. .\rename-videos.ps1 -WhatIf     # review every change, nothing applied
#    5. .\rename-videos.ps1             # apply
#
#  DELETING
#  Put the single word  DELETE  in new_name_HERE to remove a file from the
#  bucket. That requires -AllowDelete as well, and you should assume it is
#  PERMANENT: whether R2 object versioning is enabled on this bucket has
#  NOT been verified, so do not count on an undo. Pull a local copy first
#  with pull-videos.ps1, and confirm it landed, before deleting anything.
#
#  Requirements: rclone with the "r2" remote configured.
# =====================================================================

[CmdletBinding()]
param(
    [string]$Csv = $(Join-Path $PSScriptRoot "video-manifest.csv"),
    [string]$RcloneRemote = "r2",
    [string]$Bucket       = "entertainmentvideos",

    # Review mode: print every planned change, touch nothing.
    [switch]$WhatIf,

    # Required before any DELETE row is honoured.
    [switch]$AllowDelete,

    [string]$LogFile = $(Join-Path $env:LOCALAPPDATA "play-ezasapi\rename-videos.log")
)

$ErrorActionPreference = "Stop"

if ($LogFile) {
    $dir = Split-Path -Parent $LogFile
    if ($dir -and -not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
}
function Write-Log {
    param([string]$Message, [string]$Level = "INFO")
    $line = "{0} [{1}] {2}" -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss"), $Level, $Message
    if ($Level -eq "WARN") { Write-Warning $Message }
    elseif ($Level -eq "ERROR") { Write-Host $line -ForegroundColor Red }
    else { Write-Host $line }
    if ($LogFile) { Add-Content -Path $LogFile -Value $line -Encoding UTF8 }
}

if (-not (Test-Path $Csv)) { throw "CSV not found: $Csv" }
if (-not (Get-Command rclone -ErrorAction SilentlyContinue)) {
    throw "rclone not found. Install it first: winget install Rclone.Rclone"
}

$remote = "{0}:{1}" -f $RcloneRemote, $Bucket
$rows = Import-Csv -Path $Csv

# --- work out what's actually being asked for ---
$renames = @()
$deletes = @()
foreach ($r in $rows) {
    $new = ($r.new_name_HERE).Trim()
    if (-not $new) { continue }
    if ($new -eq "DELETE") { $deletes += $r; continue }
    if ($new -eq $r.current_name) { continue }
    if ($new -match '[\\/:*?"<>|]') { throw "Illegal character in new name for '$($r.current_name)': $new" }
    $renames += [pscustomobject]@{ From = $r.key; To = $new; SizeMB = $r.size_MB }
}

# --- catch mistakes before touching anything ---
$collide = $renames | Group-Object To | Where-Object Count -gt 1
if ($collide) { throw "Two rows want the same new name: " + ($collide.Name -join ", ") }

$existing = @{}
foreach ($r in $rows) { $existing[$r.current_name] = $true }
foreach ($m in $renames) {
    if ($existing.ContainsKey($m.To) -and -not ($renames | Where-Object { $_.From -eq $m.To })) {
        throw "'$($m.To)' is already the name of another file in the bucket. Pick a different name."
    }
}

Write-Log "=== rename-videos ==="
Write-Log ("CSV: {0}" -f $Csv)
Write-Log ("Planned: {0} rename(s), {1} delete(s)." -f $renames.Count, $deletes.Count)

if ($renames.Count -eq 0 -and $deletes.Count -eq 0) {
    Write-Log "Nothing to do — the new_name_HERE column is empty."
    exit 0
}

foreach ($m in $renames) { Write-Log ("  RENAME  {0}  ->  {1}" -f $m.From, $m.To) }
foreach ($d in $deletes) { Write-Log ("  DELETE  {0}  ({1} MB)" -f $d.key, $d.size_MB) "WARN" }

if ($WhatIf) {
    Write-Log "DRY RUN — nothing was changed. Re-run without -WhatIf to apply."
    exit 0
}

if ($deletes.Count -gt 0 -and -not $AllowDelete) {
    throw ("{0} row(s) say DELETE but -AllowDelete was not passed. " -f $deletes.Count) +
          "Deletion from R2 is permanent. Pull a local copy first, then re-run with -AllowDelete."
}

# --- renames: server-side moves, no bytes transferred ---
$done = 0
foreach ($m in $renames) {
    try {
        & rclone moveto ("{0}/{1}" -f $remote, $m.From) ("{0}/{1}" -f $remote, $m.To) --retries 3
        if ($LASTEXITCODE -ne 0) { throw "rclone exited $LASTEXITCODE" }
        $done++
        Write-Log ("  ok  {0} -> {1}" -f $m.From, $m.To)
    } catch {
        Write-Log ("  FAILED {0}: {1}" -f $m.From, $_.Exception.Message) "ERROR"
    }
}

# --- deletes, only with explicit consent ---
$removed = 0
if ($deletes.Count -gt 0) {
    Write-Log ("About to PERMANENTLY delete {0} file(s) from R2." -f $deletes.Count) "WARN"
    $answer = Read-Host "Type DELETE to confirm"
    if ($answer -ceq "DELETE") {
        foreach ($d in $deletes) {
            try {
                & rclone deletefile ("{0}/{1}" -f $remote, $d.key) --retries 3
                if ($LASTEXITCODE -ne 0) { throw "rclone exited $LASTEXITCODE" }
                $removed++
                Write-Log ("  deleted {0}" -f $d.key)
            } catch {
                Write-Log ("  FAILED to delete {0}: {1}" -f $d.key, $_.Exception.Message) "ERROR"
            }
        }
    } else {
        Write-Log "Not confirmed — no files were deleted."
    }
}

Write-Log "---------------------------------------------"
Write-Log ("Renamed: {0}/{1}.  Deleted: {2}/{3}." -f $done, $renames.Count, $removed, $deletes.Count)
Write-Log "Note: the fingerprint index still points at the OLD keys for renamed files."
Write-Log "The next sync-videos.ps1 run re-registers them, so this self-corrects."
Write-Log "Refresh play.ezasapi.com to see the new names."
