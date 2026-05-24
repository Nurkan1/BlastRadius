@echo off
REM ─────────────────────────────────────────────────────────────────────────
REM  prepare-bundle.bat — download a pinned Node.exe into src-tauri/binaries/
REM
REM  Why: BlastRadius's Tauri build packages a Node.js server as a sidecar.
REM  We bundle a pinned node.exe so the installed app doesn't depend on the
REM  end user having Node installed in PATH. This script downloads that
REM  binary into the location the Rust side-car loader expects.
REM
REM  Re-run any time you bump NODE_VERSION below.
REM
REM  Common failure modes and what we do about them:
REM    - curl missing → fall back to PowerShell
REM    - PowerShell blocked by execution policy → use -ExecutionPolicy Bypass
REM    - Antivirus quarantines the binary right after download → we re-check
REM      the file exists AND is at least 1 MB before declaring success
REM    - Caller invokes the script from a weird cwd → all paths anchored to
REM      %~dp0 (the script's own directory)
REM ─────────────────────────────────────────────────────────────────────────

setlocal enabledelayedexpansion

REM Pinned to the latest LTS as of writing. Bump deliberately; bigger
REM Node versions sometimes change behavior of --watch / --no-warnings
REM that we rely on.
set "NODE_VERSION=v22.11.0"
set "SCRIPT_DIR=%~dp0"
set "TARGET_DIR=%SCRIPT_DIR%..\src-tauri\binaries"
set "TARGET=%TARGET_DIR%\node.exe"
set "URL=https://nodejs.org/dist/%NODE_VERSION%/win-x64/node.exe"

echo.
echo === BlastRadius bundle prep ===
echo  Node version:  %NODE_VERSION%
echo  Target file:   %TARGET%
echo  Source URL:    %URL%
echo.

if not exist "%TARGET_DIR%" (
    echo Creating directory: %TARGET_DIR%
    mkdir "%TARGET_DIR%" 2>nul
    if not exist "%TARGET_DIR%" (
        echo.
        echo ERROR: Could not create %TARGET_DIR%.
        echo  ^(Check that you have write permission to this folder.^)
        exit /b 1
    )
)

if exist "%TARGET%" (
    REM Re-validate the existing file. If it's suspiciously small, treat
    REM it as a failed previous download and redo it.
    for %%A in ("%TARGET%") do set "EXISTING_SIZE=%%~zA"
    if !EXISTING_SIZE! GEQ 1000000 (
        echo node.exe already present, size !EXISTING_SIZE! bytes.
        echo  ^(Delete the file manually if you want to force a re-download.^)
        goto :done
    )
    echo Existing node.exe is only !EXISTING_SIZE! bytes — looks corrupt.
    echo Deleting and retrying ...
    del /F /Q "%TARGET%" 2>nul
)

REM Pick a downloader. Try curl first (Win10 1803+ ships it; smaller cmd
REM line, friendlier progress output). Fall back to PowerShell.
set "DOWNLOADER="
where curl >nul 2>&1
if %errorlevel% equ 0 set "DOWNLOADER=curl"
if not defined DOWNLOADER (
    where powershell >nul 2>&1
    if %errorlevel% equ 0 set "DOWNLOADER=powershell"
)

if not defined DOWNLOADER (
    echo.
    echo ERROR: Neither `curl` nor `powershell` is available on PATH.
    echo  Please install one of them, or download the file manually:
    echo    %URL%
    echo  and place it at:
    echo    %TARGET%
    exit /b 1
)

echo Using downloader: !DOWNLOADER!

if /i "!DOWNLOADER!"=="curl" (
    curl -fSL --retry 3 --retry-delay 2 "%URL%" -o "%TARGET%"
) else (
    powershell -NoProfile -ExecutionPolicy Bypass -Command ^
        "$ProgressPreference='SilentlyContinue'; try { Invoke-WebRequest -Uri '%URL%' -OutFile '%TARGET%' -UseBasicParsing -ErrorAction Stop; exit 0 } catch { Write-Host ('Download error: ' + $_.Exception.Message); exit 1 }"
)

set "DOWNLOAD_EXIT=%errorlevel%"
if not %DOWNLOAD_EXIT% equ 0 (
    echo.
    echo ERROR: Downloader exited with code %DOWNLOAD_EXIT%.
    echo  Common causes: no network, a corporate proxy intercepting the
    echo  connection, or an antivirus blocking the binary mid-stream.
    if exist "%TARGET%" del /F /Q "%TARGET%" 2>nul
    exit /b %DOWNLOAD_EXIT%
)

if not exist "%TARGET%" (
    echo.
    echo ERROR: Download reported success but the file is not there.
    echo  Antivirus quarantine is the usual suspect — check your AV log.
    exit /b 1
)

REM Sanity check — node win-x64 is ~75-90 MB. Anything under 1 MB is
REM almost certainly an HTML error page returned as 200.
for %%A in ("%TARGET%") do set "NODE_SIZE=%%~zA"
if !NODE_SIZE! LSS 1000000 (
    echo.
    echo ERROR: node.exe is only !NODE_SIZE! bytes — almost certainly not
    echo the real binary ^(perhaps an HTML 200 from a proxy^). Deleting it.
    del /F /Q "%TARGET%" 2>nul
    exit /b 1
)

echo.
echo OK: node.exe ready at %TARGET% ^(size: !NODE_SIZE! bytes^).

:done
echo.
endlocal
exit /b 0
