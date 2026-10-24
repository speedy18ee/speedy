@echo off
setlocal

:: Set working directory to the directory of this batch file
cd /d "%~dp0"

title Discord Selfbot Multi-Account and Lavalink 24/7 Dashboard
color 0b

echo.
echo  ================================================================
echo    DISCORD SELFBOT MULTI-ACCOUNT 24/7 AND LAVALINK DASHBOARD
echo  ================================================================
echo.

:: 1. Verify Node.js
where node >nul 2>nul
if %ERRORLEVEL% neq 0 (
    color 0c
    echo [ERROR] Node.js is not found on your system!
    echo Please install Node.js LTS from https://nodejs.org
    echo.
    goto END
)

echo [OK] Node.js version:
node -v
echo.

:: 2. Check and install dependencies if node_modules is missing
if not exist "node_modules\" (
    echo [SETUP] Installing dependencies, please wait...
    call npm.cmd install
    if %ERRORLEVEL% neq 0 (
        color 0c
        echo [ERROR] npm install failed.
        goto END
    )
    echo [OK] Dependencies installed successfully.
    echo.
)

:: 3. Open browser after 2 seconds
start "" cmd /c "timeout /t 2 /nobreak >nul && start http://localhost:3000"

echo [START] Starting Web Dashboard on http://localhost:3000
echo [INFO] Keep this window OPEN while using your bots!
echo.

:: 4. Run Node server
node server.js

:END
echo.
echo ================================================================
echo Server has stopped.
echo Press any key to exit...
echo ================================================================
pause >nul
