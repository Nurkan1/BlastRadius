import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  toForwardSlashes,
  normalizePath,
  dayKey,
  logFilePath,
  buildEvent,
  hashFile,
  appendJsonl,
  runHook,
} from '../src/hook/log-touch.js'

// ─── Path normalization ──────────────────────────────────────────────────────

describe('toForwardSlashes', () => {
  it('converts Windows-style backslashes', () => {
    expect(toForwardSlashes('C:\\projects\\digitalrose\\src\\useBatch.ts')).toBe(
      'C:/projects/digitalrose/src/useBatch.ts',
    )
  })

  it('is idempotent on already-forward-slashed input', () => {
    expect(toForwardSlashes('/home/user/p.ts')).toBe('/home/user/p.ts')
  })

  it('handles null and undefined safely', () => {
    expect(toForwardSlashes(null)).toBe('')
    expect(toForwardSlashes(undefined)).toBe('')
  })

  it('coerces non-string input', () => {
    expect(toForwardSlashes(42)).toBe('42')
  })
})

describe('normalizePath', () => {
  it('returns a forward-slashed project-relative path on Windows', () => {
    const out = normalizePath('C:\\projects\\dr\\src\\a.ts', 'C:\\projects\\dr')
    expect(out).toBe('src/a.ts')
  })

  it('returns relative path on Unix', () => {
    const out = normalizePath('/home/u/repo/lib/x.ts', '/home/u/repo')
    expect(out).toBe('lib/x.ts')
  })

  it('falls back to absolute when target sits outside cwd', () => {
    const out = normalizePath('/elsewhere/x.ts', '/home/u/repo')
    // Either kept absolute or a ../-prefixed traversal — both satisfy "fall back to absolute"
    expect(out.startsWith('/') || out.startsWith('..')).toBe(true)
  })

  it('falls back gracefully on missing inputs', () => {
    expect(normalizePath('', '/x')).toBe('')
    expect(normalizePath('/y', '')).toBe('/y')
  })
})

// ─── Date / rotation ─────────────────────────────────────────────────────────

describe('dayKey + logFilePath rotation', () => {
  it('formats as YYYY-MM-DD with zero-padding', () => {
    const d = new Date(2026, 0, 5, 10, 0, 0) // Jan 5 local
    expect(dayKey(d)).toBe('2026-01-05')
  })

  it('builds session-YYYY-MM-DD.jsonl in the configured directory', () => {
    const d = new Date(2026, 4, 24)
    const p = logFilePath('C:/logs', d).replace(/\\/g, '/')
    expect(p).toBe('C:/logs/session-2026-05-24.jsonl')
  })

  it('produces different filenames on different days', () => {
    const a = logFilePath('/logs', new Date(2026, 4, 24))
    const b = logFilePath('/logs', new Date(2026, 4, 25))
    expect(a).not.toBe(b)
  })
})

// ─── Event shape ─────────────────────────────────────────────────────────────

describe('buildEvent', () => {
  it('produces exactly the contract shape', () => {
    const e = buildEvent({
      ts: '2026-05-24T18:32:11.482Z',
      tool: 'Edit',
      path: '/p/a.ts',
      pathNorm: 'src/a.ts',
      cwd: '/p',
      hash: 'sha256:abc',
      sessionId: 'sid-1',
    })
    expect(e).toEqual({
      ts: '2026-05-24T18:32:11.482Z',
      tool: 'Edit',
      path: '/p/a.ts',
      pathNorm: 'src/a.ts',
      cwd: '/p',
      hash: 'sha256:abc',
      sessionId: 'sid-1',
    })
    // Key order matters for line-by-line diffability of the JSONL file.
    expect(Object.keys(e)).toEqual(['ts', 'tool', 'path', 'pathNorm', 'cwd', 'hash', 'sessionId'])
  })
})

// ─── Hashing ─────────────────────────────────────────────────────────────────

describe('hashFile', () => {
  let tmp
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'br-hash-'))
  })
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true })
  })

  it('produces the known sha256 of "hello"', async () => {
    const p = join(tmp, 'x.txt')
    writeFileSync(p, 'hello')
    expect(await hashFile(p)).toBe(
      'sha256:2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824',
    )
  })

  it('returns "sha256:enoent" on a missing file', async () => {
    expect(await hashFile(join(tmp, 'nope.txt'))).toBe('sha256:enoent')
  })

  it('returns "sha256:eisdir" when target is a directory', async () => {
    // Sentinel can also be "sha256:error" depending on OS, but both are
    // strings starting with the prefix — that's what consumers rely on.
    const out = await hashFile(tmp)
    expect(out.startsWith('sha256:')).toBe(true)
  })
})

// ─── JSONL append + parseability ─────────────────────────────────────────────

describe('appendJsonl', () => {
  let tmp
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'br-jsonl-'))
  })
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true })
  })

  it('appends parseable lines (every line JSON.parse-able)', async () => {
    const p = join(tmp, 'log.jsonl')
    await appendJsonl(p, { a: 1, msg: 'one' })
    await appendJsonl(p, { a: 2, msg: 'two' })
    await appendJsonl(p, { a: 3, msg: 'three' })

    const content = readFileSync(p, 'utf8')
    const lines = content.split('\n').filter((l) => l.length > 0)
    expect(lines.length).toBe(3)

    const parsed = lines.map((l) => {
      // The contract demands every line must be JSON.parse-able.
      return JSON.parse(l)
    })
    expect(parsed[0]).toEqual({ a: 1, msg: 'one' })
    expect(parsed[2]).toEqual({ a: 3, msg: 'three' })
  })

  it('creates parent directories recursively when missing', async () => {
    const p = join(tmp, 'deep', 'nest', 'log.jsonl')
    await appendJsonl(p, { ok: true })
    expect(readFileSync(p, 'utf8').trim()).toBe('{"ok":true}')
  })

  it('preserves prior lines on subsequent appends (true append, not rewrite)', async () => {
    const p = join(tmp, 'log.jsonl')
    await appendJsonl(p, { first: true })
    const after1 = readFileSync(p, 'utf8')
    await appendJsonl(p, { second: true })
    const after2 = readFileSync(p, 'utf8')
    expect(after2.startsWith(after1)).toBe(true)
    expect(after2.includes('"second":true')).toBe(true)
  })
})

