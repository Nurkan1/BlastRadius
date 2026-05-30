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
    its daily JSONL logs. Optional; defaults to ~\.blastradius\logs — the
    stable per-user location the BlastRadius server reads, so the hook and
    server always agree regardless of which repo is active.
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

.PARAMETER RegisterMcp
    In addition to installing the touch-event hook, register the
    BlastRadius MCP server (HTTP transport) in the matching agent's
    global MCP configuration so the agent can query iteration state,
    summaries, and diffs.

      -Agent claude       → merges `mcpServers.blastradius` into
                            $env:USERPROFILE\.claude.json with
                            { type: "http", url: $McpUrl }
      -Agent antigravity  → merges `mcpServers.blastradius` into
                            $env:USERPROFILE\.gemini\config\mcp_config.json
                            with { serverUrl: $McpUrl }
                            (Antigravity uses `serverUrl`, not `url`)
      -Agent both         → both of the above

    Idempotent: re-running with the same URL leaves the file
    UNCHANGED; running with a different URL writes a backup before
    overwriting (suppressed with -Force). Other MCP servers already
    registered by the user are preserved.

.PARAMETER McpUrl
    URL of the BlastRadius MCP endpoint to register when -RegisterMcp
    is set. Defaults to `http://localhost:7842/mcp` (the default
    BlastRadius dashboard port). Override when the dashboard runs on
    a non-default port (BLASTRADIUS_PORT env var).

.PARAMETER RegisterDesktop
    Register BlastRadius as a stdio MCP server in Claude Desktop's
    config at `%APPDATA%\Claude\claude_desktop_config.json`. Claude
    Desktop's config validator does NOT accept the http transport
    that -RegisterMcp uses for Claude Code; this flag installs the
    bundled stdio shim instead.

    Two non-obvious quirks the installer works around:

      1. The entry name is forced to "blastradius-observability"
         (not "blastradius") because Claude Desktop maintains an
         in-process persistent rejection blocklist by name -- once a
         server name is rejected, subsequent edits under that name
         are silently deleted from the config on every read. The
         alternative name escapes the blocklist permanently.

      2. The shim is referenced as a .cjs file, not the .mjs source.
         Claude Desktop's config validator filters out any args entry
         that points at .mjs; the wrapper at bin/blastradius-mcp.cjs
         spawns the .mjs in a child process and inherits its stdio.

    After running this command, the user must FULLY QUIT Claude
    Desktop (system tray -> Quit) and reopen it. The new server then
    appears as "blastradius-observability" alongside any other MCPs
    the user has registered.

.PARAMETER ShimPath
    Absolute path to bin/blastradius-mcp.cjs used by -RegisterDesktop.
    Defaults to the shim bundled adjacent to this script (resolves to
    `<repo>/bin/blastradius-mcp.cjs`). Override when the installer
    runs against a checkout in a non-standard location.

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

.EXAMPLE
    # Install the hook AND register BlastRadius as an MCP server in
    # Claude Code's global config so the agent can read live state.
    .\scripts\install-hook.ps1 -ProjectPath C:\projects\myrepo -Agent claude -RegisterMcp

.EXAMPLE
    # Same for Antigravity 2.0 (writes to ~/.gemini/config/mcp_config.json).
    .\scripts\install-hook.ps1 -ProjectPath C:\projects\myrepo -Agent antigravity -RegisterMcp

.EXAMPLE
    # One-shot setup for a workstation that uses both agents.
    .\scripts\install-hook.ps1 -ProjectPath C:\projects\myrepo -Agent both -RegisterMcp

