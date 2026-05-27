/**
 * hookInstaller — Node-side reimplementation of the Claude Code hook
 * registration logic in scripts/install-hook.ps1 (rc8.4).
 *
 * Why this module exists
 * ──────────────────────
 * Before rc8.4 the only way to register the log-touch hook in a repo
 * was running scripts/install-hook.ps1 manually. The dashboard knows
 * which repo is active and whether the hook is present — but it
 * couldn't act on that information. This module is the bridge: pure
 * Node, no PowerShell shell-out, callable from a REST endpoint with
 * the same idempotency guarantees the PS script ships.
 *
 * Contract source — see scripts/install-hook.ps1 Install-ClaudeHook
 * (around line 318). The JSON shape MUST match byte-for-byte at the
 * logical level:
 *
 *   matcher = "Edit|Write|Read"
 *   entry   = { matcher, hooks: [{ type: "command", command }] }
 *   command = `node "<absHookScript fwd-slash>" --log-dir "<logDir fwd-slash>"`
 *   envelope = settings.hooks.PostToolUse[]
 *
 * Backup naming: `<file>.bak.<yyyyMMdd-HHmmss>` — same Get-Timestamp
 * format the PowerShell script uses (digits + dash + digits, no
 * separators in the date or time).
 *
 * Idempotency upgrade vs PS
 * ─────────────────────────
 * The PowerShell installer compares files byte-for-byte after
 * JSON serialization. That's brittle: a Node-formatted JSON vs a
 * PS-formatted JSON (different indent, key order) would always
 * trigger a backup + rewrite. This module compares JSON SEMANTICS
 * instead — if the existing settings.json already has our exact
 * hook entry shape with the exact command, action is 'noop'
 * regardless of whitespace or sibling-key order. So a repo
 * registered first via PS, later "Re-activated" from the dashboard,
 * does NOT bounce.
 *
 * Security
 * ────────
 *   - repoPath must be an absolute path to a real directory containing
 *     `.git/`. NUL bytes, relative paths, paths to non-directories,
 *     and paths to non-repos are rejected.
 *   - The module ONLY ever writes inside `<repoPath>/.claude/`. It
 *     does not touch the BlastRadius repo, the user's home, or any
 *     other path. The caller (routes.js) is responsible for ensuring
 *     repoPath is under preferences.parentDir BEFORE calling
 *     installHook — that gate is policy, not module-level invariant.
 */

import { promises as fs } from 'node:fs'
import { isAbsolute, join, normalize as nodeNormalize, resolve, sep } from 'node:path'
import { platform } from 'node:os'

/** Forward-slash a path. Idempotent. */
function fwd(p) {
  return String(p).replace(/\\/g, '/')
}

/** Filename-safe local timestamp: yyyyMMdd-HHmmss. Mirrors the
 *  Get-Timestamp helper in scripts/install-hook.ps1. */
function timestamp(d = new Date()) {
  const pad = (n, w = 2) => String(n).padStart(w, '0')
  const y = d.getFullYear()
  const mo = pad(d.getMonth() + 1)
  const da = pad(d.getDate())
  const h = pad(d.getHours())
  const mi = pad(d.getMinutes())
  const s = pad(d.getSeconds())
  return `${y}${mo}${da}-${h}${mi}${s}`
}

/**
 * Validate that repoPath is a string that points to a real directory
 * containing `.git/`. Returns either { ok: true, absPath } or
 * { ok: false, reason }.
 *
 * Rejection codes mirror the rc8 NO-DATA reasons:
 *   - invalid_path     — empty / non-string input
 *   - nul_byte         — NUL injection
 *   - absolute_path    — required to BE absolute on the way in;
 *                        relative paths are rejected because they
 *                        would resolve relative to process.cwd which
 *                        is non-deterministic
 *   - escapes_root     — `..` traversal that climbs above the input
 *                        before resolving
 *   - not_a_directory  — input exists but is a file
 *   - not_a_git_repo   — directory exists but has no `.git/`
 */
