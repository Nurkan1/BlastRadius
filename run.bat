@echo off
REM ─────────────────────────────────────────────────────────────────────────
REM  BlastRadius launcher — clean state + start the dashboard server.
REM
REM  What this does:
REM    1. Kills any stray BlastRadius server already listening on the port.
REM    2. (Optional) Wipes ~/.blastradius/preferences.json so the wizard
REM       runs from scratch — set CLEAN=1 in the command line to enable.
REM    3. Ensures the log directory exists.
REM    4. Starts the server. Logs stream to this terminal.
REM
REM  Usage:
REM    start.bat                  ← just start (keep prefs + log)
REM    start.bat CLEAN=1          ← wipe prefs + logs, then start
REM    start.bat PORT=7900        ← custom port
REM    start.bat CLEAN=1 PORT=7900
REM
REM  Defaults match the env conventions in .env.example.
REM ─────────────────────────────────────────────────────────────────────────

setlocal enabledelayedexpansion

REM ── Defaults ──────────────────────────────────────────────────────────
set "PORT=7842"
set "LOG_DIR=%~dp0logs"
set "CLEAN=0"

REM ── Parse args (KEY=VALUE style) ──────────────────────────────────────
:parse_args
if "%~1"=="" goto args_done
for /f "tokens=1,2 delims==" %%a in ("%~1") do (
    set "KEY=%%a"
    set "VAL=%%b"
)
if /i "!KEY!"=="PORT"     set "PORT=!VAL!"
if /i "!KEY!"=="LOG_DIR"  set "LOG_DIR=!VAL!"
if /i "!KEY!"=="CLEAN"    set "CLEAN=!VAL!"
shift
goto parse_args
:args_done

echo.
echo === BlastRadius launcher ===
echo  Port:    %PORT%
echo  LogDir:  %LOG_DIR%
echo  Clean:   %CLEAN%
echo.

REM ── Step 1: kill any process listening on the port ────────────────────
echo [1/4] Checking for stale server on port %PORT% ...
for /f "tokens=5" %%p in ('netstat -ano ^| findstr ":%PORT% " ^| findstr LISTENING') do (
    echo       Killing PID %%p
    taskkill /PID %%p /F >nul 2>&1
)

REM ── Step 2: clean state if requested ─────────────────────────────────
if "%CLEAN%"=="1" (
    echo [2/4] Cleaning state ^(--clean^) ...
    if exist "%USERPROFILE%\.blastradius\preferences.json" (
        del /Q "%USERPROFILE%\.blastradius\preferences.json"
        echo       Removed preferences.json ^(wizard will run again^)
    )
    if exist "%LOG_DIR%" (
        del /Q "%LOG_DIR%\session-*.jsonl" 2>nul
        echo       Cleared JSONL logs
    )
) else (
    echo [2/4] Keeping existing preferences + logs ^(pass CLEAN=1 to wipe^)
)

REM ── Step 3: ensure log dir exists ─────────────────────────────────────
if not exist "%LOG_DIR%" (
    mkdir "%LOG_DIR%"
    echo [3/4] Created log directory: %LOG_DIR%
) else (
    echo [3/4] Log directory exists: %LOG_DIR%
)

REM ── Step 4: launch the server ─────────────────────────────────────────
echo [4/4] Starting BlastRadius server ...
echo.
echo  Open http://localhost:%PORT% in your browser when ready.
echo  Press Ctrl+C here to stop.
echo.

set "BLASTRADIUS_LOG_DIR=%LOG_DIR%"
set "BLASTRADIUS_PORT=%PORT%"
set "BLASTRADIUS_LOG_LEVEL=info"

cd /d "%~dp0"
node src\server\index.js

endlocal
