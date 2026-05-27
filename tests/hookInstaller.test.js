/**
 * hookInstaller — Node-side reimplementation of scripts/install-hook.ps1.
 *
 * rc8.4 — Replaces the PowerShell-only flow with a pure Node module
 * the dashboard can invoke directly. The PS script stays as the CI /
 * manual path; this module is the surface for one-click "Activate"
 * from the dashboard banner.
 *
 * Contract source — every shape in this test mirrors the JSON the
 * PowerShell script writes (see scripts/install-hook.ps1
 * Install-ClaudeHook around line 318):
 *
 *   matcher  = "Edit|Write|Read"   (literal pipe-separated)
 *   entry    = { matcher, hooks: [{ type: "command", command }] }
 *   command  = `node "<absHookScript fwd-slashed>" --log-dir "<logDir fwd-slashed>"`
 *   envelope = settings.hooks.PostToolUse[]
 *   backup   = <file>.bak.<yyyyMMdd-HHmmss>
 *   merge    = drop only OUR prior entry (same matcher + log-touch.js
 *              in command); preserve every other key + every other hook
 *
 * Idempotency note: the PowerShell installer uses byte-equal string
 * compare (cheap but brittle to JSON formatting drift). This Node
 * module upgrades to JSON-SEMANTIC idempotency — if the existing
 * settings.json already has our exact hook entry, action is 'noop'
 * regardless of whitespace / key order. Documented deliberately so
 * a PS-installed file doesn't bounce on the first dashboard click.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

let tempDir
let installer

beforeEach(async () => {
  tempDir = await fs.mkdtemp(join(tmpdir(), 'blastradius-hookinst-'))
  // Import after mkdtemp so any module-level setup sees a clean env.
  installer = await import('../src/server/hookInstaller.js')
})

afterEach(async () => {
  await fs.rm(tempDir, { recursive: true, force: true })
})

/** Build a fake repo with a `.git/` marker so getHookStatus / installHook
 *  consider it valid. Returns the absolute repo path. */
async function fakeRepo(name = 'repo') {
  const dir = join(tempDir, name)
  await fs.mkdir(join(dir, '.git'), { recursive: true })
  return dir
}

/** Default opts the module needs to assemble the hook command. */
function defaultOpts(blastRoot = tempDir, logDir = join(tempDir, 'logs')) {
  return { logDir, blastRadiusRoot: blastRoot }
}

// ─── Tests ─────────────────────────────────────────────────────────────────

