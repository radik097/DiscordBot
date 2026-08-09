#!/usr/bin/env pwsh
<#
.SYNOPSIS
    Initializes Docker environment for Discord bot
.DESCRIPTION
    Sets up Docker configuration, creates necessary directories,
    and validates environment files
#>

param(
    [switch]$SkipDocker = $false
)

# Colors for output
$colors = @{
    Success = 'Green'
    Warning = 'Yellow'
    Error   = 'Red'
    Info    = 'Cyan'
}

function Write-Step {
    param([string]$Message)
    Write-Host "▶ $Message" -ForegroundColor $colors.Info
}

function Write-Success {
    param([string]$Message)
    Write-Host "✓ $Message" -ForegroundColor $colors.Success
}

function Write-Warning {
    param([string]$Message)
    Write-Host "⚠ $Message" -ForegroundColor $colors.Warning
}

function Write-Error {
    param([string]$Message)
    Write-Host "✗ $Message" -ForegroundColor $colors.Error
}

# Header
Write-Host ""
Write-Host "Discord Bot Docker Setup (Windows PowerShell)" -ForegroundColor Cyan -BackgroundColor Black
Write-Host "=============================================" -ForegroundColor Cyan
Write-Host ""

# Check Docker
Write-Step "Checking Docker installation..."
if (-not $SkipDocker) {
    $dockerInstalled = $null -ne (Get-Command docker -ErrorAction SilentlyContinue)
    if (-not $dockerInstalled) {
        Write-Error "Docker is not installed"
        Write-Host "Please install Docker Desktop for Windows from https://www.docker.com/products/docker-desktop" -ForegroundColor Yellow
        Read-Host "Press Enter to exit"
        exit 1
    }
    Write-Success "Docker is installed"
} else {
    Write-Success "Docker check skipped"
}

# Get project directory
$ProjectDir = Split-Path -Parent $PSScriptRoot
Set-Location $ProjectDir
Write-Step "Working directory: $ProjectDir"

# Check .env file
Write-Step "Checking .env file..."
if (-not (Test-Path ".env")) {
    if (Test-Path ".env.example") {
        Write-Warning ".env not found, creating from .env.example..."
        Copy-Item ".env.example" ".env"
        Write-Warning "You must edit .env with your settings:"
        Write-Host "  - DISCORD_TOKEN" -ForegroundColor Yellow
        Write-Host "  - CLIENT_ID" -ForegroundColor Yellow
        Write-Host "  - GUILD_ID" -ForegroundColor Yellow
        Read-Host "Press Enter after editing .env"
    } else {
        Write-Error ".env and .env.example not found"
        exit 1
    }
} else {
    Write-Success ".env file exists"
}

# Create directories
Write-Step "Creating project directories..."
@("config", "data", "logs") | ForEach-Object {
    $dir = $_
    if (-not (Test-Path $dir)) {
        New-Item -ItemType Directory -Path $dir -Force | Out-Null
        Write-Success "Created directory: $dir"
    } else {
        Write-Success "Directory exists: $dir"
    }
}

# Check config/structure.json
Write-Step "Checking config/structure.json..."
if (-not (Test-Path "config/structure.json")) {
    Write-Warning "config/structure.json not found, creating default..."
    $defaultConfig = @{
        roles              = @()
        categories         = @()
        channels           = @()
        musicAllowedRoles  = @()
        globalDenyRoles    = @{}
        alwaysAllRoles     = @{}
        isolationRoles     = @()
        protectedChannels  = @()
    }
    $defaultConfig | ConvertTo-Json | Set-Content "config/structure.json"
    Write-Success "Created default config/structure.json"
} else {
    Write-Success "config/structure.json exists"
}

# Check config/rules.md
Write-Step "Checking config/rules.md..."
if (-not (Test-Path "config/rules.md")) {
    Write-Warning "config/rules.md not found, creating default..."
    "# Server Rules`n`nAdd your server rules here." | Set-Content "config/rules.md"
    Write-Success "Created config/rules.md"
} else {
    Write-Success "config/rules.md exists"
}

# Build Docker image
if (-not $SkipDocker) {
    Write-Step "Building Docker image..."
    Write-Host ""
    & docker compose build --no-cache
    if ($LASTEXITCODE -ne 0) {
        Write-Error "Docker build failed"
        exit 1
    }
}

# Summary
Write-Host ""
Write-Success "Initialization complete!"
Write-Host ""
Write-Host "Next steps:" -ForegroundColor Cyan
Write-Host "  1. Edit .env if needed" -ForegroundColor White
Write-Host "  2. Start bot:      docker compose up -d" -ForegroundColor Gray
Write-Host "  3. Check logs:     docker compose logs -f" -ForegroundColor Gray
Write-Host "  4. Web panel:      http://localhost:8787" -ForegroundColor Gray
Write-Host ""
Write-Host "Useful commands:" -ForegroundColor Cyan
Write-Host "  docker compose up -d        Start in background" -ForegroundColor Gray
Write-Host "  docker compose down         Stop bot" -ForegroundColor Gray
Write-Host "  docker compose logs -f      Real-time logs" -ForegroundColor Gray
Write-Host "  docker compose restart      Restart bot" -ForegroundColor Gray
Write-Host ""

Read-Host "Press Enter to exit"
