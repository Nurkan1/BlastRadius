<#
.SYNOPSIS
    Install the BlastRadius observability hook in a target project.

.PARAMETER ProjectPath
    Absolute or relative path to the repo to be observed. Mandatory.

.PARAMETER Agent
    Which agent's hook to install. One of:
      - claude       (default — Claude Code via .claude/settings.json)
      - antigravity  (Google Antigravity via .agents/plugins/blastradius/)
      - both         (install both side-by-side)

.PARAMETER LogDir
    Absolute or relative path to the directory where the hook writes
    its daily JSONL logs. Optional; defaults to <BlastRadius repo>\logs.
    Baked into the Claude hook command so no env var is needed at run
    time. The Antigravity hook reads the same dir via the
    BLASTRADIUS_LOG_DIR environment variable (set by the launcher or
    by the user); see templates/antigravity/README.md.

.PARAMETER DryRun
    Print the actions that WOULD be taken (created / updated /
    backed-up / unchanged) without writing anything. Crucial sanity
    check before running this script against many repos.

.PARAMETER Force
    Skip the automatic .bak.<TIMESTAMP> backup when overwriting an
    existing file whose contents differ from the template. By default
    every overwrite creates a timestamped backup so the user can
    recover their previous configuration. -Force is the explicit
    opt-out for users who want clean updates without accumulating
    backup files.

.DESCRIPTION
    Behavior contract (committed in docs/antigravity-audit.md):

      Idempotent over diff. Every file the installer touches goes
      through Write-FileIdempotent, which:
        - Creates the file if missing                       → CREATED
        - Leaves it alone if contents match exactly         → UNCHANGED
        - Backs up + overwrites if contents differ          → UPDATED
                                                              (+ BACKED-UP)
        - Skips the backup when -Force is set               → UPDATED (force)
        - With -DryRun, only PRINTS the action it would take

    Output is verbose by design: every file gets a status line so the
    user can audit what changed before / after running the script.

    -Agent claude (default, backward compatible):
      Reads / writes ProjectPath/.claude/settings.json. Only a PRIOR
      install of THIS hook (matcher "Edit|Write|Read" with command
      path containing log-touch.js) is replaced — other hooks the user
      has registered are preserved.

    -Agent antigravity:
      Creates ProjectPath/.agents/plugins/blastradius/ with:
        plugin.json                 (from templates/antigravity/)
        log-touch-antigravity.js    (from src/hook/)
        log-touch.js                (sibling, needed by the import)
        hooks/hooks.json            (from templates/antigravity/hooks/)

      Antigravity does NOT hot-reload hooks.json. The script prints a
      reminder to run `/reload` in the agent for changes to take
      effect.

    -Agent both:
      Run both flows in order. Each is independently idempotent.

.EXAMPLE
    .\scripts\install-hook.ps1 -ProjectPath C:\projects\myrepo

.EXAMPLE
    .\scripts\install-hook.ps1 -ProjectPath C:\projects\myrepo -Agent antigravity

.EXAMPLE
    .\scripts\install-hook.ps1 -ProjectPath C:\projects\myrepo -Agent both -DryRun

.EXAMPLE
    .\scripts\install-hook.ps1 -ProjectPath C:\projects\myrepo -Force
#>

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true, HelpMessage = "Absolute or relative path to the target repo")]
    [string]$ProjectPath,

    [Parameter(Mandatory = $false)]
    [ValidateSet('claude', 'antigravity', 'both')]
    [string]$Agent = 'claude',

    [Parameter(Mandatory = $false, HelpMessage = "Where the hook writes daily JSONL logs (default: <BlastRadius>\logs)")]
    [string]$LogDir,

    [Parameter(Mandatory = $false, HelpMessage = "Show planned actions without writing anything")]
    [switch]$DryRun,

    [Parameter(Mandatory = $false, HelpMessage = "Overwrite without creating a .bak backup")]
    [switch]$Force
)

$ErrorActionPreference = 'Stop'

# ─── Repo + path resolution ─────────────────────────────────────────────────

