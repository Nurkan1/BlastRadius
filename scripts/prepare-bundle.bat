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
REM ─────────────────────────────────────────────────────────────────────────

setlocal enabledelayedexpansion

REM Pinned to the latest LTS as of writing. Bump deliberately; bigger
REM Node versions sometimes change behavior of --watch / --no-warnings
REM that we rely on.
set "NODE_VERSION=v22.11.0"
set "TARGET_DIR=%~dp0..\src-tauri\binaries"
set "TARGET=%TARGET_DIR%\node.exe"
set "URL=https://nodejs.org/dist/%NODE_VERSION%/win-x64/node.exe"

if not exist "%TARGET_DIR%" (
    mkdir "%TARGET_DIR%"
)

if exist "%TARGET%" (
    echo node.exe already present at %TARGET%.
    echo  ^(Delete it manually to force a re-download.^)
    goto :done
)

echo Downloading Node.js %NODE_VERSION% (win-x64) into %TARGET% ...
echo Source: %URL%

REM Prefer curl (Win10 1803+ ships it); fall back to PowerShell.
where curl >nul 2>&1
if %errorlevel%==0 (
    curl -fSL "%URL%" -o "%TARGET%"
) else (
    powershell -NoProfile -ExecutionPolicy Bypass -Command ^
        "$ProgressPreference='SilentlyContinue'; Invoke-WebRequest -Uri '%URL%' -OutFile '%TARGET%'"
)

if not exist "%TARGET%" (
    echo.
    echo ERROR: Download failed. Verify your network and the URL above.
    exit /b 1
)

REM Sanity check — size should be a few tens of MB. If it's a few hundred
REM bytes the download probably returned an HTML error page.
for %%A in ("%TARGET%") do set "NODE_SIZE=%%~zA"
if !NODE_SIZE! LSS 1000000 (
    echo.
    echo ERROR: node.exe is only !NODE_SIZE! bytes — almost certainly not the
    echo real binary. Deleting it.
    del /Q "%TARGET%"
    exit /b 1
)

echo.
echo OK: node.exe ready at %TARGET% (size: !NODE_SIZE! bytes).

:done
endlocal
