# A test-owned directory holder. The denied variant tightens only its own process DACL; no elevation or file ACL change.
# -Late <file> (queue WHR, WHR6): once "<file>.go" exists, it starts a child of its own, this script again, holding the
# sibling directory "<its directory>-late", sharing this console (no window, no conhost of its own); the child writes
# its PID to <file> and ends when "<file>.release" exists. Started by a job member, the child is one too (inherited).
param([string]$Ready, [string]$Release, [switch]$DenyTerminate, [string]$Late)
$ErrorActionPreference = 'Stop'
if ($DenyTerminate) {
    Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
public static class RestrictedWorkerHelper {
    [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
    [DllImport("advapi32.dll", SetLastError=true)] static extern bool GetKernelObjectSecurity(IntPtr h, uint info, byte[] data, uint size, out uint needed);
    [DllImport("advapi32.dll", SetLastError=true)] static extern bool SetKernelObjectSecurity(IntPtr h, uint info, byte[] data);
    public static void Restrict() {
        uint needed;
        GetKernelObjectSecurity(GetCurrentProcess(), 4, null, 0, out needed);
        byte[] data = new byte[needed];
        if (!GetKernelObjectSecurity(GetCurrentProcess(), 4, data, needed, out needed)) throw new Win32Exception();
        var sd = new RawSecurityDescriptor(data, 0);
        sd.DiscretionaryAcl.InsertAce(0, new CommonAce(AceFlags.None, AceQualifier.AccessDenied, 1,
            new SecurityIdentifier(WellKnownSidType.WorldSid, null), false, null));
        data = new byte[sd.BinaryLength]; sd.GetBinaryForm(data, 0);
        if (!SetKernelObjectSecurity(GetCurrentProcess(), 4, data)) throw new Win32Exception();
    }
}
'@
    [RestrictedWorkerHelper]::Restrict()
}
[IO.File]::WriteAllText($Ready, [string]$PID)
$started = $false
while (-not [IO.File]::Exists($Release)) {
    if ($Late -and -not $started -and [IO.File]::Exists("$Late.go")) {
        $started = $true
        $dir = (Get-Location).Path + '-late'
        [void][IO.Directory]::CreateDirectory($dir)
        $info = New-Object Diagnostics.ProcessStartInfo 'powershell.exe', ('-NoProfile -NonInteractive -File "' + $PSCommandPath + '" -Ready "' + $Late + '" -Release "' + $Late + '.release"')
        $info.UseShellExecute = $false
        $info.CreateNoWindow = $false
        $info.WorkingDirectory = $dir
        [void][Diagnostics.Process]::Start($info)
    }
    Start-Sleep -Milliseconds 25
}
