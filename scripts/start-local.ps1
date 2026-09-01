[CmdletBinding()]
param(
    [switch]$DeployCommands,
    [switch]$SkipInstall
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

function Get-BunExecutable {
    $command = Get-Command bun -ErrorAction SilentlyContinue
    if ($command) { return $command.Source }
    $userInstall = Join-Path $env:USERPROFILE ".bun\bin\bun.exe"
    if (Test-Path -LiteralPath $userInstall) { return $userInstall }
    throw "Bun не найден. Установите Bun и повторите запуск."
}

$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$botExitCode = 0
Push-Location $projectRoot
try {
    if (-not (Test-Path -LiteralPath ".env")) {
        Copy-Item -LiteralPath ".env.example" -Destination ".env"
        throw "Создан .env. Заполните DISCORD_TOKEN и CLIENT_ID, затем запустите скрипт снова."
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

    $bun = Get-BunExecutable
    if (-not $SkipInstall) {
        & $bun install --frozen-lockfile
        if ($LASTEXITCODE -ne 0) { throw "Bun не смог установить зависимости." }
    }

    $localYtDlp = @("bin/yt-dlp.exe", "bin/yt-dlp") | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
    if (-not $localYtDlp -and -not (Get-Command yt-dlp -ErrorAction SilentlyContinue)) {
        Write-Warning "yt-dlp не найден в PATH или bin/. Бот запустится, но YouTube-функции будут недоступны."
    }
    Write-Warning "Без Docker Cobalt и Whisper worker нужно запускать отдельно и указывать через COBALT_API_URL и TRANSCRIPTION_WORKER_URL."

    if ($DeployCommands) {
        & $bun run src/deploy-commands.js
        if ($LASTEXITCODE -ne 0) { throw "Не удалось зарегистрировать Discord-команды." }
    }

    Write-Host "Запускаю DiscordBot в foreground. Для остановки нажмите Ctrl+C." -ForegroundColor Green
    & $bun run src/index.js
    $botExitCode = $LASTEXITCODE
} finally {
    Pop-Location
}

exit $botExitCode
