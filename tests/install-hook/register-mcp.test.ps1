<#
.SYNOPSIS
    Tests for scripts/install-hook.ps1 -RegisterMcp.

.DESCRIPTION
    Runs the installer against a TEMPORARY $HOME so the user's real
    ~/.claude.json and ~/.gemini/config/mcp_config.json are never
    touched. Each scenario validates idempotency and merge-preserve
    behavior.

    Pure PowerShell — no Pester. Run with:
        powershell -NoProfile -ExecutionPolicy Bypass -File tests\install-hook\register-mcp.test.ps1

    Exit code 0 on all pass, 1 on any failure.
#>

[CmdletBinding()]
param()

# We do NOT set $ErrorActionPreference = 'Stop' here — a single
# expected installer warning shouldn't abort the whole suite. We
# catch errors at the call sites where it matters.

$passed = 0
$failed = 0

$RepoRoot   = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$Installer  = Join-Path $RepoRoot 'scripts\install-hook.ps1'

function Write-Pass($label) { Write-Host "  PASS  $label" -ForegroundColor Green; $script:passed++ }
function Write-Fail($label, $expected, $actual) {
    Write-Host "  FAIL  $label" -ForegroundColor Red
    Write-Host "          expected: $expected"   -ForegroundColor DarkRed
    Write-Host "          actual  : $actual"     -ForegroundColor DarkRed
    $script:failed++
}

function Check-Eq($label, $expected, $actual) {
    if ($expected -eq $actual) { Write-Pass $label } else { Write-Fail $label $expected $actual }
}
function Check-True($label, $cond) {
    if ($cond) { Write-Pass $label } else { Write-Fail $label 'true' 'false' }
}
function Check-Null($label, $value) {
    if ($null -eq $value) { Write-Pass $label } else { Write-Fail $label '$null' $value }
}

function New-Sandbox {
    $tmp = Join-Path $env:TEMP ("blastradius-test-{0:yyyyMMddHHmmssfff}" -f (Get-Date))
    New-Item -ItemType Directory -Path $tmp -Force | Out-Null
    New-Item -ItemType Directory -Path (Join-Path $tmp '.gemini\config') -Force | Out-Null
    $proj = Join-Path $tmp 'sample-project'
    New-Item -ItemType Directory -Path $proj -Force | Out-Null
    return @{ Home = $tmp; Project = $proj }
}

function Run-Installer {
    param(
        [string]$HomeDir,
        [string]$ProjectPath,
        [string]$Agent,
        [switch]$RegisterMcp,
        [switch]$RegisterDesktop,
        [string]$ShimPath,
        [string]$McpUrl = 'http://localhost:7842/mcp'
    )
    $prevHome    = $env:HOME
    $prevProfile = $env:USERPROFILE
    try {
        $env:HOME = $HomeDir
        $env:USERPROFILE = $HomeDir
        $argSet = @{ ProjectPath = $ProjectPath; Agent = $Agent; McpUrl = $McpUrl }
        if ($RegisterMcp)     { $argSet.RegisterMcp = $true }
        if ($RegisterDesktop) { $argSet.RegisterDesktop = $true }
        if ($ShimPath)        { $argSet.ShimPath = $ShimPath }
        & $Installer @argSet *>$null
    } catch {
        Write-Host ("    installer error: {0}" -f $_.Exception.Message) -ForegroundColor DarkYellow
    } finally {
        $env:HOME = $prevHome
        $env:USERPROFILE = $prevProfile
    }
}

function Get-JsonValue {
    param([string]$Path, [string]$DottedPath)
    if (-not (Test-Path $Path)) { return $null }
    $raw = Get-Content $Path -Raw
    if ([string]::IsNullOrWhiteSpace($raw)) { return $null }
    $obj = $raw | ConvertFrom-Json
    foreach ($k in $DottedPath.Split('.')) {
        if ($null -eq $obj -or -not $obj.PSObject.Properties[$k]) { return $null }
        $obj = $obj.$k
    }
    return $obj
}

# ─── Scenario 1 ─────────────────────────────────────────────────────────────
Write-Host ''
Write-Host 'Scenario 1: Claude — create .claude.json from scratch' -ForegroundColor Cyan
$s = New-Sandbox
try {
    Run-Installer -HomeDir $s.Home -ProjectPath $s.Project -Agent claude -RegisterMcp
    $cj = Join-Path $s.Home '.claude.json'
    Check-True '.claude.json created' (Test-Path $cj)
    Check-Eq   'mcpServers.blastradius.type'  'http'                         (Get-JsonValue $cj 'mcpServers.blastradius.type')
    Check-Eq   'mcpServers.blastradius.url'   'http://localhost:7842/mcp'    (Get-JsonValue $cj 'mcpServers.blastradius.url')
} finally { Remove-Item -Recurse -Force $s.Home -ErrorAction SilentlyContinue }

