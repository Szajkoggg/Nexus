$ErrorActionPreference = 'Stop'
try {
    Add-Type -Path (Join-Path $PSScriptRoot 'worker-job.cs')
    [NexusWorkerJob]::Run()
} catch {
    [Console]::Error.WriteLine($_.Exception.ToString())
    exit 1
}
