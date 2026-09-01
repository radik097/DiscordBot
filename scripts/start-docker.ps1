[CmdletBinding()]
param(
    [switch]$DeployCommands,
    [switch]$FollowLogs,
    [switch]$NoBuild
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Get-DotEnvValue {
    param([Parameter(Mandatory)][string]$Name)

    $line = Get-Content -LiteralPath ".env" | Where-Object {
        $_ -match "^\s*$([Regex]::Escape($Name))\s*="
    } | Select-Object -First 1
    if (-not $line) { return "" }
    return (($line -split "=", 2)[1].Trim()).Trim('"').Trim("'")
}

$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
Push-Location $projectRoot
try {
    if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
        throw "Docker не найден. Установите Docker Desktop или Docker Engine."
    }
    & docker compose version *> $null
    if ($LASTEXITCODE -ne 0) { throw "Docker Compose plugin недоступен." }

    if (-not (Test-Path -LiteralPath ".env")) {
        Copy-Item -LiteralPath ".env.example" -Destination ".env"
        throw "Создан .env. Заполните DISCORD_TOKEN, CLIENT_ID и другие параметры, затем запустите скрипт снова."
    }
    foreach ($name in @("DISCORD_TOKEN", "CLIENT_ID")) {
        if ([string]::IsNullOrWhiteSpace((Get-DotEnvValue $name))) {
            throw "В .env не заполнена обязательная переменная $name."
        }
    }

    foreach ($directory in @("data", "logs")) {
        New-Item -ItemType Directory -Force -Path $directory | Out-Null
    }
    if (-not (Test-Path -LiteralPath "config/structure.json")) {
        Copy-Item -LiteralPath "config/structure.example.json" -Destination "config/structure.json"
        Write-Host "Создан config/structure.json из публичного шаблона." -ForegroundColor Yellow
    }

    $compose = @("compose", "-p", "discordbot", "--env-file", ".env", "-f", "docker-compose.yml")
    $profiles = (Get-DotEnvValue "COMPOSE_PROFILES") -split "," | ForEach-Object { $_.Trim() } | Where-Object { $_ }
    foreach ($profile in $profiles) { $compose += @("--profile", $profile) }

    $up = @("up", "-d")
    if (-not $NoBuild) { $up += "--build" }
    & docker @compose @up
    if ($LASTEXITCODE -ne 0) { throw "Docker Compose не смог запустить сервисы." }

    if ($DeployCommands) {
        & docker @compose exec -T discord-bot bun run src/deploy-commands.js
        if ($LASTEXITCODE -ne 0) { throw "Не удалось зарегистрировать Discord-команды." }
    }

    & docker @compose ps
    $webPort = Get-DotEnvValue "WEB_PORT"
    if ([string]::IsNullOrWhiteSpace($webPort)) { $webPort = "8787" }
    Write-Host "Панель: http://127.0.0.1:$webPort" -ForegroundColor Green
    if ($FollowLogs) { & docker @compose logs -f discord-bot }
} finally {
    Pop-Location
}