# ─── Scenario 2 ─────────────────────────────────────────────────────────────
Write-Host ''
Write-Host 'Scenario 2: Claude — second run is UNCHANGED, no backup' -ForegroundColor Cyan
$s = New-Sandbox
try {
    Run-Installer -HomeDir $s.Home -ProjectPath $s.Project -Agent claude -RegisterMcp
    $cj = Join-Path $s.Home '.claude.json'
    $mtime1 = (Get-Item $cj).LastWriteTime
    Start-Sleep -Milliseconds 1500
    Run-Installer -HomeDir $s.Home -ProjectPath $s.Project -Agent claude -RegisterMcp
    $mtime2 = (Get-Item $cj).LastWriteTime
    Check-True 'mtime unchanged on idempotent re-run' ($mtime1 -eq $mtime2)
    $backups = @(Get-ChildItem $s.Home -Filter '.claude.json.bak.*' -ErrorAction SilentlyContinue)
    Check-Eq   'zero .bak backups on idempotent re-run' 0 $backups.Count
} finally { Remove-Item -Recurse -Force $s.Home -ErrorAction SilentlyContinue }

# ─── Scenario 3 ─────────────────────────────────────────────────────────────
Write-Host ''
Write-Host 'Scenario 3: Claude — merge preserves other top-level keys + servers' -ForegroundColor Cyan
$s = New-Sandbox
try {
    $cj = Join-Path $s.Home '.claude.json'
    $pre = @{
        userId       = 'abc-123'
        feedbackMode = 'concise'
        mcpServers   = @{ 'other-server' = @{ type = 'http'; url = 'https://other.example.com/mcp' } }
    } | ConvertTo-Json -Depth 8
    [System.IO.File]::WriteAllText($cj, $pre, [System.Text.UTF8Encoding]::new($false))

    Run-Installer -HomeDir $s.Home -ProjectPath $s.Project -Agent claude -RegisterMcp

    Check-Eq 'userId preserved'        'abc-123'                          (Get-JsonValue $cj 'userId')
    Check-Eq 'feedbackMode preserved'  'concise'                          (Get-JsonValue $cj 'feedbackMode')
    Check-Eq 'other-server preserved'  'https://other.example.com/mcp'    (Get-JsonValue $cj 'mcpServers.other-server.url')
    Check-Eq 'blastradius added'       'http://localhost:7842/mcp'        (Get-JsonValue $cj 'mcpServers.blastradius.url')
    $backups = @(Get-ChildItem $s.Home -Filter '.claude.json.bak.*' -ErrorAction SilentlyContinue)
    Check-True '.bak backup written on first change' ($backups.Count -ge 1)
} finally { Remove-Item -Recurse -Force $s.Home -ErrorAction SilentlyContinue }

# ─── Scenario 4 ─────────────────────────────────────────────────────────────
Write-Host ''
Write-Host 'Scenario 4: Antigravity — uses serverUrl field (not url)' -ForegroundColor Cyan
$s = New-Sandbox
try {
    $aj = Join-Path $s.Home '.gemini\config\mcp_config.json'
    Run-Installer -HomeDir $s.Home -ProjectPath $s.Project -Agent antigravity -RegisterMcp
    Check-True 'mcp_config.json created' (Test-Path $aj)
    Check-Eq   'serverUrl set' 'http://localhost:7842/mcp' (Get-JsonValue $aj 'mcpServers.blastradius.serverUrl')
    Check-Null 'url field NOT present (uses serverUrl)' (Get-JsonValue $aj 'mcpServers.blastradius.url')
} finally { Remove-Item -Recurse -Force $s.Home -ErrorAction SilentlyContinue }

# ─── Scenario 5 ─────────────────────────────────────────────────────────────
Write-Host ''
Write-Host 'Scenario 5: Custom -McpUrl is honored' -ForegroundColor Cyan
$s = New-Sandbox
try {
    Run-Installer -HomeDir $s.Home -ProjectPath $s.Project -Agent claude -RegisterMcp -McpUrl 'http://localhost:7878/mcp'
    $cj = Join-Path $s.Home '.claude.json'
    Check-Eq 'custom url written' 'http://localhost:7878/mcp' (Get-JsonValue $cj 'mcpServers.blastradius.url')
} finally { Remove-Item -Recurse -Force $s.Home -ErrorAction SilentlyContinue }

# ─── Scenario 6 ─────────────────────────────────────────────────────────────
Write-Host ''
Write-Host 'Scenario 6: -Agent both writes to BOTH configs' -ForegroundColor Cyan
$s = New-Sandbox
try {
    Run-Installer -HomeDir $s.Home -ProjectPath $s.Project -Agent both -RegisterMcp
    $cj = Join-Path $s.Home '.claude.json'
    $aj = Join-Path $s.Home '.gemini\config\mcp_config.json'
    Check-True 'Claude config exists'      (Test-Path $cj)
    Check-True 'Antigravity config exists' (Test-Path $aj)
    Check-Eq   'Claude url'                'http://localhost:7842/mcp' (Get-JsonValue $cj 'mcpServers.blastradius.url')
    Check-Eq   'Antigravity serverUrl'     'http://localhost:7842/mcp' (Get-JsonValue $aj 'mcpServers.blastradius.serverUrl')
} finally { Remove-Item -Recurse -Force $s.Home -ErrorAction SilentlyContinue }

