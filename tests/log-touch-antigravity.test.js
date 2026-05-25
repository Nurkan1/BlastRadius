/**
 * Tests for src/hook/log-touch-antigravity.js.
 *
 * Two test families live here:
 *
 *   Family A — unit tests (no spawn). Exercise the pure exported
 *              helpers (validatePayload, resolveWorkspaceForPath,
 *              normalizePathForEvent, safeHash, TOOL_MAP). Fast,
 *              hermetic, no I/O beyond a per-test tmpdir.
 *
 *   Family B — integration tests (spawn `node hook.js` with real
 *              stdin/stdout pipes). Cover the contract that can
 *              only be measured at process boundary:
 *                * critical invariant: `decision:allow` is the
 *                  first stdout line in EVERY scenario.
 *                * JSONL append actually lands on disk.
 *                * Diagnostic log captures reason codes correctly.
 *                * stderr stays silent in normal operation.
 *                * Performance budget — median < 75 ms over 5 warm
 *                  runs after a discarded warm-up. Flaky-skip when
 *                  variance > 30 ms so CI on noisy runners doesn't
 *                  fail spuriously.
 *
 * Cleanup contract: every test creates its OWN tmpdir under
 * os.tmpdir() and afterEach removes it unconditionally (even on
 * failure), so tests never contaminate each other.
 */

import { describe, it, expect, beforeEach, afterEach, beforeAll } from 'vitest'
import { spawn } from 'node:child_process'
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { performance } from 'node:perf_hooks'

import {
  validatePayload,
  resolveWorkspaceForPath,
  normalizePathForEvent,
  safeHash,
  TOOL_MAP,
  DECISION_ALLOW,
  AGENT_NAME,
} from '../src/hook/log-touch-antigravity.js'
import { MAX_HASH_BYTES, HOOK_WARN_REASONS } from '../src/hook/log-touch.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const HOOK_PATH = join(__dirname, '..', 'src', 'hook', 'log-touch-antigravity.js')

// ─── Per-test scratch dir ───────────────────────────────────────────────────

let scratchDir

beforeEach(() => {
  scratchDir = mkdtempSync(join(tmpdir(), 'br-antigrav-test-'))
})

afterEach(() => {
  // Unconditional cleanup so a failing test doesn't leak its tmpdir
  // and so the next test starts from a guaranteed-empty state.
  try {
    rmSync(scratchDir, { recursive: true, force: true })
  } catch {
    // best effort; some platforms hold file handles briefly
  }
})

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Spawn the hook script as a child process with the given stdin.
 * Resolves with { code, stdout, stderr, elapsedMs }. Never rejects on
 * a non-zero exit — that is data we want to assert on.
 */
