# Test-only job host (gated-cleanup.ts, nativeGate): the repository's worker-job.ps1 does the same with worker-job.cs
# alone. This one compiles worker-job.cs with worker-gate.cs, installs the gate on the host's native seam for the folder
# NEXUS_TEST_GATE_DIR names, and runs the host. Only this test file reads that variable.
$ErrorActionPreference = 'Stop'
try {
    $dir = $env:NEXUS_TEST_GATE_DIR
    $env:NEXUS_TEST_GATE_DIR = $null
    Add-Type -Path (Join-Path $PSScriptRoot '..\src\worker-job.cs'), (Join-Path $PSScriptRoot 'worker-gate.cs')
    [GateHost]::Install($dir)
    [NexusWorkerJob]::Run()
} catch {
    [Console]::Error.WriteLine($_.Exception.ToString())
    exit 1
}