.EXAMPLE
    # Custom port (BlastRadius dashboard running on 7878).
    .\scripts\install-hook.ps1 -ProjectPath C:\projects\myrepo -Agent claude -RegisterMcp -McpUrl http://localhost:7878/mcp
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
    [switch]$Force,

    [Parameter(Mandatory = $false, HelpMessage = "Also register BlastRadius MCP server in the agent's global config")]
    [switch]$RegisterMcp,

    [Parameter(Mandatory = $false, HelpMessage = "MCP endpoint URL (default: http://localhost:7842/mcp)")]
    [string]$McpUrl = 'http://localhost:7842/mcp',

    [Parameter(Mandatory = $false, HelpMessage = "Register BlastRadius as a stdio MCP server in Claude Desktop's config")]
    [switch]$RegisterDesktop,

    [Parameter(Mandatory = $false, HelpMessage = "Path to bin/blastradius-mcp.cjs (default: bundled shim adjacent to this script)")]
    [string]$ShimPath
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

# Resolve LogDir lexically (it may not exist yet). rc9.12: default to the
# STABLE per-user location the BlastRadius server reads — ~/.blastradius/logs.
# (Previously this defaulted to <repo>/logs, which the installed server only
# read when that repo happened to be active at boot — after an auto-switch
# the hook and server diverged and the dashboard went empty.)
if (-not $LogDir) { $LogDir = Join-Path $HOME '.blastradius/logs' }
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

# ─── MCP registration helpers ───────────────────────────────────────────────
#
# The actual JSON merging happens in scripts/register-mcp.mjs (Node)
# because Windows PowerShell 5.1's ConvertTo-Json uses a
# vertical-alignment indent that bloats files 3x and destroys the
# user's existing 2-space-indented JSON. Node's
# JSON.stringify(obj, null, 2) matches what Claude Code and
# Antigravity emit natively, keeps file size sane, and produces
# minimal diffs across edits. PowerShell here only orchestrates.

function Invoke-RegisterMcpNode {
    <#
    Spawn the Node merger and translate its single-line stdout into
    a colored status line. Returns the bare status word ('UNCHANGED',
    'CREATED', 'UPDATED', 'WOULD-CREATE', 'WOULD-UPDATE') so callers
    can act on it if needed.

    Does NOT throw on Node returning a non-zero exit — surfaces the
    stderr inline so the installer keeps running and the user sees
    the diagnostic. The Hook install path stays independent of the
    MCP registration path.
    #>
    param(
        [Parameter(Mandatory)][string]$ConfigPath,
        [Parameter(Mandatory)][string]$ServerName,
        [Parameter(Mandatory)][hashtable]$Entry
    )

    $registerScript = Join-Path $RepoRoot 'scripts\register-mcp.mjs'
    if (-not (Test-Path $registerScript)) {
        Write-Host "  ERROR  register-mcp.mjs not found at $registerScript" -ForegroundColor Red
        return 'ERROR'
    }

    $entryJson = ($Entry | ConvertTo-Json -Compress -Depth 6)

    # Pipe the JSON via stdin instead of passing it as an argument:
    # Windows' command-line parser strips inner double-quotes from
    # `& node ... "{\"k\":\"v\"}"`, corrupting the JSON before it
    # reaches the script. stdin is robust to any quoting.
    $nodeArgs = @($registerScript, $ConfigPath, $ServerName, '--stdin')
    if ($DryRun) { $nodeArgs += '--dry-run' }

    # `$entryJson | & node ...` makes PowerShell write the string
    # to the child process's stdin and close it, which the .mjs
    # script consumes via process.stdin. We intentionally use the
    # pipeline (not Start-Process) to keep this synchronous and
    # capture stdout into $stdout for the status word parsing below.
    $stdout = $entryJson | & node @nodeArgs 2>&1
    $exit   = $LASTEXITCODE

    $first = ($stdout | Select-Object -First 1)
    if ($exit -ne 0) {
        Write-Host "  ERROR  $first" -ForegroundColor Red
        return 'ERROR'
    }

    # Output shape: "UNCHANGED" | "CREATED <path>" | "UPDATED <path>"
    # | "WOULD-CREATE" | "WOULD-UPDATE"
    $word = ($first -split '\s+')[0]
    Write-Action $word $ConfigPath
    return $word
}

