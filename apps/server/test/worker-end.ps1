# Test-only driver for the job host's End (worker-end.test.ts): compiles the repository's worker-job.cs together with
# the harness, then answers the requests on standard input (worker-end-calls.cs, EndHarness.Run).
$ErrorActionPreference = 'Stop'
Add-Type -Path (Join-Path $PSScriptRoot '..\src\worker-job.cs'), (Join-Path $PSScriptRoot 'worker-end-calls.cs')
[Console]::Out.Write([EndHarness]::Run([Console]::In.ReadToEnd()))
