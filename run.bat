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

REM ── Step 1: kill any stray BlastRadius server ─────────────────────────
REM
REM  Three-layer cleanup. None of these alone is sufficient because:
REM    a) A zombie node (closed window, orphaned process) isn't
REM       LISTENING anymore so the netstat sweep misses it.
REM    b) A previous run that crashed before binding the port has no
REM       PID in netstat either.
REM    c) PID file can go stale if a previous server was killed via
REM       Task Manager without running its shutdown handler.
REM
REM  Order: PID file → command-line match → port listener. Each layer
REM  catches what the previous one missed. After all three we pause
REM  briefly so Windows can release the TCP socket from TIME_WAIT.

echo [1/4] Stopping any previous BlastRadius server ...

REM (a) Kill the PID recorded by the previous server, if any. Wrapped
REM     in `exist` so a fresh install doesn't error out.
set "PID_FILE=%USERPROFILE%\.blastradius\server.pid"
if exist "%PID_FILE%" (
    set /p PREV_PID=<"%PID_FILE%"
    if not "!PREV_PID!"=="" (
        echo       Killing PID !PREV_PID! ^(from PID file^)
        taskkill /PID !PREV_PID! /F >nul 2>&1
    )
    del /Q "%PID_FILE%" >nul 2>&1
)

REM (b) Kill anything else running `node src\server\index.js`. We use
REM     PowerShell because cmd's wmic syntax is fragile around quoting
REM     and is deprecated in Windows 11. The filter is exact enough
REM     that we won't hit unrelated node processes (Claude Code,
REM     other MCP servers, etc.).
powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" 2>$null | Where-Object { $_.CommandLine -like '*src\server\index.js*' } | ForEach-Object { Write-Host ('      Killing PID ' + $_.ProcessId + ' (commandline match)'); Stop-Process -Id $_.ProcessId -Force }" 2>nul

REM (c) Belt-and-suspenders: anything still LISTENING on the port.
for /f "tokens=5" %%p in ('netstat -ano ^| findstr ":%PORT% " ^| findstr LISTENING') do (
    echo       Killing PID %%p ^(port listener^)
    taskkill /PID %%p /F >nul 2>&1
)

REM Brief pause so the OS releases the TCP socket before we try to
REM bind it. 1 s is plenty for TIME_WAIT to clear on localhost.
timeout /t 1 /nobreak >nul 2>&1

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