function Register-ClaudeMcp {
    <#
    Register BlastRadius in the user-scope Claude Code config
    ($env:USERPROFILE\.claude.json). HTTP transport. Idempotent.
    Preserves every other key and every other server already
    registered.

    Uses $env:USERPROFILE rather than the automatic $HOME variable
    because the latter is bound once at PowerShell startup and
    cannot be redirected by the caller via env vars — making the
    function impossible to test in a temp sandbox.
    #>
    Write-Host ''
    Write-Host '== Claude Code MCP registration ==' -ForegroundColor White

    $home_     = $env:USERPROFILE
    $ClaudeJson = Join-Path $home_ '.claude.json'
    $entry = @{
        type = 'http'
        url  = $McpUrl
    }
    Invoke-RegisterMcpNode -ConfigPath $ClaudeJson -ServerName 'blastradius' -Entry $entry | Out-Null

    Write-Host ''
    Write-Host "  config  : $ClaudeJson"                              -ForegroundColor DarkGray
    Write-Host "  server  : blastradius (type=http, url=$McpUrl)"     -ForegroundColor DarkGray
    Write-Host ''
    Write-Host '  IMPORTANT: existing Claude Code sessions must be restarted to pick up the new MCP server.' -ForegroundColor Yellow
    Write-Host '             Future sessions (in any project) will see BlastRadius as long as the dashboard is running.' -ForegroundColor Yellow
}

function Register-AntigravityMcp {
    <#
    Register BlastRadius in the Antigravity 2.0 MCP config
    ($env:USERPROFILE\.gemini\config\mcp_config.json). Antigravity
    uses the `serverUrl` field (not `url` like Claude Code) so the
    entry shape is intentionally different.
    #>
    Write-Host ''
    Write-Host '== Antigravity MCP registration ==' -ForegroundColor White

    $home_       = $env:USERPROFILE
    $AntigravJson = Join-Path $home_ '.gemini\config\mcp_config.json'
    $entry = @{
        serverUrl = $McpUrl
    }
    Invoke-RegisterMcpNode -ConfigPath $AntigravJson -ServerName 'blastradius' -Entry $entry | Out-Null

    Write-Host ''
    Write-Host "  config  : $AntigravJson"                            -ForegroundColor DarkGray
    Write-Host "  server  : blastradius (serverUrl=$McpUrl)"          -ForegroundColor DarkGray
    Write-Host ''
    Write-Host '  IMPORTANT: Antigravity does NOT hot-reload MCP config. Run /reload in the agent' -ForegroundColor Yellow
    Write-Host '             (or restart it) for BlastRadius to appear in the server list.'        -ForegroundColor Yellow
}

