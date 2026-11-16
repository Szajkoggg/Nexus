# A test-owned directory holder. The denied variant tightens only its own process DACL; no elevation or file ACL change.
param([string]$Ready, [string]$Release, [switch]$DenyTerminate)
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
while (-not [IO.File]::Exists($Release)) { Start-Sleep -Milliseconds 25 }