async function validateRepoPath(repoPath) {
  if (typeof repoPath !== 'string' || repoPath.length === 0) {
    return { ok: false, reason: 'invalid_path' }
  }
  if (repoPath.includes('\0')) {
    return { ok: false, reason: 'nul_byte' }
  }
  if (!isAbsolute(repoPath)) {
    return { ok: false, reason: 'absolute_path' }
  }
  // Normalize and verify normalize didn't escape via `..`. resolve()
  // collapses `..` segments — if the result differs structurally from
  // the input in a way that hops UP a directory, that's traversal.
  const norm = nodeNormalize(repoPath)
  if (norm.includes(`..${sep}`)) {
    return { ok: false, reason: 'escapes_root' }
  }
  const abs = resolve(norm)
  try {
    const stat = await fs.stat(abs)
    if (!stat.isDirectory()) return { ok: false, reason: 'not_a_directory' }
  } catch {
    return { ok: false, reason: 'not_a_directory' }
  }
  try {
    const gitStat = await fs.stat(join(abs, '.git'))
    if (!gitStat.isDirectory() && !gitStat.isFile()) {
      return { ok: false, reason: 'not_a_git_repo' }
    }
  } catch {
    return { ok: false, reason: 'not_a_git_repo' }
  }
  return { ok: true, absPath: abs }
}

/**
 * Build the canonical hook entry that gets merged into
 * settings.hooks.PostToolUse. Used both at install time and during
 * the idempotency check.
 *
 * @param {{ logDir: string, blastRadiusRoot: string }} opts
 */
export function buildHookEntry({ logDir, blastRadiusRoot }) {
  if (!logDir || !blastRadiusRoot) {
    throw new Error('buildHookEntry: logDir and blastRadiusRoot are required')
  }
  const hookScript = fwd(join(blastRadiusRoot, 'src', 'hook', 'log-touch.js'))
  const logDirFwd = fwd(logDir)
  const command = `node "${hookScript}" --log-dir "${logDirFwd}"`
  return {
    matcher: 'Edit|Write|Read',
    hooks: [{ type: 'command', command }],
  }
}

/** Locate an entry inside an array that matches our matcher AND has
 *  a command pointing at log-touch.js (any path, any flags). Mirrors
 *  the PS preservation logic: only OUR prior entry gets dropped on
 *  reinstall, every other entry stays. */
function findOurEntryIndex(postToolUse, ourMatcher) {
  if (!Array.isArray(postToolUse)) return -1
  for (let i = 0; i < postToolUse.length; i++) {
    const entry = postToolUse[i]
    if (!entry || typeof entry !== 'object') continue
    if (entry.matcher !== ourMatcher) continue
    const hooks = Array.isArray(entry.hooks) ? entry.hooks : []
    const hasOurCmd = hooks.some(
      (h) => h && typeof h.command === 'string' && h.command.includes('log-touch.js'),
    )
    if (hasOurCmd) return i
  }
  return -1
}

/** Deep-equality check tight enough for our hook entry. We control
 *  the shape (matcher: string, hooks: array of { type, command }), so
 *  this doesn't need to be a full structural diff. */
function hookEntryEqual(a, b) {
  if (!a || !b) return false
  if (a.matcher !== b.matcher) return false
  const ah = Array.isArray(a.hooks) ? a.hooks : []
  const bh = Array.isArray(b.hooks) ? b.hooks : []
  if (ah.length !== bh.length) return false
  for (let i = 0; i < ah.length; i++) {
    if (ah[i].type !== bh[i].type) return false
    if (ah[i].command !== bh[i].command) return false
  }
  return true
}

/**
 * Read + report status of the hook in a repo. Pure — no side effects.
 *
 * @param {string} repoPath
 * @param {{ logDir: string, blastRadiusRoot: string }} opts
 * @returns {Promise<{
 *   installed: boolean,
 *   settingsExists: boolean,
 *   settingsPath: string,
 *   expectedCommand: string,
 *   currentCommand: string | null,
 *   reason: string | null,
 * }>}
 */
export async function getHookStatus(repoPath, opts) {
  const v = await validateRepoPath(repoPath)
  const expected = buildHookEntry(opts)
  const expectedCommand = expected.hooks[0].command
  if (!v.ok) {
    return {
      installed: false,
      settingsExists: false,
      settingsPath: null,
      expectedCommand,
      currentCommand: null,
      reason: v.reason,
    }
  }
  const settingsPath = fwd(join(v.absPath, '.claude', 'settings.json'))
  let raw
  try {
    raw = await fs.readFile(settingsPath, 'utf8')
  } catch {
    return {
      installed: false,
      settingsExists: false,
      settingsPath,
      expectedCommand,
      currentCommand: null,
      reason: null,
    }
  }
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    return {
      installed: false,
      settingsExists: true,
      settingsPath,
      expectedCommand,
      currentCommand: null,
      reason: 'settings_corrupt',
    }
  }
  const post = parsed?.hooks?.PostToolUse
  const idx = findOurEntryIndex(post, expected.matcher)
  if (idx < 0) {
    return {
      installed: false,
      settingsExists: true,
      settingsPath,
      expectedCommand,
      currentCommand: null,
      reason: null,
    }
  }
  const current = post[idx]
  const currentCommand = current?.hooks?.[0]?.command ?? null
  const installed = hookEntryEqual(current, expected)
  return {
    installed,
    settingsExists: true,
    settingsPath,
    expectedCommand,
    currentCommand,
    reason: installed ? null : 'outdated_command',
  }
}

