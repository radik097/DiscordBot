# Launcher used by the "DiscordBotArchivarus" scheduled task (auto-start on logon).
# Keeps the bot running: restarts it automatically if it crashes/exits, logs to data\bot.log.

$ProjectRoot = Split-Path -Parent $PSScriptRoot
$BunExe = "$env:USERPROFILE\.bun\bin\bun.exe"
$LogFile = Join-Path $ProjectRoot "data\bot.log"

New-Item -ItemType Directory -Force -Path (Join-Path $ProjectRoot "data") | Out-Null
Set-Location $ProjectRoot

$Utf8NoBom = New-Object System.Text.UTF8Encoding($false)

function Write-Log([string]$Message) {
    $timestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    [System.IO.File]::AppendAllText($LogFile, "[$timestamp] $Message`n", $Utf8NoBom)
}

while ($true) {
    Write-Log "--- Запуск бота ---"

    # PowerShell's *>> redirection writes UTF-16LE by default, which garbles
    # Cyrillic when read back as UTF-8 (e.g. via `cat`/`tail`). Pipe through
    # Out-File -Encoding utf8 instead so the log stays valid UTF-8.
    & $BunExe run src/index.js 2>&1 | Out-File -FilePath $LogFile -Append -Encoding utf8

    Write-Log "Бот завершился (код $LASTEXITCODE), перезапуск через 10с..."
    Start-Sleep -Seconds 10
}