# ─── Scenario 7 ─────────────────────────────────────────────────────────────
# -RegisterDesktop writes to AppData\Roaming\Claude\claude_desktop_config.json
# with stdio shape AND under the rename "blastradius-observability" (not
# "blastradius") to escape Claude Desktop's persistent rejection blocklist.
Write-Host ''
Write-Host 'Scenario 7: -RegisterDesktop writes stdio shape with rename' -ForegroundColor Cyan
$s = New-Sandbox
try {
    $shim = Join-Path $RepoRoot 'bin\blastradius-mcp.cjs'
    Run-Installer -HomeDir $s.Home -ProjectPath $s.Project -Agent claude -RegisterDesktop -ShimPath $shim
    $dj = Join-Path $s.Home 'AppData\Roaming\Claude\claude_desktop_config.json'
    Check-True 'claude_desktop_config.json created' (Test-Path $dj)
    # Server registered under the rename, NOT "blastradius".
    Check-Null  'mcpServers.blastradius MUST NOT exist (blocklist escape)' (Get-JsonValue $dj 'mcpServers.blastradius')
    Check-True  'mcpServers.blastradius-observability exists' ($null -ne (Get-JsonValue $dj 'mcpServers.blastradius-observability'))
    Check-Eq    'command = node (PATH-resolved, no spaces)' 'node' (Get-JsonValue $dj 'mcpServers.blastradius-observability.command')
    # args[0] should reference the .cjs shim (Claude Desktop rejects .mjs).
    # Wrap with @() — PS 5.1's ConvertFrom-Json unboxes single-element
    # arrays into bare values; @() rebuilds the array shape.
    $argsArr = @(Get-JsonValue $dj 'mcpServers.blastradius-observability.args')
    Check-True 'args[0] points at .cjs (Claude Desktop rejects .mjs)' ($argsArr[0] -match '\.cjs$')
} finally { Remove-Item -Recurse -Force $s.Home -ErrorAction SilentlyContinue }

# ─── Scenario 8 ─────────────────────────────────────────────────────────────
# -RegisterDesktop preserves existing Desktop MCPs (ideablast, notebooklm) —
# critical because Claude Desktop users typically have other local servers.
Write-Host ''
Write-Host 'Scenario 8: -RegisterDesktop preserves existing Desktop MCP servers' -ForegroundColor Cyan
$s = New-Sandbox
try {
    $dj = Join-Path $s.Home 'AppData\Roaming\Claude\claude_desktop_config.json'
    New-Item -ItemType Directory -Path (Split-Path $dj -Parent) -Force | Out-Null
    $pre = @{
        mcpServers = @{
            'ideablast'  = @{ command = 'node'; args = @('C:/x/ideablast/dist/index.js') }
            'notebooklm' = @{ command = 'npx';  args = @('notebooklm-mcp@latest') }
        }
        preferences = @{ allowAllBrowserActions = $true }
    } | ConvertTo-Json -Depth 8
    [System.IO.File]::WriteAllText($dj, $pre, [System.Text.UTF8Encoding]::new($false))

    $shim = Join-Path $RepoRoot 'bin\blastradius-mcp.cjs'
    Run-Installer -HomeDir $s.Home -ProjectPath $s.Project -Agent claude -RegisterDesktop -ShimPath $shim

    Check-Eq   'ideablast preserved'    'C:/x/ideablast/dist/index.js' (@(Get-JsonValue $dj 'mcpServers.ideablast.args')[0])
    Check-Eq   'notebooklm preserved'   'notebooklm-mcp@latest'        (@(Get-JsonValue $dj 'mcpServers.notebooklm.args')[0])
    Check-True 'blastradius-observability added' ($null -ne (Get-JsonValue $dj 'mcpServers.blastradius-observability'))
    Check-Eq   'unrelated top-level "preferences" preserved' $true (Get-JsonValue $dj 'preferences.allowAllBrowserActions')
} finally { Remove-Item -Recurse -Force $s.Home -ErrorAction SilentlyContinue }

# ─── Summary ────────────────────────────────────────────────────────────────
Write-Host ''
Write-Host '════════════════════════════════════════════════════════════' -ForegroundColor White
Write-Host (' {0} passed, {1} failed' -f $passed, $failed) -ForegroundColor $(if ($failed -eq 0) { 'Green' } else { 'Red' })
Write-Host '════════════════════════════════════════════════════════════' -ForegroundColor White

if ($failed -gt 0) { exit 1 } else { exit 0 }