function runHook({ stdin = '', logDir, extraEnv = {} } = {}) {
  return new Promise((resolve, reject) => {
    const start = performance.now()
    const env = { ...process.env, ...extraEnv }
    if (logDir) env.BLASTRADIUS_LOG_DIR = logDir
    const proc = spawn(process.execPath, [HOOK_PATH], {
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    proc.stdout.on('data', (c) => { stdout += c.toString() })
    proc.stderr.on('data', (c) => { stderr += c.toString() })
    proc.on('close', (code) => {
      resolve({ code, stdout, stderr, elapsedMs: performance.now() - start })
    })
    proc.on('error', reject)
    proc.stdin.write(stdin)
    proc.stdin.end()
  })
}

/** Read every JSONL line from the day's log file. Returns [] if no
 *  file or file is empty. setImmediate-based append means tests should
 *  wait a tick after the hook returns before calling this. */
function readEventLog(logDir) {
  if (!existsSync(logDir)) return []
  const files = readdirSync(logDir).filter(
    (f) => f.startsWith('session-') && f.endsWith('.jsonl'),
  )
  if (files.length === 0) return []
  const raw = readFileSync(join(logDir, files[0]), 'utf8').trim()
  if (!raw) return []
  return raw.split('\n').map((line) => JSON.parse(line))
}

/** Read the diagnostic log lines. */
function readDiagLog(logDir) {
  const p = join(logDir, 'antigravity-hook.log')
  if (!existsSync(p)) return []
  const raw = readFileSync(p, 'utf8').trim()
  if (!raw) return []
  return raw.split('\n').map((line) => JSON.parse(line))
}

/** Small helper to wait one event-loop turn so setImmediate-appended
 *  events have a chance to land before we read the log. */
function tick(ms = 50) {
  return new Promise((r) => setTimeout(r, ms))
}

/** Build a well-formed Antigravity payload for a given file. */
function makePayload({ toolName, absPath, workspacePaths, conversationId = 'conv-123' }) {
  return {
    conversationId,
    workspacePaths,
    stepIdx: 0,
    toolCall: {
      name: toolName,
      args: { Path: absPath },
    },
  }
}

// ════════════════════════════════════════════════════════════════════════════
// Family A — unit tests on the pure exports
// ════════════════════════════════════════════════════════════════════════════

// ─── validatePayload ────────────────────────────────────────────────────────

describe('validatePayload (pure)', () => {
  it('accepts a complete official payload and returns a normalised summary', () => {
    const payload = makePayload({
      toolName: 'edit_file',
      absPath: '/abs/path/to/foo.ts',
      workspacePaths: ['/abs/path'],
    })
    const out = validatePayload(payload)
    expect(out).not.toBeNull()
    expect(out.toolName).toBe('edit_file')
    expect(out.absPath).toBe('/abs/path/to/foo.ts')
    expect(out.workspacePaths).toEqual(['/abs/path'])
    expect(out.conversationId).toBe('conv-123')
  })

  it('rejects null / non-object', () => {
    expect(validatePayload(null)).toBeNull()
    expect(validatePayload(undefined)).toBeNull()
    expect(validatePayload('not an object')).toBeNull()
    expect(validatePayload(42)).toBeNull()
  })

  it('rejects missing toolCall', () => {
    expect(validatePayload({ workspacePaths: ['/x'] })).toBeNull()
    expect(validatePayload({ workspacePaths: ['/x'], toolCall: null })).toBeNull()
    expect(validatePayload({ workspacePaths: ['/x'], toolCall: 'edit' })).toBeNull()
  })

  it('rejects missing or empty toolCall.name', () => {
    const base = { workspacePaths: ['/x'], toolCall: { args: { Path: '/x/y.ts' } } }
    expect(validatePayload(base)).toBeNull()
    expect(validatePayload({ ...base, toolCall: { name: '', args: base.toolCall.args } })).toBeNull()
    expect(validatePayload({ ...base, toolCall: { name: 42, args: base.toolCall.args } })).toBeNull()
  })

  it('rejects missing toolCall.args.Path', () => {
    const base = { workspacePaths: ['/x'], toolCall: { name: 'edit_file', args: {} } }
    expect(validatePayload(base)).toBeNull()
    expect(validatePayload({ ...base, toolCall: { name: 'edit_file', args: { Path: '' } } })).toBeNull()
  })

  it('rejects missing or empty workspacePaths', () => {
    const baseTc = { name: 'edit_file', args: { Path: '/x/y.ts' } }
    expect(validatePayload({ toolCall: baseTc })).toBeNull()
    expect(validatePayload({ toolCall: baseTc, workspacePaths: [] })).toBeNull()
    expect(validatePayload({ toolCall: baseTc, workspacePaths: 'not an array' })).toBeNull()
  })

  it('defaults conversationId to "" when missing or non-string', () => {
    const payload = {
      workspacePaths: ['/x'],
      toolCall: { name: 'edit_file', args: { Path: '/x/y.ts' } },
    }
    expect(validatePayload(payload).conversationId).toBe('')
    expect(validatePayload({ ...payload, conversationId: 42 }).conversationId).toBe('')
  })
})

// ─── TOOL_MAP ───────────────────────────────────────────────────────────────

describe('TOOL_MAP (frozen)', () => {
  it('maps the five Antigravity tools to heat-tool colors', () => {
    expect(TOOL_MAP.edit_file).toBe('Edit')
    expect(TOOL_MAP.patch_file).toBe('Edit')
    expect(TOOL_MAP.write_file).toBe('Write')
    expect(TOOL_MAP.view_file).toBe('Read')
    expect(TOOL_MAP.grep_search).toBe('Read')
  })

  it('does NOT include run_command (Design decision 3 in audit doc)', () => {
    expect(TOOL_MAP.run_command).toBeUndefined()
  })

  it('is frozen — UI / future tweaks cannot tamper at runtime', () => {
    expect(() => { TOOL_MAP.edit_file = 'Read' }).toThrow()
  })
})

// ─── resolveWorkspaceForPath ────────────────────────────────────────────────

describe('resolveWorkspaceForPath (pure)', () => {
  it('returns the workspace that contains the file (single workspace)', () => {
    const out = resolveWorkspaceForPath('/a/b/c/file.ts', ['/a/b'])
    expect(out.contained).toBe(true)
    expect(out.workspacePath).toBe('/a/b')
  })

  it('multi-workspace: matches the workspace that contains the file (not [0])', () => {
    const out = resolveWorkspaceForPath('/repos/B/src/x.ts', ['/repos/A', '/repos/B', '/repos/C'])
    expect(out.contained).toBe(true)
    expect(out.workspacePath).toBe('/repos/B')
  })

  it('falls back to workspacePaths[0] when no workspace contains the file', () => {
    const out = resolveWorkspaceForPath('/outside/foo.ts', ['/a', '/b'])
    expect(out.contained).toBe(false)
    expect(out.workspacePath).toBe('/a')
  })

  it('handles Windows-style paths and normalises forward-slashes', () => {
    const out = resolveWorkspaceForPath('C:\\repos\\x\\foo.ts', ['C:\\repos\\x'])
    expect(out.contained).toBe(true)
    expect(out.workspacePath).toBe('C:/repos/x')
  })

  it('strips trailing slashes on the workspace before comparing', () => {
    const out = resolveWorkspaceForPath('/a/b/file.ts', ['/a/b/'])
    expect(out.contained).toBe(true)
    expect(out.workspacePath).toBe('/a/b')
  })

  it('exact-match the workspace root itself (file == workspace) is considered contained', () => {
    // This is a corner case but the BFS prefix check should treat it as
    // "inside the workspace" rather than "outside" — the workspace
    // directory itself is part of the workspace.
    const out = resolveWorkspaceForPath('/repo', ['/repo'])
    expect(out.contained).toBe(true)
  })
})

// ─── normalizePathForEvent ──────────────────────────────────────────────────

describe('normalizePathForEvent (pure)', () => {
  it('returns the repo-relative slash-normalised path inside a workspace', () => {
    expect(normalizePathForEvent('/repo/src/x.ts', '/repo')).toBe('src/x.ts')
    expect(normalizePathForEvent('C:\\repo\\src\\x.ts', 'C:/repo')).toBe('src/x.ts')
  })

  it('returns the full forward-slashed path when outside the workspace', () => {
    // path_outside_workspaces fallback signal — the caller already
    // emitted a warning, this function just preserves the full path
    // so downstream consumers can see what was actually touched.
    expect(normalizePathForEvent('/elsewhere/foo.ts', '/repo')).toBe('/elsewhere/foo.ts')
  })
})

// ─── safeHash ───────────────────────────────────────────────────────────────

describe('safeHash (with real files)', () => {
  it('returns sha256:* for a normal small file', async () => {
    const f = join(scratchDir, 'small.txt')
    writeFileSync(f, 'hello world')
    const result = await safeHash(f, scratchDir)
    expect(result).toMatch(/^sha256:[a-f0-9]{64}$/)
  })

  it('returns skipped:unreadable for a non-existent file + writes info diag log', async () => {
    const f = join(scratchDir, 'does-not-exist.txt')
    const result = await safeHash(f, scratchDir)
    expect(result).toBe('skipped:unreadable')
    const diag = readDiagLog(scratchDir)
    expect(diag.length).toBeGreaterThanOrEqual(1)
    expect(diag[0].reason).toBe(HOOK_WARN_REASONS.hash_skipped_unreadable)
    expect(diag[0].level).toBe('info')
  })

  it('returns skipped:large-file for a file just over MAX_HASH_BYTES', async () => {
    // Create a file 1 byte larger than the threshold. fs.truncate-like
    // sparse-file allocation keeps this fast even at 10 MB.
    const f = join(scratchDir, 'large.bin')
    writeFileSync(f, Buffer.alloc(0))
    // Allocate the file by writing one byte at the target offset.
    const fd = require('node:fs').openSync(f, 'r+')
    try {
      require('node:fs').ftruncateSync(fd, MAX_HASH_BYTES + 1)
    } finally {
      require('node:fs').closeSync(fd)
    }
    expect(statSync(f).size).toBe(MAX_HASH_BYTES + 1)
    const result = await safeHash(f, scratchDir)
    expect(result).toBe('skipped:large-file')
    const diag = readDiagLog(scratchDir)
    const large = diag.find((d) => d.reason === HOOK_WARN_REASONS.hash_skipped_large)
    expect(large).toBeDefined()
    expect(large.level).toBe('info')
    expect(large.detail).toContain(`size=${MAX_HASH_BYTES + 1}`)
  })
})

// ─── Constants sanity ───────────────────────────────────────────────────────

describe('exported constants', () => {
  it('DECISION_ALLOW is exactly the engine-expected response with trailing newline', () => {
    expect(DECISION_ALLOW).toBe('{"decision":"allow"}\n')
  })

  it('AGENT_NAME matches the canonical inferAgent value', () => {
    expect(AGENT_NAME).toBe('antigravity')
  })

  it('MAX_HASH_BYTES is 10 MB', () => {
    expect(MAX_HASH_BYTES).toBe(10 * 1024 * 1024)
  })

  it('HOOK_WARN_REASONS exposes all six documented codes and is frozen', () => {
    expect(HOOK_WARN_REASONS.malformed_stdin).toBe('malformed_stdin')
    expect(HOOK_WARN_REASONS.schema_partial).toBe('schema_partial')
    expect(HOOK_WARN_REASONS.tool_unsupported).toBe('tool_unsupported')
    expect(HOOK_WARN_REASONS.path_outside_workspaces).toBe('path_outside_workspaces')
    expect(HOOK_WARN_REASONS.hash_skipped_large).toBe('hash_skipped_large')
    expect(HOOK_WARN_REASONS.hash_skipped_unreadable).toBe('hash_skipped_unreadable')
    expect(() => { HOOK_WARN_REASONS.malformed_stdin = 'xxx' }).toThrow()
  })
})

// ════════════════════════════════════════════════════════════════════════════
// Family B — integration tests (real spawn)
// ════════════════════════════════════════════════════════════════════════════

describe('integration: critical invariant (decision:allow first line of stdout)', () => {
  // The invariant we care about is "decision:allow is emitted before
  // ANY parse / file I/O / hash". The empirical proxy is "decision:allow
  // is the first line of stdout in every scenario, including ones that
  // hit error paths". Five scenarios cover every branch the hook can
  // take in main() before it writes events.

  it('valid full payload', async () => {
    const workspace = scratchDir
    const filePath = join(workspace, 'foo.ts')
    writeFileSync(filePath, 'export const x = 1')
    const stdin = JSON.stringify(makePayload({
      toolName: 'edit_file', absPath: filePath, workspacePaths: [workspace],
    }))
    const { stdout, code } = await runHook({ stdin, logDir: scratchDir })
    expect(stdout.split('\n')[0]).toBe('{"decision":"allow"}')
    expect(code).toBe(0)
  })

  it('empty stdin', async () => {
    const { stdout, code } = await runHook({ stdin: '', logDir: scratchDir })
    expect(stdout.split('\n')[0]).toBe('{"decision":"allow"}')
    expect(code).toBe(0)
  })

  it('malformed JSON', async () => {
    const { stdout, code } = await runHook({ stdin: '{"toolCall":', logDir: scratchDir })
    expect(stdout.split('\n')[0]).toBe('{"decision":"allow"}')
    expect(code).toBe(0)
  })

  it('schema partial (toolCall.name only, no args.Path)', async () => {
    const stdin = JSON.stringify({ toolCall: { name: 'edit_file' } })
    const { stdout, code } = await runHook({ stdin, logDir: scratchDir })
    expect(stdout.split('\n')[0]).toBe('{"decision":"allow"}')
    expect(code).toBe(0)
  })

  it('1 MB of garbage stdin', async () => {
    const garbage = '{"junk":"' + 'A'.repeat(1024 * 1024) + '"}'  // unterminated string
    const { stdout, code } = await runHook({
      stdin: garbage.slice(0, -2),  // truncate to ensure JSON.parse rejects
      logDir: scratchDir,
    })
    expect(stdout.split('\n')[0]).toBe('{"decision":"allow"}')
    expect(code).toBe(0)
  })
})

describe('integration: JSONL append + agent attribution', () => {
  it('writes a single event with agent="antigravity" and the inferred tool', async () => {
    const workspace = scratchDir
    const filePath = join(workspace, 'src', 'foo.ts')
    require('node:fs').mkdirSync(join(workspace, 'src'), { recursive: true })
    writeFileSync(filePath, 'export const x = 1')
    const stdin = JSON.stringify(makePayload({
      toolName: 'patch_file',
      absPath: filePath,
      workspacePaths: [workspace],
      conversationId: 'real-conv-uuid-123',
    }))
    await runHook({ stdin, logDir: scratchDir })
    await tick(80) // give setImmediate the chance to land

    const events = readEventLog(scratchDir)
    expect(events.length).toBe(1)
    const ev = events[0]
    expect(ev.agent).toBe('antigravity')
    expect(ev.tool).toBe('Edit') // patch_file → Edit
    expect(ev.sessionId).toBe('real-conv-uuid-123')
    expect(ev.pathNorm).toBe('src/foo.ts')
    expect(ev.hash).toMatch(/^sha256:[a-f0-9]{64}$/)
  })

  it('view_file is mapped to Read', async () => {
    const workspace = scratchDir
    const filePath = join(workspace, 'README.md')
    writeFileSync(filePath, '# hi')
    const stdin = JSON.stringify(makePayload({
      toolName: 'view_file', absPath: filePath, workspacePaths: [workspace],
    }))
    await runHook({ stdin, logDir: scratchDir })
    await tick(80)
    const events = readEventLog(scratchDir)
    expect(events[0].tool).toBe('Read')
  })

  it('unknown tool name writes 0 events and 1 warn diag', async () => {
    const workspace = scratchDir
    const filePath = join(workspace, 'x.ts')
    writeFileSync(filePath, 'x')
    const stdin = JSON.stringify(makePayload({
      toolName: 'cast_spell',  // not in TOOL_MAP
      absPath: filePath,
      workspacePaths: [workspace],
    }))
    await runHook({ stdin, logDir: scratchDir })
    await tick(80)

    expect(readEventLog(scratchDir).length).toBe(0)
    const diag = readDiagLog(scratchDir)
    expect(diag.some((d) => d.reason === HOOK_WARN_REASONS.tool_unsupported)).toBe(true)
  })

  it('path outside every workspace emits warn + still logs the event', async () => {
    const workspace = scratchDir
    const filePath = join(workspace, 'inside.ts')
    writeFileSync(filePath, 'inside')

    // Lie about the workspace — point it at a sibling tmpdir that
    // doesn't contain the file. The hook should write a warn and fall
    // back to workspacePaths[0].
    const otherWs = mkdtempSync(join(tmpdir(), 'br-antigrav-other-ws-'))
    try {
      const stdin = JSON.stringify(makePayload({
        toolName: 'edit_file',
        absPath: filePath,
        workspacePaths: [otherWs],
      }))
      await runHook({ stdin, logDir: scratchDir })
      await tick(80)

      const events = readEventLog(scratchDir)
      expect(events.length).toBe(1)

      const diag = readDiagLog(scratchDir)
      expect(diag.some((d) => d.reason === HOOK_WARN_REASONS.path_outside_workspaces)).toBe(true)
    } finally {
      rmSync(otherWs, { recursive: true, force: true })
    }
  })
})

describe('integration: diagnostic log discipline', () => {
  it('malformed stdin writes ONE diag entry with reason=malformed_stdin', async () => {
    await runHook({ stdin: 'not json', logDir: scratchDir })
    await tick(40)
    const diag = readDiagLog(scratchDir)
    expect(diag.length).toBe(1)
    expect(diag[0].reason).toBe(HOOK_WARN_REASONS.malformed_stdin)
    expect(diag[0].level).toBe('warn')
    expect(typeof diag[0].rawLength).toBe('number')
    // Privacy guard: the raw payload must not appear in the detail.
    expect(diag[0].detail.length).toBeLessThanOrEqual(200)
  })

  it('valid invocation never writes to the diagnostic log', async () => {
    const workspace = scratchDir
    const filePath = join(workspace, 'foo.ts')
    writeFileSync(filePath, 'x')
    const stdin = JSON.stringify(makePayload({
      toolName: 'edit_file', absPath: filePath, workspacePaths: [workspace],
    }))
    await runHook({ stdin, logDir: scratchDir })
    await tick(80)
    expect(readDiagLog(scratchDir).length).toBe(0)
  })

  it('stderr stays silent under valid input', async () => {
    const workspace = scratchDir
    const filePath = join(workspace, 'foo.ts')
    writeFileSync(filePath, 'x')
    const stdin = JSON.stringify(makePayload({
      toolName: 'edit_file', absPath: filePath, workspacePaths: [workspace],
    }))
    const { stderr } = await runHook({ stdin, logDir: scratchDir })
    expect(stderr).toBe('')
  })

  it('stderr stays silent even on malformed stdin (no contamination of agent context)', async () => {
    const { stderr } = await runHook({ stdin: 'broken', logDir: scratchDir })
    expect(stderr).toBe('')
  })
})

// ─── Performance budget — protected by warm-up + variance check ─────────────

describe('integration: performance budget', () => {
  // Wallclock contract for this test (committed in
  // docs/antigravity-audit.md):
  //
  //   < 75 ms median  → quiet pass (the design target)
  //   75-100 ms       → pass with console.warn (acceptable on slower
  //                     runners; Node empty cold-start is ~65 ms on
  //                     a typical Windows box, so we're inside the
  //                     "slower runner" envelope here)
  //   ≥ 100 ms        → FAIL ("catastrophic regression" per the user-
  //                     defined contract)
  //   variance > 30 ms across 5 runs → flaky-skip (console.warn, no
  //                                    assertion). CI on shared
  //                                    runners shouldn't fail just
  //                                    because the box is noisy.
  //
  // The runner's first node-spawn is discarded as warm-up because
  // v8 JIT + ESM resolution amortises across subsequent spawns.
  //
  // The 50 ms DESIGN goal is unreachable in pure-wallclock terms on
  // Windows (Node cold-start alone is ~65 ms); it remains aspirational
  // and is what we'd target if we ever pre-spawned a daemon hook host.

  it('median wallclock < 100 ms over 5 warm runs (75 ms target)', async () => {
    const workspace = scratchDir
    const filePath = join(workspace, 'foo.ts')
    writeFileSync(filePath, 'export const x = 1')
    const stdin = JSON.stringify(makePayload({
      toolName: 'edit_file', absPath: filePath, workspacePaths: [workspace],
    }))

    // Warm-up: one spawn whose timing we discard.
    await runHook({ stdin, logDir: scratchDir })

    const times = []
    for (let i = 0; i < 5; i += 1) {
      // Fresh log subdir for each run so prior runs' files don't
      // affect the timing path (append vs create).
      const runLogDir = mkdtempSync(join(tmpdir(), 'br-perf-run-'))
      try {
        const { elapsedMs, code } = await runHook({ stdin, logDir: runLogDir })
        expect(code).toBe(0)
        times.push(elapsedMs)
      } finally {
        try { rmSync(runLogDir, { recursive: true, force: true }) } catch {}
      }
    }

    times.sort((a, b) => a - b)
    const median = times[2]
    const variance = times[4] - times[0]
    const timesStr = times.map((t) => t.toFixed(1)).join(', ')

    if (variance > 30) {
      // Flaky environment — log the metrics and skip the strict
      // assertion. The test still passes so CI doesn't go red on
      // shared runners, but the metric is visible in the output.
      console.warn(
        `[antigravity hook perf] variance ${variance.toFixed(1)} ms > 30 ms threshold; ` +
        `times=[${timesStr}] median=${median.toFixed(1)} ms ` +
        '— flaky-skip-CI (assertion skipped, test environment too noisy).',
      )
      return
    }

    if (median >= 100) {
      console.error(
        `[antigravity hook perf] CATASTROPHIC REGRESSION: median ${median.toFixed(1)} ms ` +
        `>= 100 ms ceiling; times=[${timesStr}]`,
      )
    } else if (median >= 75) {
      // Above target but below ceiling — emit a soft warning so the
      // metric stays visible without failing the test. Acceptable on
      // Windows / cold-cache runners where Node cold-start alone is
      // ~65 ms.
      console.warn(
        `[antigravity hook perf] median ${median.toFixed(1)} ms above 75 ms design target ` +
        `(but under 100 ms catastrophic ceiling); times=[${timesStr}]`,
      )
    }
    expect(median).toBeLessThan(100)
  })
})
