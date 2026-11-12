# Creates the live instance of Nexus: a git worktree of this repository on a detached commit, with its own
# node_modules and built dashboard. The live instance serves real projects; development happens in this checkout and
# reaches the live one only through `nexus server update` (which moves the worktree to a newer commit when no step is
# running).
#
#   powershell -ExecutionPolicy Bypass -File scripts\live.ps1 [-Path C:\Code\Nexus-live] [-Ref main]
#
# Then start it from there: `npm start` in the live folder, or its scripts\autostart.ps1 to start it with Windows.
param([string]$Path = (Join-Path (Split-Path -Parent (Split-Path -Parent $PSScriptRoot)) "Nexus-live"), [string]$Ref = "main")

$repo = Split-Path -Parent $PSScriptRoot
if (Test-Path (Join-Path $Path ".git")) {
  Write-Output "The live worktree exists: $Path (update it with: nexus server update)"
} else {
  git -C $repo worktree add --detach $Path $Ref
  if (-not $?) { throw "git worktree add failed" }
}
Push-Location $Path
try {
  npm install --no-audit --no-fund
  if (-not $?) { throw "npm install failed" }
  npm run build -w @nexus/web
  if (-not $?) { throw "building the dashboard failed" }
} finally { Pop-Location }
$commit = git -C $Path log -1 --format="%h %s"
Write-Output "Live instance ready at $Path ($commit). Start it there with: npm start"
