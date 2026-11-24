$ErrorActionPreference = 'Stop'
# The job host's C# compiled once per machine (queue TI, TI3): Add-Type costs 0.2 s idle and 3 to 7 s on a busy
# machine at every start. The assembly is cached under a machine-wide folder (not NEXUS_HOME: every test has its own),
# named by the source's hash, and loaded from its bytes: Smart App Control refuses to load a compiled DLL from a file
# on this machine (0x800711C7), but not from bytes. Any failure of the cache falls back to compiling in memory, as
# before, and is logged (stderr and the cache folder's log). NEXUS_JOB_CACHE names another folder (the tests);
# NEXUS_JOB_CACHE_TRACE=1 also tells on stderr how the host got its type.
function Write-JobCacheLog([string] $dir, [string] $text) {
    [Console]::Error.WriteLine("worker job cache: $text")
    try { [IO.File]::AppendAllText((Join-Path $dir 'worker-job.log'), "$([DateTime]::UtcNow.ToString('o')) [$PID] $text`r`n") } catch { }
}
$trace = $env:NEXUS_JOB_CACHE_TRACE -eq '1'
$env:NEXUS_JOB_CACHE_TRACE = $null
try {
    $source = Join-Path $PSScriptRoot 'worker-job.cs'
    $how = 'fallback'  # until a type is loaded from the cache ('cached') or from a newly stored file ('stored')
    $dir = if ($env:NEXUS_JOB_CACHE) { $env:NEXUS_JOB_CACHE } else { Join-Path $env:LOCALAPPDATA 'Nexus\job-host' }
    try {
        $sha = [Security.Cryptography.SHA256]::Create()
        $hash = -join ($sha.ComputeHash([IO.File]::ReadAllBytes($source))[0..7] | ForEach-Object { $_.ToString('x2') })
        $dll = Join-Path $dir "worker-job-$hash.dll"
        if ([IO.File]::Exists($dll)) {
            try {
                $null = [Reflection.Assembly]::Load([IO.File]::ReadAllBytes($dll)).GetType('NexusWorkerJob', $true)
                $how = 'cached'
            } catch {
                Write-JobCacheLog $dir "could not load $dll, compiling instead: $($_.Exception.Message)"
                try { [IO.File]::Delete($dll) } catch { }
            }
        } else {
            # A private file first, then renamed: hosts starting at once never write into each other's file.
            $null = [IO.Directory]::CreateDirectory($dir)
            $temp = Join-Path $dir "worker-job-$hash.$PID.$([Guid]::NewGuid().ToString('N')).tmp"
            try {
                Add-Type -Path $source -OutputAssembly $temp -OutputType Library
                $bytes = [IO.File]::ReadAllBytes($temp)
                try { [IO.File]::Move($temp, $dll) } catch { }  # another host's copy is already there: keep it
                $null = [Reflection.Assembly]::Load($bytes).GetType('NexusWorkerJob', $true)
                $how = 'stored'
            } finally { try { [IO.File]::Delete($temp) } catch { } }
        }
    } catch {
        Write-JobCacheLog $dir "could not use the cache in $dir, compiling instead: $($_.Exception.Message)"
    }
    if ($how -eq 'fallback') { Add-Type -Path $source }
    if ($trace) { [Console]::Error.WriteLine("worker job cache: $how") }
    [NexusWorkerJob]::Run()
} catch {
    [Console]::Error.WriteLine($_.Exception.ToString())
    exit 1
}
