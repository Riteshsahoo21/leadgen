@echo off
setlocal
cd /d "%~dp0\.."

set ACTION=%1
if "%ACTION%"=="" set ACTION=start

if not exist .env (
    echo [ERROR] .env file is missing in the project root.
    exit /b 1
)

if "%ACTION%"=="start" (
    echo Starting LeadForge local stack...
    docker compose -f compose.yml -f compose.local.yml up -d --build
    echo LeadForge dashboard available at: http://localhost:8088
    exit /b 0
)

if "%ACTION%"=="stop" (
    echo Stopping LeadForge local stack...
    docker compose -f compose.yml -f compose.local.yml stop
    exit /b 0
)

if "%ACTION%"=="down" (
    echo Taking down LeadForge local stack...
    docker compose -f compose.yml -f compose.local.yml down
    exit /b 0
)

if "%ACTION%"=="status" (
    docker compose -f compose.yml -f compose.local.yml ps
    exit /b 0
)

if "%ACTION%"=="logs" (
    docker compose -f compose.yml -f compose.local.yml logs -f api worker
    exit /b 0
)

echo Usage: scripts\local.bat [start|stop|down|status|logs]
exit /b 1
