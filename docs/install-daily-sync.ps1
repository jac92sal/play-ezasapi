# =====================================================================
#  install-daily-sync.ps1 — register the daily video sync on THIS PC
#
#  Cloudflare cannot pull files off your computer, so the "daily sync"
#  has to be a scheduled task here that pushes to R2. This script creates
#  (or updates) that Windows Scheduled Task.
#
#  Run it once, from an elevated *or* normal PowerShell window:
#
#    cd <repo>\docs
#    .\install-daily-sync.ps1 -Pin 1234
#
#  Then verify: play.ezasapi.com shows a "Synced …" pill in the header
#  after the first run, and `Get-ScheduledTask PlayEzasapiVideoSync`
#  shows the schedule.
#
#  To remove it:  Unregister-ScheduledTask -TaskName PlayEzasapiVideoSync
# =====================================================================

[CmdletBinding()]
param(
    # Site PIN. Stored for the task via a user-level environment variable
    # (PLAY_PIN) rather than being written into the task's command line,
    # where it would be readable in the Task Scheduler UI.
    [Parameter(Mandatory = $true)]
    [string]$Pin,

    [string]$TaskName = "PlayEzasapiVideoSync",

    # Local time of day to run, 24h "HH:mm".
    [string]$At = "03:30",

    # Source folder; leave empty to let sync-videos.ps1 pick its default.
    [string]$VideoFolder = "",

    # Path to sync-videos.ps1 — defaults to the copy next to this script.
    [string]$ScriptPath = (Join-Path $PSScriptRoot "sync-videos.ps1")
)

$ErrorActionPreference = "Stop"

if (-not (Test-Path $ScriptPath)) { throw "sync-videos.ps1 not found at: $ScriptPath" }
if ($At -notmatch '^\d{2}:\d{2}$') { throw "-At must look like 03:30" }

$ScriptPath = (Resolve-Path $ScriptPath).Path

# --- store the PIN (and optional folder) for the current user ---
# The scheduled task runs as you, so it inherits these.
[Environment]::SetEnvironmentVariable("PLAY_PIN", $Pin, "User")
$env:PLAY_PIN = $Pin
if ($VideoFolder) {
    [Environment]::SetEnvironmentVariable("PLAY_VIDEO_FOLDER", $VideoFolder, "User")
    $env:PLAY_VIDEO_FOLDER = $VideoFolder
}
Write-Host "Stored PLAY_PIN as a user environment variable." -ForegroundColor Green

# --- build the task ---
$action = New-ScheduledTaskAction `
    -Execute "powershell.exe" `
    -Argument ('-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "{0}"' -f $ScriptPath) `
    -WorkingDirectory (Split-Path -Parent $ScriptPath)

$trigger = New-ScheduledTaskTrigger -Daily -At $At

$settings = New-ScheduledTaskSettingsSet `
    -StartWhenAvailable `
    -DontStopIfGoingOnBatteries `
    -AllowStartIfOnBatteries `
    -RunOnlyIfNetworkAvailable `
    -ExecutionTimeLimit (New-TimeSpan -Hours 8) `
    -MultipleInstances IgnoreNew

# Run as the current user, only when logged on — this keeps access to
# OneDrive-synced files and to the user environment variables above.
$principal = New-ScheduledTaskPrincipal `
    -UserId "$env:USERDOMAIN\$env:USERNAME" `
    -LogonType Interactive `
    -RunLevel Limited

if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
    Write-Host "Task '$TaskName' already exists — replacing it."
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
}

Register-ScheduledTask `
    -TaskName $TaskName `
    -Action $action `
    -Trigger $trigger `
    -Settings $settings `
    -Principal $principal `
    -Description "Daily one-way sync of local videos to the play.ezasapi.com R2 bucket." | Out-Null

Write-Host ""
Write-Host "Installed scheduled task '$TaskName' — runs daily at $At." -ForegroundColor Green
Write-Host "Log file: $(Join-Path $env:LOCALAPPDATA 'play-ezasapi\sync-videos.log')"
Write-Host ""
Write-Host "Run it now to verify:  Start-ScheduledTask -TaskName $TaskName"
Write-Host "Check what it would do: .\sync-videos.ps1 -DryRun"