$RepoRoot   = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$HookScriptClaude       = Join-Path $RepoRoot 'src\hook\log-touch.js'
$HookScriptAntigravity  = Join-Path $RepoRoot 'src\hook\log-touch-antigravity.js'
$TemplatesDir           = Join-Path $RepoRoot 'templates\antigravity'

if (-not (Test-Path $HookScriptClaude)) {
    Write-Error "Claude hook script not found at $HookScriptClaude"
    exit 1
}
if (($Agent -eq 'antigravity' -or $Agent -eq 'both') -and -not (Test-Path $HookScriptAntigravity)) {
    Write-Error "Antigravity hook script not found at $HookScriptAntigravity (did you commit log-touch-antigravity.js?)"
    exit 1
}
if (($Agent -eq 'antigravity' -or $Agent -eq 'both') -and -not (Test-Path $TemplatesDir)) {
    Write-Error "Antigravity templates dir not found at $TemplatesDir"
    exit 1
}
if (-not (Test-Path $ProjectPath)) {
    Write-Error "Project path does not exist: $ProjectPath"
    exit 1
}

$ProjectAbs = (Resolve-Path $ProjectPath).Path

# Resolve LogDir lexically (it may not exist yet).
if (-not $LogDir) { $LogDir = Join-Path $RepoRoot 'logs' }
$LogDirAbs = [System.IO.Path]::GetFullPath($LogDir)
$LogDirFwd = $LogDirAbs -replace '\\', '/'

# Encoding for every file we write — UTF-8 without BOM (Claude Code's
# JSON parser and Node's `fs.readFileSync` both choke on a leading BOM).
$Utf8NoBom = [System.Text.UTF8Encoding]::new($false)

# ─── Helpers ────────────────────────────────────────────────────────────────

function Get-Timestamp {
    # Filename-safe local timestamp (no colons, no spaces).
    (Get-Date).ToString('yyyyMMdd-HHmmss')
}

function Write-Action {
    # One-line status entry. Columns: status, path, optional note.
    param(
        [Parameter(Mandatory)][string]$Status,
        [Parameter(Mandatory)][string]$Path,
        [string]$Note = ''
    )
    $color = switch ($Status) {
        'CREATED'    { 'Green' }
        'UPDATED'    { 'Yellow' }
        'BACKED-UP'  { 'DarkYellow' }
        'UNCHANGED'  { 'DarkGray' }
        'WOULD-CREATE' { 'Cyan' }
        'WOULD-UPDATE' { 'Cyan' }
        'WOULD-SKIP'   { 'DarkGray' }
        default      { 'White' }
    }
    $line = ('  {0,-14} {1}' -f $Status, $Path)
    if ($Note) { $line = "$line  ($Note)" }
    Write-Host $line -ForegroundColor $color
}

function Write-FileIdempotent {
    <#
    Core idempotent writer. Decides among CREATED / UNCHANGED / UPDATED
    by comparing the requested content against what is on disk.

    On UPDATE, the existing file is first copied to
    `<path>.bak.<YYYYMMDD-HHMMSS>` unless -Force was passed by the
    caller. Backup is only written when contents actually differ — a
    no-op run leaves the directory tree byte-identical.

    Honors $DryRun and $Force from the surrounding scope.
    #>
    param(
        [Parameter(Mandatory)][string]$Path,
        [Parameter(Mandatory)][string]$Content
    )

    if (-not (Test-Path $Path)) {
        if ($DryRun) {
            Write-Action 'WOULD-CREATE' $Path
        } else {
            $parent = Split-Path $Path -Parent
            if ($parent -and -not (Test-Path $parent)) {
                New-Item -ItemType Directory -Path $parent -Force | Out-Null
            }
            [System.IO.File]::WriteAllText($Path, $Content, $Utf8NoBom)
            Write-Action 'CREATED' $Path
        }
        return
    }

    # Existing file — compare contents (raw, byte-for-byte after UTF-8
    # decode). We deliberately do NOT normalize line endings: any
    # difference between our template and the file on disk is a real
    # diff worth backing up.
    $existing = [System.IO.File]::ReadAllText($Path, $Utf8NoBom)
    if ($existing -eq $Content) {
        Write-Action 'UNCHANGED' $Path
        return
    }

    if ($DryRun) {
        if ($Force) {
            Write-Action 'WOULD-UPDATE' $Path 'force, no backup'
        } else {
            Write-Action 'WOULD-UPDATE' $Path 'with .bak backup'
        }
        return
    }

    # Real diff, real overwrite.
    if (-not $Force) {
        $stamp  = Get-Timestamp
        $backup = "$Path.bak.$stamp"
        Copy-Item -Path $Path -Destination $backup -Force
        Write-Action 'BACKED-UP' $backup
    }
    [System.IO.File]::WriteAllText($Path, $Content, $Utf8NoBom)
    Write-Action 'UPDATED' $Path $(if ($Force) { 'force' } else { 'backup written' })
}

