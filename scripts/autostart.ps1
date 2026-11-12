# Starts the Nexus server of this checkout when you sign in to Windows, without a window, so the dashboard (and
# remote access through Tailscale) is there whenever the PC is on. Registers a scheduled task for the current user;
# no admin rights. Run it from the live instance (C:\Code\Nexus-live), not from a development checkout.
#
#   powershell -ExecutionPolicy Bypass -File scripts\autostart.ps1           install (builds the dashboard first) and start
#   powershell -ExecutionPolicy Bypass -File scripts\autostart.ps1 -Remove   stop and remove
#
# The server's output goes to %APPDATA%\Nexus\server.log.
param([switch]$Remove)

$name = "Nexus"
if ($Remove) {
  Stop-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
  Unregister-ScheduledTask -TaskName $name -Confirm:$false -ErrorAction SilentlyContinue
  Write-Output "Removed the '$name' task. A server it started keeps running until you stop it or sign out."
  return
}

$root = Split-Path -Parent $PSScriptRoot
Push-Location $root
npm run build -w @nexus/web
if (-not $?) { Pop-Location; throw "Building the dashboard failed" }
Pop-Location

# wscript runs the launcher, which starts node without a window (start-hidden.vbs).
$action = New-ScheduledTaskAction -Execute "wscript.exe" -Argument "`"$root\scripts\start-hidden.vbs`"" -WorkingDirectory $root
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew
Register-ScheduledTask -TaskName $name -Action $action -Trigger $trigger -Settings $settings `
  -Description "Nexus dashboard server (http://127.0.0.1:4317), from $root" -Force | Out-Null

$listening = Get-NetTCPConnection -LocalPort 4317 -State Listen -ErrorAction SilentlyContinue
if ($listening) { Write-Output "Nexus starts at sign-in from $root. A server already runs on port 4317; it was left as it is." }
else { Start-ScheduledTask -TaskName $name; Write-Output "Nexus starts at sign-in from $root, and is starting now: http://127.0.0.1:4317" }