/**
 * Atomically install (or update) the hook in a repo's
 * `.claude/settings.json`. Idempotent on second run.
 *
 * @param {string} repoPath
 * @param {{ logDir: string, blastRadiusRoot: string }} opts
 * @returns {Promise<{
 *   ok: boolean,
 *   action?: 'created' | 'updated' | 'noop',
 *   settingsPath?: string,
 *   backupPath?: string | null,
 *   reason?: string,
 * }>}
 */
export async function installHook(repoPath, opts) {
  const v = await validateRepoPath(repoPath)
  if (!v.ok) return { ok: false, reason: v.reason }
  const abs = v.absPath
  const claudeDir = join(abs, '.claude')
  const settingsPath = join(claudeDir, 'settings.json')
  const ourEntry = buildHookEntry(opts)

  // mkdir -p .claude/
  await fs.mkdir(claudeDir, { recursive: true })

  // Read existing settings if any.
  let existingRaw = null
  let settings = null
  try {
    existingRaw = await fs.readFile(settingsPath, 'utf8')
    if (existingRaw.trim()) settings = JSON.parse(existingRaw)
    else settings = {}
  } catch (err) {
    if (err.code !== 'ENOENT') return { ok: false, reason: 'settings_read_failed' }
    settings = null // marker: file did not exist
  }

  const created = settings === null
  if (settings === null) settings = {}
  if (!settings || typeof settings !== 'object') settings = {}
  if (!settings.hooks || typeof settings.hooks !== 'object') settings.hooks = {}
  if (!Array.isArray(settings.hooks.PostToolUse)) settings.hooks.PostToolUse = []

  // Idempotency check (semantic, not byte-equal).
  const existingIdx = findOurEntryIndex(settings.hooks.PostToolUse, ourEntry.matcher)
  if (existingIdx >= 0 && hookEntryEqual(settings.hooks.PostToolUse[existingIdx], ourEntry)) {
    return {
      ok: true,
      action: 'noop',
      settingsPath: fwd(settingsPath),
      backupPath: null,
    }
  }

  // Drop only OUR prior entry (any version of it); preserve everything else.
  const preserved = []
  for (const entry of settings.hooks.PostToolUse) {
    if (!entry || typeof entry !== 'object') { preserved.push(entry); continue }
    if (entry.matcher === ourEntry.matcher) {
      const hooks = Array.isArray(entry.hooks) ? entry.hooks : []
      const isOurs = hooks.some(
        (h) => h && typeof h.command === 'string' && h.command.includes('log-touch.js'),
      )
      if (isOurs) continue // drop
    }
    preserved.push(entry)
  }
  settings.hooks.PostToolUse = [...preserved, ourEntry]

  // Backup existing file if we're modifying one.
  let backupPath = null
  if (!created && existingRaw != null) {
    backupPath = `${settingsPath}.bak.${timestamp()}`
    await fs.writeFile(backupPath, existingRaw, 'utf8')
    if (platform() !== 'win32') {
      try { await fs.chmod(backupPath, 0o600) } catch { /* best effort */ }
    }
    backupPath = fwd(backupPath)
  }

  // Atomic write — tmp + rename, same pattern preferences.js + knowledgeStore.js use.
  const tmp = `${settingsPath}.tmp`
  const json = `${JSON.stringify(settings, null, 2)}\n`
  await fs.writeFile(tmp, json, { encoding: 'utf8', flag: 'w' })
  if (platform() !== 'win32') {
    try { await fs.chmod(tmp, 0o600) } catch { /* best effort */ }
  }
  await fs.rename(tmp, settingsPath)

  return {
    ok: true,
    action: created ? 'created' : 'updated',
    settingsPath: fwd(settingsPath),
    backupPath,
  }
}