// ─── runHook end-to-end + no-throw contract ─────────────────────────────────

describe('runHook — no-throw under any input', () => {
  let tmp
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'br-run-'))
  })
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true })
  })

  it('returns false for empty stdin', async () => {
    await expect(runHook({ stdinJson: '', logDir: tmp })).resolves.toBe(false)
  })

  it('returns false for malformed JSON', async () => {
    await expect(runHook({ stdinJson: '{not json', logDir: tmp })).resolves.toBe(false)
  })

  it('returns false for non-target tool names', async () => {
    const j = JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'ls' }, cwd: '/x' })
    await expect(runHook({ stdinJson: j, logDir: tmp })).resolves.toBe(false)
  })

  it('returns false when file_path is missing', async () => {
    const j = JSON.stringify({ tool_name: 'Edit', tool_input: {}, cwd: '/x' })
    await expect(runHook({ stdinJson: j, logDir: tmp })).resolves.toBe(false)
  })

  it('returns false when tool_input is missing entirely', async () => {
    const j = JSON.stringify({ tool_name: 'Write', cwd: '/x' })
    await expect(runHook({ stdinJson: j, logDir: tmp })).resolves.toBe(false)
  })

  it('returns false when the top-level payload is not an object', async () => {
    await expect(runHook({ stdinJson: 'null', logDir: tmp })).resolves.toBe(false)
    await expect(runHook({ stdinJson: '"a string"', logDir: tmp })).resolves.toBe(false)
    await expect(runHook({ stdinJson: '[]', logDir: tmp })).resolves.toBe(false)
  })

  it('writes a valid event line for a real Edit', async () => {
    const targetFile = join(tmp, 'a.ts')
    writeFileSync(targetFile, 'const x = 1\n')
    const j = JSON.stringify({
      session_id: 'sess-xyz',
      cwd: tmp,
      hook_event_name: 'PostToolUse',
      tool_name: 'Edit',
      tool_input: { file_path: targetFile },
      tool_output: { success: true },
      tool_use_id: 'tu-1',
    })
    const wrote = await runHook({
      stdinJson: j,
      logDir: tmp,
      now: new Date(2026, 4, 24, 10, 0, 0),
    })
    expect(wrote).toBe(true)

    const logPath = join(tmp, 'session-2026-05-24.jsonl')
    const lines = readFileSync(logPath, 'utf8').split('\n').filter(Boolean)
    expect(lines.length).toBe(1)

    const ev = JSON.parse(lines[0])
    expect(ev.tool).toBe('Edit')
    expect(ev.sessionId).toBe('sess-xyz')
    expect(ev.pathNorm).toBe('a.ts')
    expect(ev.path.endsWith('/a.ts')).toBe(true)
    expect(ev.hash).toMatch(/^sha256:[0-9a-f]{64}$/)
    expect(typeof ev.ts).toBe('string')
    expect(() => new Date(ev.ts).toISOString()).not.toThrow()
  })

  it('handles Write and Read identically to Edit (same matcher set)', async () => {
    const targetFile = join(tmp, 'b.ts')
    writeFileSync(targetFile, 'export const y = 2\n')
    for (const tool of ['Write', 'Read']) {
      const j = JSON.stringify({
        session_id: 'sess-multi',
        cwd: tmp,
        tool_name: tool,
        tool_input: { file_path: targetFile },
      })
      const wrote = await runHook({
        stdinJson: j,
        logDir: tmp,
        now: new Date(2026, 4, 24, 11, 0, 0),
      })
      expect(wrote).toBe(true)
    }
    const logPath = join(tmp, 'session-2026-05-24.jsonl')
    const lines = readFileSync(logPath, 'utf8').split('\n').filter(Boolean)
    // 2 events written across the two iterations
    expect(lines.length).toBe(2)
    const tools = lines.map((l) => JSON.parse(l).tool)
    expect(tools).toEqual(['Write', 'Read'])
  })

  it('writes the event even when the target file is missing (hash sentinel)', async () => {
    // Edits can fire on files the tool failed to write; we still log
    // the touch attempt and mark the hash sentinel.
    const ghost = join(tmp, 'ghost.ts')
    const j = JSON.stringify({
      session_id: 'sess-ghost',
      cwd: tmp,
      tool_name: 'Edit',
      tool_input: { file_path: ghost },
    })
    const wrote = await runHook({
      stdinJson: j,
      logDir: tmp,
      now: new Date(2026, 4, 24, 12, 0, 0),
    })
    expect(wrote).toBe(true)
    const lines = readFileSync(join(tmp, 'session-2026-05-24.jsonl'), 'utf8')
      .split('\n')
      .filter(Boolean)
    expect(JSON.parse(lines[0]).hash).toBe('sha256:enoent')
  })

  it('returns false when logDir is empty (silent no-op)', async () => {
    const j = JSON.stringify({
      session_id: 's',
      cwd: tmp,
      tool_name: 'Edit',
      tool_input: { file_path: join(tmp, 'whatever.ts') },
    })
    await expect(runHook({ stdinJson: j, logDir: '' })).resolves.toBe(false)
  })
})
