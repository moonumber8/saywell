$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$statePath = Join-Path $projectRoot 'tmp\publish\state.json'
if (-not (Test-Path -LiteralPath $statePath)) { Write-Output 'No published session recorded.'; exit 0 }
$state = Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json
foreach ($entry in $state.processes) {
    $running = Get-Process -Id $entry.id -ErrorAction SilentlyContinue
    if ($running -and $running.StartTime.ToUniversalTime().Ticks.ToString() -eq $entry.started) {
        Stop-Process -Id $entry.id
        Write-Output "Stopped $($entry.name)"
    }
}
Remove-Item -LiteralPath $statePath
Write-Output 'Public sharing stopped. Previously running local services were kept running.'
