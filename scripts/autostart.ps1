# Starts the Nexus server when you sign in to Windows, without a console window, so the dashboard (and remote access
# through Tailscale) is there whenever the PC is on. Registers a scheduled task for the current user; no admin rights.
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
  Write-Output "Removed the '$name' task. A server it started may still run until you sign out."
  return
}

$root = Split-Path -Parent $PSScriptRoot
$node = (Get-Command node -ErrorAction Stop).Source
$home_ = if ($env:NEXUS_HOME) { $env:NEXUS_HOME } else { Join-Path $env:APPDATA "Nexus" }
New-Item -ItemType Directory -Force $home_ | Out-Null
$log = Join-Path $home_ "server.log"

Push-Location $root
npm run build -w @nexus/web
if (-not $?) { Pop-Location; throw "Building the dashboard failed" }
Pop-Location

# conhost --headless runs the console program without a window.
$command = "`"$node`" `"$root\apps\server\src\main.ts`" >> `"$log`" 2>&1"
$action = New-ScheduledTaskAction -Execute "conhost.exe" -Argument "--headless cmd.exe /c $command" -WorkingDirectory $root
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) `
  -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -MultipleInstances IgnoreNew
Register-ScheduledTask -TaskName $name -Action $action -Trigger $trigger -Settings $settings `
  -Description "Nexus dashboard server (http://127.0.0.1:4317)" -Force | Out-Null
Start-ScheduledTask -TaskName $name
Write-Output "Nexus starts at sign-in and is starting now: http://127.0.0.1:4317 (log: $log)"