describe('hookInstaller — contract + idempotency', () => {
  it('Case A — installs into a repo without .claude/', async () => {
    const repo = await fakeRepo('clean')
    const opts = defaultOpts()
    const result = await installer.installHook(repo, opts)

    expect(result.ok).toBe(true)
    expect(result.action).toBe('created')
    expect(result.backupPath).toBeNull()
    expect(result.settingsPath).toBe(
      join(repo, '.claude', 'settings.json').replace(/\\/g, '/'),
    )

    const raw = await fs.readFile(result.settingsPath, 'utf8')
    const settings = JSON.parse(raw)

    // Envelope.
    expect(settings.hooks).toBeDefined()
    expect(Array.isArray(settings.hooks.PostToolUse)).toBe(true)
    expect(settings.hooks.PostToolUse).toHaveLength(1)

    // Entry shape — must match install-hook.ps1 Install-ClaudeHook
    // verbatim (matcher, type, command structure).
    const entry = settings.hooks.PostToolUse[0]
    expect(entry.matcher).toBe('Edit|Write|Read')
    expect(entry.hooks).toHaveLength(1)
    expect(entry.hooks[0].type).toBe('command')
    expect(entry.hooks[0].command).toMatch(/^node "[^"]*log-touch\.js" --log-dir "[^"]+"$/)
    // Both paths forward-slashed even on Windows.
    expect(entry.hooks[0].command).not.toMatch(/\\/)
  })

  it('Case B — merges into pre-existing settings.json without losing unrelated keys', async () => {
    const repo = await fakeRepo('merge')
    const settingsPath = join(repo, '.claude', 'settings.json')
    await fs.mkdir(join(repo, '.claude'), { recursive: true })
    const existing = {
      env: { FOO: 'bar' },
      hooks: {
        PostToolUse: [
          { matcher: 'Bash', hooks: [{ type: 'command', command: 'echo bash' }] },
        ],
        PreToolUse: [
          { matcher: 'Edit', hooks: [{ type: 'command', command: 'echo pre' }] },
        ],
      },
      otherTopLevel: { keep: true },
    }
    await fs.writeFile(settingsPath, JSON.stringify(existing, null, 2), 'utf8')

    const result = await installer.installHook(repo, defaultOpts())

    expect(result.ok).toBe(true)
    expect(result.action).toBe('updated')
    expect(result.backupPath).toMatch(/\.bak\.\d{8}-\d{6}$/)

    // Backup contains the ORIGINAL.
    const backupRaw = await fs.readFile(result.backupPath, 'utf8')
    expect(JSON.parse(backupRaw)).toEqual(existing)

    // New file: preserve everything, add our entry.
    const merged = JSON.parse(await fs.readFile(settingsPath, 'utf8'))
    expect(merged.env).toEqual({ FOO: 'bar' })
    expect(merged.otherTopLevel).toEqual({ keep: true })
    expect(merged.hooks.PreToolUse).toEqual(existing.hooks.PreToolUse)
    expect(merged.hooks.PostToolUse).toHaveLength(2)
    // Original Bash hook still there.
    expect(merged.hooks.PostToolUse[0]).toEqual(existing.hooks.PostToolUse[0])
    // Our hook appended.
    expect(merged.hooks.PostToolUse[1].matcher).toBe('Edit|Write|Read')
    expect(merged.hooks.PostToolUse[1].hooks[0].command).toMatch(/log-touch\.js/)
  })

  it('Case C — idempotent on second run (no backup, no rewrite)', async () => {
    const repo = await fakeRepo('idem')
    const first = await installer.installHook(repo, defaultOpts())
    expect(first.action).toBe('created')

    const settingsPath = first.settingsPath
    const firstBytes = await fs.readFile(settingsPath)

    const second = await installer.installHook(repo, defaultOpts())
    expect(second.ok).toBe(true)
    expect(second.action).toBe('noop')
    expect(second.backupPath).toBeNull()

    const secondBytes = await fs.readFile(settingsPath)
    expect(secondBytes.equals(firstBytes)).toBe(true)

    // No bonus backup files created on second run.
    const claudeDir = join(repo, '.claude')
    const entries = await fs.readdir(claudeDir)
    const backups = entries.filter((e) => e.startsWith('settings.json.bak.'))
    expect(backups).toHaveLength(0)
  })

  it('Case D — path traversal in repoPath is rejected', async () => {
    const result = await installer.installHook('../../etc/passwd', defaultOpts())
    expect(result.ok).toBe(false)
    expect(['escapes_root', 'absolute_path', 'invalid_path']).toContain(result.reason)
  })

  it('Case E — missing .git/ is rejected as not_a_git_repo', async () => {
    const dir = join(tempDir, 'not-a-repo')
    await fs.mkdir(dir, { recursive: true })
    const result = await installer.installHook(dir, defaultOpts())
    expect(result.ok).toBe(false)
    expect(result.reason).toBe('not_a_git_repo')
  })

  it('getHookStatus — reports installed=false for fresh repo', async () => {
    const repo = await fakeRepo('status-empty')
    const status = await installer.getHookStatus(repo, defaultOpts())
    expect(status.installed).toBe(false)
    expect(status.settingsExists).toBe(false)
    expect(status.expectedCommand).toMatch(/log-touch\.js/)
    expect(status.currentCommand).toBeNull()
  })

  it('getHookStatus — reports installed=true after installHook', async () => {
    const repo = await fakeRepo('status-installed')
    await installer.installHook(repo, defaultOpts())
    const status = await installer.getHookStatus(repo, defaultOpts())
    expect(status.installed).toBe(true)
    expect(status.settingsExists).toBe(true)
    expect(status.currentCommand).toBe(status.expectedCommand)
  })
})
