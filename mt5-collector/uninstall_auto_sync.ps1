param([string]$TaskName = "LedgerFX MT5 Auto Sync")
Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
Remove-Item (Join-Path $env:LOCALAPPDATA "LedgerFX\ingest_token.txt") -Force -ErrorAction SilentlyContinue
Write-Host "Automatic sync removed and the saved token deleted. Rotate the token in LedgerFX to revoke it fully."
