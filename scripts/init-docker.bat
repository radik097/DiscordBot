@echo off
setlocal enabledelayedexpansion

echo Discord Bot Docker Setup (Windows)
echo ======================================

REM Check Docker
where docker >nul 2>nul
if %ERRORLEVEL% NEQ 0 (
    echo ERROR: Docker not installed. Install Docker Desktop for Windows.
    pause
    exit /b 1
)

REM Get project directory
set "PROJECT_DIR=%~dp0.."
cd /d "%PROJECT_DIR%"

REM Check .env
if not exist ".env" (
    echo Creating .env from .env.example...
    copy ".env.example" ".env" >nul
    echo WARNING: Edit .env with your settings:
    echo   - DISCORD_TOKEN
    echo   - CLIENT_ID
    echo   - GUILD_ID
    pause
    exit /b 1
)

echo Configuration verified

REM Create directories
echo Creating directories...
if not exist "config" mkdir config
if not exist "data" mkdir data
if not exist "logs" mkdir logs

REM Check config/structure.json
if not exist "config\structure.json" (
    echo WARNING: config\structure.json not found. Creating empty config...
    (
        echo {
        echo   "roles": [],
        echo   "categories": [],
        echo   "channels": [],
        echo   "musicAllowedRoles": []
        echo }
    ) > "config\structure.json"
)

REM Check config/rules.md
if not exist "config\rules.md" (
    echo WARNING: config\rules.md not found. Creating empty file...
    echo Server Rules > "config\rules.md"
)

echo Building Docker image...
docker compose build --no-cache

echo.
echo Initialization complete!
echo.
echo Next steps:
echo 1. Edit .env if needed
echo 2. Start bot: docker compose up -d
echo 3. Check logs: docker compose logs -f
echo 4. Open web panel: http://localhost:8787
echo.
echo Useful commands:
echo   docker compose up -d       - Start in background
echo   docker compose down        - Stop
echo   docker compose logs -f     - Real-time logs
echo   docker compose restart     - Restart
echo.
pause
