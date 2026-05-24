<#
.SYNOPSIS
    Register the BlastRadius log-touch hook in a target project's
    .claude/settings.json under hooks.PostToolUse.

.PARAMETER ProjectPath
    Absolute or relative path to the repo where Claude Code runs (the
    repo to be observed). Mandatory.

.PARAMETER LogDir
    Absolute or relative path to the directory where the hook will
    write its daily JSONL logs. Optional; defaults to <BlastRadius
    repo>\logs. The path is baked into the hook command in
    settings.json as `--log-dir "<path>"`, so the hook no longer
    requires the BLASTRADIUS_LOG_DIR env var to be set in Claude
    Code's environment.

.DESCRIPTION
    Behavior:
      - Creates .claude/ inside ProjectPath if it does not exist.
      - Creates .claude/settings.json if it does not exist.
      - If settings.json already has hooks, they are preserved. Only a
        previous install of THIS specific hook (matcher "Edit|Write|Read"
        with a command containing log-touch.js) is replaced — so the
        script is idempotent on re-run.
      - The hook command is written with an absolute, forward-slashed
        path to src/hook/log-touch.js inside the BlastRadius repo,
        followed by `--log-dir "<absolute log dir>"`.

.EXAMPLE
    .\scripts\install-hook.ps1 -ProjectPath C:\projects\digitalrose
    .\scripts\install-hook.ps1 -ProjectPath C:\projects\digitalrose -LogDir D:\logs\blastradius
#>

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true, HelpMessage = "Absolute or relative path to the target repo")]
    [string]$ProjectPath,
    [Parameter(Mandatory = $false, HelpMessage = "Where the hook writes daily JSONL logs (default: <BlastRadius>\logs)")]
    [string]$LogDir
)

$ErrorActionPreference = 'Stop'

# ── Resolve paths ────────────────────────────────────────────────────────────

# scripts/ → repo root is one level up
$RepoRoot   = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$HookScript = Join-Path $RepoRoot 'src\hook\log-touch.js'

if (-not (Test-Path $HookScript)) {
    Write-Error "Hook script not found at $HookScript"
    exit 1
}

if (-not (Test-Path $ProjectPath)) {
    Write-Error "Project path does not exist: $ProjectPath"
    exit 1
}

$ProjectAbs   = (Resolve-Path $ProjectPath).Path
$ClaudeDir    = Join-Path $ProjectAbs '.claude'
$SettingsFile = Join-Path $ClaudeDir 'settings.json'

# Resolve the LogDir parameter. Default to <BlastRadius>\logs when
# omitted. We do NOT require the directory to exist yet — the hook
# creates it on first append, and the launcher (run.bat) creates it
# at server boot too. Resolve to absolute so the bake-in is portable
# (the user can rename the BlastRadius checkout without breaking the
# hook).
if (-not $LogDir) {
    $LogDir = Join-Path $RepoRoot 'logs'
}
# Resolve-Path requires the path to exist; we want to allow non-existent
# paths so we normalize manually with [IO.Path]::GetFullPath, which is
# purely lexical (no FS access) but respects the working directory for
# relative inputs.
$LogDirAbs = [System.IO.Path]::GetFullPath($LogDir)
$LogDirFwd = $LogDirAbs -replace '\\', '/'

# ── Load or initialize settings.json ─────────────────────────────────────────

if (-not (Test-Path $ClaudeDir)) {
    New-Item -ItemType Directory -Path $ClaudeDir | Out-Null
    Write-Host "Created $ClaudeDir"
}

if (Test-Path $SettingsFile) {
    $raw = Get-Content $SettingsFile -Raw -ErrorAction Stop
    if ([string]::IsNullOrWhiteSpace($raw)) {
        $settings = [pscustomobject]@{}
    } else {
        $settings = $raw | ConvertFrom-Json
    }
} else {
    $settings = [pscustomobject]@{}
}

# ── Helper: ensure a property exists with a default value ───────────────────

function Ensure-Property {
    param(
        [Parameter(Mandatory = $true)] $Object,
        [Parameter(Mandatory = $true)] [string]$Name,
        [Parameter(Mandatory = $true)] $Default
    )
    if (-not $Object.PSObject.Properties[$Name]) {
        $Object | Add-Member -NotePropertyName $Name -NotePropertyValue $Default
    }
    return $Object.$Name
}

# ── Merge in our hook entry without clobbering existing ones ────────────────

Ensure-Property -Object $settings -Name 'hooks' -Default ([pscustomobject]@{}) | Out-Null
Ensure-Property -Object $settings.hooks -Name 'PostToolUse' -Default @() | Out-Null

$ourMatcher = 'Edit|Write|Read'
# Bake the log dir into the command itself so the hook works without
# any environment variables. Quoting is JSON-escape-safe because the
# whole string lands inside ConvertTo-Json which re-escapes \" → \\\".
$hookCommand = 'node "{0}" --log-dir "{1}"' -f ($HookScript -replace '\\', '/'), $LogDirFwd

# Walk existing PostToolUse entries; preserve everything EXCEPT a prior
# install of our own hook (matched by command path).
$preserved = @()
foreach ($entry in @($settings.hooks.PostToolUse)) {
    if ($null -eq $entry) { continue }

    $isOurMatcher = $entry.PSObject.Properties['matcher'] -and $entry.matcher -eq $ourMatcher
    $hasOurCommand = $false
    if ($entry.PSObject.Properties['hooks']) {
        foreach ($h in @($entry.hooks)) {
            if ($h.PSObject.Properties['command'] -and $h.command -like '*log-touch.js*') {
                $hasOurCommand = $true
                break
            }
        }
    }
    if (-not ($isOurMatcher -and $hasOurCommand)) {
        $preserved += $entry
    }
}

$ourEntry = [pscustomobject]@{
    matcher = $ourMatcher
    hooks   = @(
        [pscustomobject]@{
            type    = 'command'
            command = $hookCommand
        }
    )
}

$settings.hooks.PostToolUse = @($preserved) + $ourEntry

# ── Write back ───────────────────────────────────────────────────────────────

$json = $settings | ConvertTo-Json -Depth 12

# Force UTF-8 without BOM for cross-platform compatibility with Claude
# Code's settings parser.
$utf8NoBom = [System.Text.UTF8Encoding]::new($false)
[System.IO.File]::WriteAllText($SettingsFile, $json, $utf8NoBom)

# ── Report ───────────────────────────────────────────────────────────────────

Write-Host ""
Write-Host "BlastRadius hook registered" -ForegroundColor Green
Write-Host "  settings  : $SettingsFile"
Write-Host "  matcher   : $ourMatcher"
Write-Host "  log dir   : $LogDirAbs"
Write-Host "  command   : $hookCommand"
Write-Host ""
Write-Host "The log directory is baked into the hook command." -ForegroundColor Cyan
Write-Host "No environment variable is required for new Claude Code sessions."
Write-Host ""
Write-Host "IMPORTANT: Claude Code reads .claude/settings.json only at session start." -ForegroundColor Yellow
Write-Host "Restart any Claude Code instance you have open in '$ProjectAbs' for the hook to take effect."
Write-Host ""
