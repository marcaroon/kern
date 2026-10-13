# Keeps the KERN worker running: restarts it after a crash or network loss.
# Output goes to .local\worker.log (Git-ignored). The worker logs only safe error codes.
$ErrorActionPreference = "Continue"
$root = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
Set-Location $root
New-Item -ItemType Directory -Force (Join-Path $root ".local") | Out-Null
$log = Join-Path $root ".local\worker.log"
while ($true) {
  if ((Test-Path $log) -and (Get-Item $log).Length -gt 5MB) {
    Move-Item -Force $log "$log.1"
  }
  Add-Content -Encoding utf8 $log "[$(Get-Date -Format o)] worker starting"
  # cmd redirection keeps the log UTF-8; PowerShell 5.1 redirection would write UTF-16.
  cmd.exe /d /c "npm.cmd run worker >> `"$log`" 2>&1"
  Add-Content -Encoding utf8 $log "[$(Get-Date -Format o)] worker exited ($LASTEXITCODE); restarting in 15s"
  Start-Sleep -Seconds 15
}
