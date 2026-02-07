param(
    [string]$PythonVersion = "3.11",
    [switch]$RunApp
)

$ErrorActionPreference = "Stop"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ProjectDir = Resolve-Path (Join-Path $ScriptDir "..")

function Refresh-Path {
    $paths = @(
        "$env:USERPROFILE\.local\bin",
        "$env:USERPROFILE\.cargo\bin"
    )
    foreach ($p in $paths) {
        if (Test-Path $p) {
            if (-not ($env:Path.Split(';') -contains $p)) {
                $env:Path = "$p;$env:Path"
            }
        }
    }
}

function Install-UvIfMissing {
    Refresh-Path
    $uv = Get-Command uv -ErrorAction SilentlyContinue
    if ($uv) {
        Write-Host "[setup] uv found: $($uv.Source)"
        return
    }

    Write-Host "[setup] uv not found, installing..."
    powershell -ExecutionPolicy Bypass -NoProfile -Command "irm https://astral.sh/uv/install.ps1 | iex"

    Refresh-Path
    $uv = Get-Command uv -ErrorAction SilentlyContinue
    if (-not $uv) {
        throw "[setup] uv installed but not found in PATH."
    }
    Write-Host "[setup] uv installed: $($uv.Source)"
}

Install-UvIfMissing

Set-Location $ProjectDir
Write-Host "[setup] syncing dependencies with uv (python $PythonVersion)..."
uv sync --python $PythonVersion

Write-Host "[setup] running health check..."
uv run python -c "from app.web import app; print('ok', app.title)"

if ($RunApp) {
    Write-Host "[setup] starting app..."
    uv run python main.py
}
else {
    Write-Host "[setup] done. Start app with: uv run python main.py"
}

