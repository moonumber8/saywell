$ErrorActionPreference = 'Stop'
$workspace = $PSScriptRoot
Set-Location -LiteralPath $workspace
$bootstrap = Join-Path $workspace 'tmp/kokoro-bootstrap'
$uv = Join-Path $bootstrap 'bin/uv.exe'
if (-not (Test-Path -LiteralPath $uv)) {
  & python -m pip install --disable-pip-version-check --target $bootstrap uv==0.12.23
  if ($LASTEXITCODE -ne 0) { throw 'Unable to install private uv bootstrap (Python with pip is required).' }
}
$pythonRoot = Join-Path $workspace '.runtime/python'
& $uv python install 3.12.15 --install-dir $pythonRoot --no-registry --no-bin
if ($LASTEXITCODE -ne 0) { throw 'Unable to install private Python.' }
$python = Join-Path $pythonRoot 'cpython-3.12.15-windows-x86_64-none/python.exe'
$environment = Join-Path $workspace '.runtime/kokoro'
$interpreter = Join-Path $environment 'Scripts/python.exe'
if (-not (Test-Path -LiteralPath $interpreter)) {
  & $uv venv $environment --python $python
  if ($LASTEXITCODE -ne 0) { throw 'Unable to create the Kokoro virtual environment.' }
}
& $uv pip install --python $interpreter --requirement kokoro-requirements.txt
if ($LASTEXITCODE -ne 0) { throw 'Unable to install Kokoro dependencies.' }
& node setup-kokoro.mjs
if ($LASTEXITCODE -ne 0) { throw 'Unable to download and verify Kokoro weights.' }
