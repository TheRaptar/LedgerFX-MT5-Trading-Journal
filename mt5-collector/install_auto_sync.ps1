<#
.SYNOPSIS
  Sets up free automatic LedgerFX sync on this Windows PC (no password is ever requested or stored).

.DESCRIPTION
  Creates a Windows Scheduled Task that runs the read-only collector every N minutes and at every
  sign-in. The task pushes new trades to your LedgerFX site using the ingest token. The token is saved
  to a file readable only by your Windows user. MT5 must be open and signed in with the INVESTOR
  password (sign in once and tick "Save password" in MT5; it stays inside MT5).

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\install_auto_sync.ps1
#>
param(
    [string]$PushUrl,
    [int]$EveryMinutes = 15,
    [string]$TaskName = "LedgerFX MT5 Auto Sync"
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $MyInvocation.MyCommand.Path

if (-not (Get-Command python -ErrorAction SilentlyContinue)) {
    throw "Python 3.10+ was not found. Install it from python.org (tick 'Add python.exe to PATH'), then run this again."
}
& python -m pip install --quiet --disable-pip-version-check -r (Join-Path $root "requirements.txt")

if (-not $PushUrl) { $PushUrl = Read-Host "Ingest URL from LedgerFX (https://.../api/ingest/<accountId>)" }
if ($PushUrl -notmatch '^https://' -and $PushUrl -notmatch '^http://(localhost|127\.0\.0\.1)') {
    throw "The URL must start with https:// (plain http is only allowed for localhost)."
}
$secure = Read-Host "Collector token from LedgerFX (input hidden)" -AsSecureString
$token = [System.Runtime.InteropServices.Marshal]::PtrToStringBSTR(
    [System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure))
if (-not $token) { throw "No token entered." }

$dir = Join-Path $env:LOCALAPPDATA "LedgerFX"
New-Item -ItemType Directory -Force -Path $dir | Out-Null
$tokenFile = Join-Path $dir "ingest_token.txt"
Set-Content -Path $tokenFile -Value $token -NoNewline -Encoding ASCII
# Only the current Windows user may read the token file.
& icacls $tokenFile /inheritance:r /grant:r "$($env:USERNAME):(R,W)" | Out-Null

$bat = Join-Path $root "run_collector.bat"
$args = "--mode incremental --confirm-investor-session --push-url `"$PushUrl`" --token-file `"$tokenFile`" --no-csv"
$action = New-ScheduledTaskAction -Execute $bat -Argument $args -WorkingDirectory $root
$repeat = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) `
    -RepetitionInterval (New-TimeSpan -Minutes $EveryMinutes)
$logon = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -MultipleInstances IgnoreNew `
    -ExecutionTimeLimit (New-TimeSpan -Minutes 10) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger @($repeat, $logon) -Settings $settings `
    -Description "Pushes new MT5 trades (read-only) to LedgerFX" -Force | Out-Null

Write-Host ""
Write-Host "Done. '$TaskName' will run every $EveryMinutes minutes and at sign-in (when this PC is on)."
Write-Host "Running it once now to verify..."
Start-ScheduledTask -TaskName $TaskName
Write-Host "Check LedgerFX > Accounts in about a minute. To remove: .\uninstall_auto_sync.ps1"