# ─── Claude installer ───────────────────────────────────────────────────────

function Install-ClaudeHook {
    Write-Host ''
    Write-Host '== Claude Code hook ==' -ForegroundColor White

    $ClaudeDir    = Join-Path $ProjectAbs '.claude'
    $SettingsFile = Join-Path $ClaudeDir 'settings.json'

    # Load existing settings (preserve other hooks the user has).
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

    if (-not $settings.PSObject.Properties['hooks']) {
        $settings | Add-Member -NotePropertyName 'hooks' -NotePropertyValue ([pscustomobject]@{})
    }
    if (-not $settings.hooks.PSObject.Properties['PostToolUse']) {
        $settings.hooks | Add-Member -NotePropertyName 'PostToolUse' -NotePropertyValue @()
    }

    $ourMatcher  = 'Edit|Write|Read'
    $hookCommand = 'node "{0}" --log-dir "{1}"' -f ($HookScriptClaude -replace '\\', '/'), $LogDirFwd

    # Drop any prior install of THIS hook; preserve everything else.
    $preserved = @()
    foreach ($entry in @($settings.hooks.PostToolUse)) {
        if ($null -eq $entry) { continue }
        $isOur = $entry.PSObject.Properties['matcher'] -and $entry.matcher -eq $ourMatcher
        $hasOurCmd = $false
        if ($entry.PSObject.Properties['hooks']) {
            foreach ($h in @($entry.hooks)) {
                if ($h.PSObject.Properties['command'] -and $h.command -like '*log-touch.js*') {
                    $hasOurCmd = $true; break
                }
            }
        }
        if (-not ($isOur -and $hasOurCmd)) { $preserved += $entry }
    }

    $ourEntry = [pscustomobject]@{
        matcher = $ourMatcher
        hooks   = @(
            [pscustomobject]@{ type = 'command'; command = $hookCommand }
        )
    }
    $settings.hooks.PostToolUse = @($preserved) + $ourEntry

    $json = $settings | ConvertTo-Json -Depth 12

    Write-FileIdempotent -Path $SettingsFile -Content $json

    Write-Host ''
    Write-Host "  matcher : $ourMatcher"     -ForegroundColor DarkGray
    Write-Host "  log dir : $LogDirAbs"      -ForegroundColor DarkGray
    Write-Host "  command : $hookCommand"    -ForegroundColor DarkGray
    Write-Host ''
    Write-Host '  IMPORTANT: Claude Code reads .claude/settings.json only at session start.' -ForegroundColor Yellow
    Write-Host "  Restart any Claude Code session open in '$ProjectAbs' for the hook to take effect." -ForegroundColor Yellow
}

# ─── Antigravity installer ──────────────────────────────────────────────────

