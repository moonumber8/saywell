param(
    [switch]$SkipBuild,
    [int]$ApiPort = 3001,
    [int]$PublicPort = 4173
)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$runtimeDirectory = Join-Path $projectRoot 'tmp\publish'
$statePath = Join-Path $runtimeDirectory 'state.json'
$cloudflaredPath = Join-Path $projectRoot 'tmp\tools\cloudflared.exe'
$nodePath = (Get-Command node -ErrorAction Stop).Source
New-Item -ItemType Directory -Force -Path $runtimeDirectory | Out-Null
if (Test-Path -LiteralPath $statePath) {
    $previous = Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json
    foreach ($entry in $previous.processes) {
        $running = Get-Process -Id $entry.id -ErrorAction SilentlyContinue
        if ($running -and $running.StartTime.ToUniversalTime().Ticks.ToString() -eq $entry.started) {
            throw "A published session is still running: $($previous.url). Use scripts/Stop-Publish.ps1 first."
        }
    }
}
if (-not $SkipBuild) {
    Push-Location $projectRoot
    try { & npm.cmd run build; if ($LASTEXITCODE -ne 0) { throw 'Build failed' } }
    finally { Pop-Location }
}
if (-not (Test-Path -LiteralPath (Join-Path $projectRoot 'dist\index.html'))) { throw 'Build the app first: npm run build' }
if (-not (Test-Path -LiteralPath $cloudflaredPath)) {
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $cloudflaredPath) | Out-Null
    $release = Invoke-RestMethod -Uri 'https://api.github.com/repos/cloudflare/cloudflared/releases/latest' -Headers @{ 'User-Agent' = 'Saywell-POC' }
    $asset = $release.assets | Where-Object { $_.name -eq 'cloudflared-windows-amd64.exe' } | Select-Object -First 1
    if (-not $asset -or $asset.digest -notmatch '^sha256:[a-f0-9]{64}$') { throw 'Official release checksum is unavailable' }
    Invoke-WebRequest -Uri $asset.browser_download_url -OutFile $cloudflaredPath -UseBasicParsing
    $actualDigest = 'sha256:' + (Get-FileHash -LiteralPath $cloudflaredPath -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($actualDigest -ne $asset.digest) {
        Remove-Item -LiteralPath $cloudflaredPath
        throw 'Cloudflared checksum did not match the official release'
    }
}
$owned = [System.Collections.Generic.List[object]]::new()
function Start-OwnedProcess($Executable, $Arguments, $Name) {
    $process = Start-Process -FilePath $Executable -ArgumentList $Arguments -WorkingDirectory $projectRoot -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $runtimeDirectory "$Name.out.log") -RedirectStandardError (Join-Path $runtimeDirectory "$Name.err.log")
    $owned.Add([pscustomobject]@{ id = $process.Id; started = $process.StartTime.ToUniversalTime().Ticks.ToString(); name = $Name })
    return $process
}
function Wait-ForHealth($Url, $Process) {
    for ($attempt = 0; $attempt -lt 30; $attempt++) {
        if ($Process -and $Process.HasExited) { throw "Service exited. Check logs in $runtimeDirectory" }
        try {
            $response = Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec 2
            if ($response.StatusCode -eq 200) { return }
        } catch { }
        Start-Sleep -Seconds 1
    }
    throw "Service did not start: $Url"
}
try {
    $existingApi = Get-NetTCPConnection -LocalPort $ApiPort -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($existingApi) {
        $apiCommand = (Get-CimInstance Win32_Process -Filter "ProcessId = $($existingApi.OwningProcess)").CommandLine
        if ($apiCommand -notmatch 'node(?:\.exe)?["\s].*server\.mjs') { throw "Port $ApiPort is in use by another application" }
        Wait-ForHealth "http://127.0.0.1:$ApiPort/api/curriculum" $null
    } else {
        $env:PORT = $ApiPort.ToString()
        $apiProcess = Start-OwnedProcess $nodePath @('server.mjs') 'api'
        Wait-ForHealth "http://127.0.0.1:$ApiPort/api/curriculum" $apiProcess
    }
    if (Get-NetTCPConnection -LocalPort $PublicPort -State Listen -ErrorAction SilentlyContinue) { throw "Port $PublicPort is already in use" }
    $env:PORT = $ApiPort.ToString()
    $env:PUBLIC_PORT = $PublicPort.ToString()
    $gateway = Start-OwnedProcess $nodePath @('publish-server.mjs') 'web'
    Wait-ForHealth "http://127.0.0.1:$PublicPort/healthz" $gateway
    $tunnel = Start-OwnedProcess $cloudflaredPath @('tunnel', '--no-autoupdate', '--url', "http://127.0.0.1:$PublicPort", '--protocol', 'http2') 'tunnel'
    $publicUrl = $null
    for ($attempt = 0; $attempt -lt 60; $attempt++) {
        if ($tunnel.HasExited) { throw "Cloudflare Tunnel exited. Check $runtimeDirectory\tunnel.err.log" }
        $log = Get-Content -LiteralPath (Join-Path $runtimeDirectory 'tunnel.err.log') -Raw -ErrorAction SilentlyContinue
        if ($log -match 'https://[a-z0-9-]+\.trycloudflare\.com') { $publicUrl = $Matches[0]; break }
        Start-Sleep -Seconds 1
    }
    if (-not $publicUrl) { throw 'Cloudflare did not return a public URL within 60 seconds' }
    [pscustomobject]@{ url = $publicUrl; apiPort = $ApiPort; publicPort = $PublicPort; processes = @($owned.ToArray()) } | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $statePath -Encoding UTF8
    Write-Output "Saywell published: $publicUrl"
    Write-Output 'Keep this computer and its services running. Stop sharing with scripts/Stop-Publish.ps1.'
} catch {
    foreach ($entry in $owned) {
        $running = Get-Process -Id $entry.id -ErrorAction SilentlyContinue
        if ($running -and $running.StartTime.ToUniversalTime().Ticks.ToString() -eq $entry.started) { Stop-Process -Id $entry.id }
    }
    throw
}
