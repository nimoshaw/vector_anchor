# install.ps1
# Vector Anchor — One-Click Install
# Usage: .\install.ps1

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$ROOT = $PSScriptRoot
if (-not $ROOT) { $ROOT = (Get-Location).Path }

Write-Host ''
Write-Host '  =======================================' -ForegroundColor Cyan
Write-Host '    Vector Anchor — One-Click Install' -ForegroundColor Cyan
Write-Host '  =======================================' -ForegroundColor Cyan
Write-Host ''

# Pre-check
$nodeCmd = Get-Command node -ErrorAction SilentlyContinue
if (-not $nodeCmd) {
    Write-Host '  X Node.js not found. Install from https://nodejs.org' -ForegroundColor Red
    exit 1
}
Write-Host ('  OK Node.js ' + (node -v)) -ForegroundColor Green

# Step 1: npm install
Write-Host ''
Write-Host '[1/6] Installing dependencies...' -ForegroundColor Yellow
Push-Location $ROOT
npm install --loglevel=error 2>$null
Pop-Location
Write-Host '  OK npm install' -ForegroundColor Green

# Step 2: TypeScript build
Write-Host '[2/6] Building TypeScript...' -ForegroundColor Yellow
Push-Location $ROOT
npx tsc 2>$null
Pop-Location
$cliJs = Join-Path $ROOT 'dist\cli.js'
if (-not (Test-Path $cliJs)) {
    Write-Host '  X Build failed: dist/cli.js not found' -ForegroundColor Red
    exit 1
}
Write-Host '  OK tsc build' -ForegroundColor Green

# Step 3: Register CLI
Write-Host '[3/6] Registering anchor CLI...' -ForegroundColor Yellow
$anchorCmd = Join-Path $ROOT 'anchor.cmd'
$cmdLines = @(
    '@echo off'
    ('node "' + $ROOT + '\dist\cli.js" %*')
)
$cmdLines | Set-Content -Path $anchorCmd -Encoding ASCII
Write-Host '  OK anchor.cmd generated' -ForegroundColor Green

$userPath = [Environment]::GetEnvironmentVariable('PATH', 'User')
if ($userPath -notlike ('*' + $ROOT + '*')) {
    [Environment]::SetEnvironmentVariable('PATH', ($userPath + ';' + $ROOT), 'User')
    $env:PATH = $env:PATH + ';' + $ROOT
    Write-Host '  OK Added to user PATH' -ForegroundColor Green
} else {
    Write-Host '  OK PATH already configured' -ForegroundColor Green
}

# Step 4: Windows auto-start
Write-Host '[4/6] Configuring auto-start...' -ForegroundColor Yellow

$batPath = Join-Path $ROOT 'start-anchor.bat'
$batLines = @(
    '@echo off'
    ':: Vector Anchor - HTTP MCP Service'
    ('cd /d "' + $ROOT + '"')
    'call npx tsx src/server.ts'
)
$batLines | Set-Content -Path $batPath -Encoding ASCII

$vbsPath = Join-Path $ROOT 'start-anchor.vbs'
$vbsLines = @(
    "' Vector Anchor - silent startup"
    "Set WshShell = CreateObject(""WScript.Shell"")"
    ('WshShell.Run """' + $batPath + '"""' + ', 0, False')
    'Set WshShell = Nothing'
)
$vbsLines | Set-Content -Path $vbsPath -Encoding ASCII

$startupDir = [Environment]::GetFolderPath('Startup')
$lnkPath = Join-Path $startupDir 'VectorAnchor.lnk'
$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($lnkPath)
$shortcut.TargetPath = 'wscript.exe'
$shortcut.Arguments = ('"' + $vbsPath + '"')
$shortcut.WorkingDirectory = $ROOT
$shortcut.Description = 'Vector Anchor MCP Service'
$shortcut.Save()
Write-Host ('  OK Auto-start: ' + $lnkPath) -ForegroundColor Green

# Step 5: Register MCP config
Write-Host '[5/6] Registering MCP config...' -ForegroundColor Yellow

$port = 23517
$envFile = Join-Path $ROOT '.env'
if (Test-Path $envFile) {
    Get-Content $envFile | ForEach-Object {
        if ($_ -match '^\s*ANCHOR_PORT\s*=\s*(\d+)') {
            $port = [int]$Matches[1]
        }
    }
}

$configDir = Join-Path $HOME '.gemini\antigravity'
$configPath = Join-Path $configDir 'mcp_config.json'
$expectedUrl = 'http://127.0.0.1:' + $port + '/mcp'

$config = @{ mcpServers = @{} }
if (Test-Path $configPath) {
    $raw = (Get-Content $configPath -Raw).Trim()
    if ($raw) {
        try {
            $config = $raw | ConvertFrom-Json -AsHashtable
            if (-not $config.ContainsKey('mcpServers')) { $config['mcpServers'] = @{} }
        } catch {
            $config = @{ mcpServers = @{} }
        }
    }
}

$config['mcpServers']['vector-anchor'] = @{ url = $expectedUrl }

if (-not (Test-Path $configDir)) { New-Item -ItemType Directory -Path $configDir -Force | Out-Null }
$config | ConvertTo-Json -Depth 5 | Set-Content $configPath -Encoding UTF8
Write-Host ('  OK MCP config: ' + $configPath) -ForegroundColor Green

# Step 6: Start service + health check
Write-Host '[6/6] Starting service...' -ForegroundColor Yellow

$alreadyRunning = $false
try {
    $health = Invoke-RestMethod -Uri ('http://localhost:' + $port + '/health') -TimeoutSec 2
    $alreadyRunning = $true
    Write-Host ('  OK Service already running (v' + $health.version + ')') -ForegroundColor Green
} catch { }

if (-not $alreadyRunning) {
    Start-Process -FilePath 'wscript.exe' -ArgumentList ('"' + $vbsPath + '"') -WindowStyle Hidden
    $ok = $false
    for ($i = 0; $i -lt 10; $i++) {
        Start-Sleep -Milliseconds 500
        try {
            $health = Invoke-RestMethod -Uri ('http://localhost:' + $port + '/health') -TimeoutSec 2
            $ok = $true
            break
        } catch { }
    }
    if ($ok) {
        Write-Host ('  OK Service started (v' + $health.version + ')') -ForegroundColor Green
    } else {
        Write-Host '  .. Service starting, please wait...' -ForegroundColor Yellow
    }
}

Write-Host ''
Write-Host '  =======================================' -ForegroundColor Green
Write-Host '    Vector Anchor installed!' -ForegroundColor Green
Write-Host '  =======================================' -ForegroundColor Green
Write-Host ''
Write-Host '  anchor init .           Init anchor' -ForegroundColor White
Write-Host '  anchor search "query"   Semantic search' -ForegroundColor White
Write-Host '  anchor health           Check service' -ForegroundColor White
Write-Host '  /anchor-health          IDE health check' -ForegroundColor White
Write-Host ''
