' Starts the Nexus server of this checkout without a window. The server writes its own log to <NEXUS_HOME>\server.log
' (NEXUS_HOME defaults to %APPDATA%\Nexus). Used by scripts\autostart.ps1; can be run by hand: wscript scripts\start-hidden.vbs
Set fs = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")
root = fs.GetParentFolderName(fs.GetParentFolderName(WScript.ScriptFullName))
sh.Environment("Process")("NEXUS_LOG") = "1"
sh.CurrentDirectory = root
sh.Run "node """ & root & "\apps\server\src\main.ts""", 0, False
