# Registers a per-user scheduled task that starts the KERN worker at logon, hidden.
# Usage:  .\scripts\windows\install-worker-task.ps1            (install, or restart after .env changes)
#         .\scripts\windows\install-worker-task.ps1 -Uninstall
param([switch]$Uninstall)
$name = "KERN Worker"
function Stop-KernWorker {
  Stop-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
  # Stop the restart wrapper first so it cannot relaunch, then its node worker processes.
  foreach ($pattern in @('run-worker\.ps1', 'scripts[\\/]worker\.ts')) {
    Get-CimInstance Win32_Process -Filter "Name='powershell.exe' OR Name='node.exe' OR Name='cmd.exe'" |
      Where-Object { $_.CommandLine -match $pattern -and $_.ProcessId -ne $PID } |
      ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  }
  for ($i = 0; $i -lt 20 -and (Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue).State -eq 'Running'; $i++) {
    Start-Sleep -Milliseconds 500
  }
}
Stop-KernWorker
if ($Uninstall) {
  Unregister-ScheduledTask -TaskName $name -Confirm:$false -ErrorAction SilentlyContinue
  Write-Output "Removed scheduled task '$name'."
  return
}
$runner = Join-Path $PSScriptRoot "run-worker.ps1"
$action = New-ScheduledTaskAction -Execute "powershell.exe" `
  -Argument "-NoProfile -WindowStyle Hidden -File `"$runner`"" `
  -WorkingDirectory (Split-Path (Split-Path $PSScriptRoot -Parent) -Parent)
$trigger = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"
# One instance only: two pollers would make Telegram reject getUpdates with a conflict.
$settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew `
  -ExecutionTimeLimit ([TimeSpan]::Zero) -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries -StartWhenAvailable
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited
Register-ScheduledTask -TaskName $name -Action $action -Trigger $trigger `
  -Settings $settings -Principal $principal -Force | Out-Null
Start-ScheduledTask -TaskName $name
Write-Output "Scheduled task '$name' installed and started. Log: .local\worker.log"
