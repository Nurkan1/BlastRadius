<#
.SYNOPSIS
    Register the BlastRadius log-touch hook in a target project's
    .claude/settings.json under hooks.PostToolUse.

.PARAMETER ProjectPath
    Absolute or relative path to the repo where Claude Code runs (the
    repo to be observed). Mandatory.

.DESCRIPTION
    Behavior:
      - Creates .claude/ inside ProjectPath if it does not exist.
      - Creates .claude/settings.json if it does not exist.
      - If settings.json already has hooks, they are preserved. Only a
        previous install of THIS specific hook (matcher "Edit|Write|Read"
        with a command ending in log-touch.js) is replaced — so the
        script is idempotent on re-run.
      - The hook command is written with an absolute, forward-slashed
        path to src/hook/log-touch.js inside the BlastRadius repo.

.EXAMPLE
    .\scripts\install-hook.ps1 -ProjectPath C:\projects\digitalrose
#>

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true, HelpMessage = "Absolute or relative path to the target repo")]
    [string]$ProjectPath
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
$hookCommand = 'node "{0}"' -f ($HookScript -replace '\\', '/')

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
Write-Host "  command   : $hookCommand"
Write-Host ""
Write-Host "Set BLASTRADIUS_LOG_DIR before launching Claude Code, e.g.:" -ForegroundColor Yellow
Write-Host "  `$env:BLASTRADIUS_LOG_DIR = '$RepoRoot\logs'"
Write-Host ""
