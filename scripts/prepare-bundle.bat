@echo off
REM ─────────────────────────────────────────────────────────────────────────
REM  prepare-bundle.bat — download a pinned Node.exe into <repo>/binaries/
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
REM    - User double-clicks the file from Explorer → we detect that and
REM      pause at the end so the window doesn't slam shut.
REM ─────────────────────────────────────────────────────────────────────────

setlocal enabledelayedexpansion

REM Detect double-click launch. When Explorer runs a .bat, the cmd it
REM spawns gets `/c` in CMDCMDLINE; from an interactive shell that
REM marker isn't there. We use this to decide whether to pause before
REM exit so the user can actually read the output.
set "FROM_DOUBLECLICK="
echo %CMDCMDLINE% | findstr /I /C:" /c " >nul
if %errorlevel% equ 0 set "FROM_DOUBLECLICK=1"

REM Pinned to the latest LTS as of writing. Bump deliberately; bigger
REM Node versions sometimes change behavior of --watch / --no-warnings
REM that we rely on.
set "NODE_VERSION=v22.11.0"
set "SCRIPT_DIR=%~dp0"
REM Target is repo-root/binaries (NOT src-tauri/binaries). Tauri 2's
REM resource resolution treats paths inside src-tauri/ differently than
REM paths reached via "../", and we hit that asymmetry: nesting the
REM binaries dir under src-tauri caused node.exe to be silently
REM excluded from the bundle even though it was listed in
REM bundle.resources. Keeping it at the repo root means tauri.conf
REM resources point at "../binaries/node.exe" with the same convention
REM as "../src/**/*" and Tauri picks it up consistently.
set "TARGET_DIR=%SCRIPT_DIR%..\binaries"
set "TARGET=%TARGET_DIR%\node.exe"
set "URL=https://nodejs.org/dist/%NODE_VERSION%/win-x64/node.exe"
set "EXIT_CODE=0"

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
        set "EXIT_CODE=1"
        goto :end
    )
)

if exist "%TARGET%" (
    REM Re-validate the existing file. If it's suspiciously small, treat
    REM it as a failed previous download and redo it.
    for %%A in ("%TARGET%") do set "EXISTING_SIZE=%%~zA"
    if !EXISTING_SIZE! GEQ 1000000 (
        echo node.exe already present, size !EXISTING_SIZE! bytes.
        echo  ^(Delete the file manually if you want to force a re-download.^)
        goto :end
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
    set "EXIT_CODE=1"
    goto :end
)

echo Using downloader: !DOWNLOADER!
echo.

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
    set "EXIT_CODE=%DOWNLOAD_EXIT%"
    goto :end
)

if not exist "%TARGET%" (
    echo.
    echo ERROR: Download reported success but the file is not there.
    echo  Antivirus quarantine is the usual suspect — check your AV log.
    set "EXIT_CODE=1"
    goto :end
)

REM Sanity check — node win-x64 is ~75-90 MB. Anything under 1 MB is
REM almost certainly an HTML error page returned as 200.
for %%A in ("%TARGET%") do set "NODE_SIZE=%%~zA"
if !NODE_SIZE! LSS 1000000 (
    echo.
    echo ERROR: node.exe is only !NODE_SIZE! bytes — almost certainly not
    echo the real binary ^(perhaps an HTML 200 from a proxy^). Deleting it.
    del /F /Q "%TARGET%" 2>nul
    set "EXIT_CODE=1"
    goto :end
)

echo.
echo OK: node.exe ready at %TARGET% ^(size: !NODE_SIZE! bytes^).

:end
echo.
if defined FROM_DOUBLECLICK (
    REM Launched by double-click: hold the window open so the user can
    REM read whatever happened above. Skip the pause when invoked from
    REM an interactive shell since the output stays visible anyway.
    if "%EXIT_CODE%"=="0" (
        echo Done. Press any key to close this window.
    ) else (
        echo Finished with errors ^(exit code %EXIT_CODE%^). Press any key to close.
    )
    pause >nul
)
endlocal & exit /b %EXIT_CODE%