function Install-AntigravityHook {
    Write-Host ''
    Write-Host '== Antigravity hook ==' -ForegroundColor White

    $PluginDir    = Join-Path $ProjectAbs '.agents\plugins\blastradius'
    $HooksDir     = Join-Path $PluginDir 'hooks'

    # 1. plugin.json (from template, verbatim)
    $pluginManifestSrc  = Join-Path $TemplatesDir 'plugin.json'
    $pluginManifestDest = Join-Path $PluginDir 'plugin.json'
    $pluginManifestContent = [System.IO.File]::ReadAllText($pluginManifestSrc, $Utf8NoBom)
    Write-FileIdempotent -Path $pluginManifestDest -Content $pluginManifestContent

    # 2. hooks/hooks.json (from template, verbatim — ${PLUGIN_ROOT}
    #    placeholder is resolved by Antigravity at runtime).
    $hooksJsonSrc  = Join-Path $TemplatesDir 'hooks\hooks.json'
    $hooksJsonDest = Join-Path $HooksDir 'hooks.json'
    $hooksJsonContent = [System.IO.File]::ReadAllText($hooksJsonSrc, $Utf8NoBom)
    Write-FileIdempotent -Path $hooksJsonDest -Content $hooksJsonContent

    # 3. log-touch-antigravity.js (the actual hook entry point)
    $hookAntigravDest = Join-Path $PluginDir 'log-touch-antigravity.js'
    $hookAntigravContent = [System.IO.File]::ReadAllText($HookScriptAntigravity, $Utf8NoBom)
    Write-FileIdempotent -Path $hookAntigravDest -Content $hookAntigravContent

    # 4. log-touch.js (sibling — the Antigravity hook imports pure
    #    helpers + constants from it; Node's resolver walks up from
    #    log-touch-antigravity.js and finds it here).
    $hookClaudeDest = Join-Path $PluginDir 'log-touch.js'
    $hookClaudeContent = [System.IO.File]::ReadAllText($HookScriptClaude, $Utf8NoBom)
    Write-FileIdempotent -Path $hookClaudeDest -Content $hookClaudeContent

    Write-Host ''
    Write-Host "  plugin dir : $PluginDir"   -ForegroundColor DarkGray
    Write-Host "  matcher    : edit_file|patch_file|write_file|view_file|grep_search" -ForegroundColor DarkGray
    Write-Host ''

    # Best-effort detection of an Antigravity installation. We don't
    # gate on it; we just warn so the user knows whether `/reload` will
    # do anything.
    $antigravCandidates = @(
        (Join-Path $HOME '.gemini'),
        (Join-Path $env:LOCALAPPDATA 'Programs\Antigravity'),
        (Join-Path ${env:ProgramFiles} 'Antigravity')
    )
    $found = $antigravCandidates | Where-Object { Test-Path $_ } | Select-Object -First 1
    if ($found) {
        Write-Host "  Detected Antigravity at: $found" -ForegroundColor Green
    } else {
        Write-Host "  Warning: no Antigravity installation detected on this machine." -ForegroundColor DarkYellow
        Write-Host "  The files are in place; install Antigravity later to activate the hook." -ForegroundColor DarkYellow
    }
    Write-Host ''
    Write-Host '  IMPORTANT: Antigravity does not hot-reload hooks.json.' -ForegroundColor Yellow
    Write-Host "  Run /reload in the Antigravity agent (or restart it) for changes to take effect." -ForegroundColor Yellow
}

# ─── Banner + dispatch ──────────────────────────────────────────────────────

Write-Host ''
Write-Host '╔════════════════════════════════════════════════════════════╗' -ForegroundColor White
Write-Host '║                 BlastRadius hook installer                 ║' -ForegroundColor White
Write-Host '╚════════════════════════════════════════════════════════════╝' -ForegroundColor White
Write-Host "  project   : $ProjectAbs"
Write-Host "  agent     : $Agent"
Write-Host "  log dir   : $LogDirAbs"
if ($DryRun) { Write-Host "  mode      : DRY RUN (no files will be written)" -ForegroundColor Cyan }
if ($Force)  { Write-Host "  mode      : FORCE (no .bak backups on update)" -ForegroundColor DarkYellow }
Write-Host ''

switch ($Agent) {
    'claude'      { Install-ClaudeHook }
    'antigravity' { Install-AntigravityHook }
    'both'        { Install-ClaudeHook; Install-AntigravityHook }
}

Write-Host ''
if ($DryRun) {
    Write-Host 'Dry run complete. Re-run without -DryRun to apply.' -ForegroundColor Cyan
} else {
    Write-Host 'Install complete.' -ForegroundColor Green
}
Write-Host ''