function Register-ClaudeDesktopMcp {
    <#
    Register BlastRadius as a stdio MCP server in Claude Desktop's
    config ($env:APPDATA\Claude\claude_desktop_config.json). Two
    quirks worked around here, both documented in the synopsis:

      1. Server name is FORCED to "blastradius-observability" -- not
         "blastradius" -- because Claude Desktop maintains an
         in-process persistent rejection blocklist by name and any
         entry under "blastradius" that ever encountered a parse
         error stays banned for the lifetime of that install.

      2. The args entry points at the .cjs wrapper, not the .mjs
         source. Claude Desktop's config validator filters out any
         .mjs reference.

    Also unlike the HTTP transport flows, Claude Desktop ONLY reads
    its config at startup -- the user must FULLY QUIT (system tray
    -> Quit) and reopen after the registration completes.
    #>
    Write-Host ''
    Write-Host '== Claude Desktop MCP registration ==' -ForegroundColor White

    # Resolve the shim path. Default: bin/blastradius-mcp.cjs adjacent
    # to this script's repo root.
    $shimAbs = if ($ShimPath) {
        if (-not (Test-Path $ShimPath)) {
            Write-Error "Shim path does not exist: $ShimPath"
            return
        }
        (Resolve-Path $ShimPath).Path
    } else {
        $candidate = Join-Path $RepoRoot 'bin\blastradius-mcp.cjs'
        if (-not (Test-Path $candidate)) {
            Write-Error "Bundled shim not found at $candidate. Pass -ShimPath to override."
            return
        }
        (Resolve-Path $candidate).Path
    }
    # Forward-slashes for the JSON config (Windows accepts both; the
    # canonical Claude Desktop entries -- see ideablast, notebooklm --
    # also use forward slashes).
    $shimFwd = $shimAbs -replace '\\', '/'

    $home_         = $env:USERPROFILE
    $DesktopJson   = Join-Path $home_ 'AppData\Roaming\Claude\claude_desktop_config.json'

    $entry = @{
        command = 'node'
        args    = @($shimFwd)
    }
    # IMPORTANT: server name escapes Claude Desktop's blocklist -- see
    # the synopsis for the full rationale.
    Invoke-RegisterMcpNode -ConfigPath $DesktopJson -ServerName 'blastradius-observability' -Entry $entry | Out-Null

    Write-Host ''
    Write-Host "  config  : $DesktopJson"                                                                  -ForegroundColor DarkGray
    Write-Host "  server  : blastradius-observability (command=node, args=[$shimFwd])"                     -ForegroundColor DarkGray
    Write-Host ''
    Write-Host '  IMPORTANT: Claude Desktop only reads its config at startup.'                             -ForegroundColor Yellow
    Write-Host '             Fully quit Claude Desktop (system tray icon -> Quit) and reopen it for the'   -ForegroundColor Yellow
    Write-Host '             new server to be picked up. The dashboard must also be running for the shim'  -ForegroundColor Yellow
    Write-Host "             to reach it at $McpUrl."                                                      -ForegroundColor Yellow
}

# ─── Banner + dispatch ──────────────────────────────────────────────────────

Write-Host ''
Write-Host '╔════════════════════════════════════════════════════════════╗' -ForegroundColor White
Write-Host '║                 BlastRadius hook installer                 ║' -ForegroundColor White
Write-Host '╚════════════════════════════════════════════════════════════╝' -ForegroundColor White
Write-Host "  project   : $ProjectAbs"
Write-Host "  agent     : $Agent"
Write-Host "  log dir   : $LogDirAbs"
if ($RegisterMcp) {
    Write-Host "  mcp       : register HTTP transport at $McpUrl"          -ForegroundColor Green
}
if ($RegisterDesktop) {
    Write-Host "  desktop   : register stdio shim in Claude Desktop"        -ForegroundColor Green
}
if ($DryRun) { Write-Host "  mode      : DRY RUN (no files will be written)" -ForegroundColor Cyan }
if ($Force)  { Write-Host "  mode      : FORCE (no .bak backups on update)" -ForegroundColor DarkYellow }
Write-Host ''

switch ($Agent) {
    'claude'      { Install-ClaudeHook }
    'antigravity' { Install-AntigravityHook }
    'both'        { Install-ClaudeHook; Install-AntigravityHook }
}

# Optional MCP registration. Runs AFTER the hook install so the order
# of status lines stays "hook done, then MCP done" — easy to read in
# the terminal output even on long installs.
if ($RegisterMcp) {
    switch ($Agent) {
        'claude'      { Register-ClaudeMcp }
        'antigravity' { Register-AntigravityMcp }
        'both'        { Register-ClaudeMcp; Register-AntigravityMcp }
    }
}

# Claude Desktop registration is independent of -Agent -- Desktop is its
# own surface (separate from the Claude Code CLI), so it can be used
# alongside any agent choice without forcing -Agent both.
if ($RegisterDesktop) {
    Register-ClaudeDesktopMcp
}

Write-Host ''
if ($DryRun) {
    Write-Host 'Dry run complete. Re-run without -DryRun to apply.' -ForegroundColor Cyan
} else {
    Write-Host 'Install complete.' -ForegroundColor Green
}
Write-Host ''
