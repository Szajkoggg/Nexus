' Starts the Nexus server of this checkout without a window. Its output goes to <NEXUS_HOME>\server.log
' (NEXUS_HOME defaults to %APPDATA%\Nexus). Used by scripts\autostart.ps1; can be run by hand: wscript scripts\start-hidden.vbs
Set fs = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")
root = fs.GetParentFolderName(fs.GetParentFolderName(WScript.ScriptFullName))
home = sh.ExpandEnvironmentStrings("%NEXUS_HOME%")
If home = "%NEXUS_HOME%" Then home = sh.ExpandEnvironmentStrings("%APPDATA%") & "\Nexus"
If Not fs.FolderExists(home) Then fs.CreateFolder(home)
sh.CurrentDirectory = root
sh.Run "cmd.exe /c node """ & root & "\apps\server\src\main.ts"" >> """ & home & "\server.log"" 2>&1", 0, False
