#!/usr/bin/env node
/**
 * BlastRadius — log-touch hook.
 *
 * Runs on every Claude Code `PostToolUse` event whose tool matches
 * `Edit|Write|Read`. Appends one JSONL line per event to:
 *
 *     $BLASTRADIUS_LOG_DIR/session-YYYY-MM-DD.jsonl
 *
 * Contract (Claude Code stdin JSON, current docs):
 *     {
 *       session_id:       string,
 *       cwd:              string,
 *       hook_event_name:  "PostToolUse",
 *       tool_name:        "Edit" | "Write" | "Read" | ...,
 *       tool_input:       { file_path: string, ... },
 *       tool_output:      { ... },
 *       tool_use_id:      string
 *     }
 *
 * Hard guarantees (per spec):
 *   - Always exits 0. PostToolUse cannot block anyway, but we never
 *     surface stack traces to the user either.
 *   - Hard wall-clock budget of HARD_TIMEOUT_MS. If we don't make it,
 *     we abandon the event and exit 0 (better to lose one log line
 *     than to slow Claude Code down).
 *   - Append-only with explicit fsync after every write. The log file
 *     is never rewritten.
 *   - All errors flow to stderr via pino (never stdout). PostToolUse
 *     interprets stdout JSON, so we keep it clean.
 *
 * The pure helpers below are exported so `tests/log-touch.test.js`
 * can exercise them without spawning a subprocess.
 */

import { createHash } from 'node:crypto'
import { createReadStream, promises as fs } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import pino from 'pino'
import 'dotenv/config'

const HARD_TIMEOUT_MS = 95
const TARGET_TOOLS = new Set(['Edit', 'Write', 'Read'])

// pino → stderr only. Level "warn" by default to keep noise down; the
// hook is intentionally chatty only when something is unusual.
const logger = pino(
  { level: process.env.BLASTRADIUS_LOG_LEVEL || 'warn', base: { hook: 'log-touch' } },
  pino.destination(2),
)

// ─── Pure helpers (exported for tests) ───────────────────────────────────────

/** Convert backslashes to forward slashes. Idempotent. Null-safe. */
export function toForwardSlashes(p) {
  return String(p ?? '').replace(/\\/g, '/')
}

/**
 * Normalize an absolute path against a cwd. Returns the forward-slashed
 * project-relative path when `absPath` lives under `cwd`. Falls back to
 * the forward-slashed absolute path when the path is outside cwd or
 * when either input is missing — keeps `pathNorm` always a usable
 * string for downstream consumers.
 */
export function normalizePath(absPath, cwd) {
  const safeAbs = toForwardSlashes(absPath)
  const safeCwd = toForwardSlashes(cwd)
  if (!safeAbs) return ''
  if (!safeCwd) return safeAbs
  try {
    const rel = relative(safeCwd, safeAbs)
    if (!rel || rel.startsWith('..')) return safeAbs
    return toForwardSlashes(rel)
  } catch {
    return safeAbs
  }
}

/** YYYY-MM-DD in local time. Stable across midnight rollover only because
 *  the caller passes a consistent Date. */
export function dayKey(d = new Date()) {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

/** Compose the daily log file path. */
export function logFilePath(logDir, d = new Date()) {
  return join(logDir, `session-${dayKey(d)}.jsonl`)
}

/**
 * Build the event payload. Pure function — no IO.
 *
 * `agent` is OPTIONAL for backward compatibility:
 *   - If provided (post-refactor emitters), it is included in the
 *     output and reads downstream use it directly.
 *   - If omitted (the Claude Code PostToolUse hook today, plus every
 *     pre-refactor JSONL file on disk), it is NOT written. The
 *     `inferAgent` helper in src/server/agentInference.js defaults
 *     those events to "claude", preserving the historical view.
 *
 * Why the conditional include rather than always writing
 * `agent: "claude"`: keeps existing fixtures + golden files
 * byte-identical, and avoids a meaningless field bloating every legacy
 * line. The field is only present when the emitter has something
 * specific to say.
 */
export function buildEvent({ ts, tool, path: filePath, pathNorm, cwd, hash, sessionId, agent }) {
  const ev = { ts, tool, path: filePath, pathNorm, cwd, hash, sessionId }
  if (typeof agent === 'string' && agent.length > 0) {
    ev.agent = agent
  }
  return ev
}

/**
 * Stream-hash a file with SHA-256. Streaming (vs readFile) keeps memory
 * usage bounded for large files. Returns a sentinel string on error so
 * the JSONL `hash` field is always a string of the form `"sha256:..."`.
 */
export async function hashFile(absPath) {
  return new Promise((resolveHash) => {
    try {
      const hasher = createHash('sha256')
      const stream = createReadStream(absPath)
      stream.on('data', (chunk) => hasher.update(chunk))
      stream.on('end', () => resolveHash(`sha256:${hasher.digest('hex')}`))
      stream.on('error', (err) => {
        if (err && err.code === 'ENOENT') return resolveHash('sha256:enoent')
        if (err && err.code === 'EACCES') return resolveHash('sha256:eacces')
        if (err && err.code === 'EISDIR') return resolveHash('sha256:eisdir')
        resolveHash('sha256:error')
      })
    } catch {
      resolveHash('sha256:error')
    }
  })
}

/**
 * Append a JSON event as one line to `filePath`. Creates the parent
 * directory tree on demand. Opens in append mode and fsyncs explicitly
 * so the write is durable before we return. POSIX O_APPEND guarantees
 * atomic appends up to PIPE_BUF; on Windows the file lock + small line
 * size keeps interleaving impossible in practice.
 */
export async function appendJsonl(filePath, event) {
  await fs.mkdir(dirname(filePath), { recursive: true })
  const fh = await fs.open(filePath, 'a')
  try {
    const line = JSON.stringify(event) + '\n'
    await fh.write(line)
    await fh.sync()
  } finally {
    await fh.close()
  }
}

/**
 * Pull `--log-dir <path>` out of an argv array, if present.
 * Returns '' when missing or malformed. Exported for tests.
 *
 * Supports both forms:
 *   --log-dir /path/to/logs
 *   --log-dir=/path/to/logs
 *
 * Phase 5 fix: the install-hook.ps1 now bakes the log dir into the
 * hook command at install time, so the hook is self-configured and
 * no longer depends on a BLASTRADIUS_LOG_DIR env var in Claude
 * Code's process. The env var remains as a fallback for users with
 * older installations.
 */
export function parseLogDirArg(argv) {
  if (!Array.isArray(argv)) return ''
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]
    if (typeof a !== 'string') continue
    if (a === '--log-dir' && i + 1 < argv.length) {
      const next = argv[i + 1]
      return typeof next === 'string' ? next : ''
    }
    if (a.startsWith('--log-dir=')) {
      return a.slice('--log-dir='.length)
    }
  }
  return ''
}

/** Read stdin to a UTF-8 string. Returns '' on EOF with no data. */
export async function readStdin() {
  const chunks = []
  for await (const chunk of process.stdin) chunks.push(chunk)
  return Buffer.concat(chunks).toString('utf8')
}

/**
 * The core hook routine. Pure of process.exit etc. — returns a boolean
 * indicating whether an event was written so tests can assert behavior.
 * All errors are swallowed (best-effort logger).
 */
export async function runHook({ stdinJson, logDir, now = new Date() } = {}) {
  let payload
  try {
    payload = JSON.parse(stdinJson || '')
  } catch {
    return false
  }
  if (!payload || typeof payload !== 'object') return false

  const tool = typeof payload.tool_name === 'string' ? payload.tool_name : ''
  if (!TARGET_TOOLS.has(tool)) return false

  const filePathRaw =
    payload.tool_input && typeof payload.tool_input.file_path === 'string'
      ? payload.tool_input.file_path
      : ''
  if (!filePathRaw) return false

  const cwdRaw =
    typeof payload.cwd === 'string' && payload.cwd
      ? payload.cwd
      : process.env.CLAUDE_PROJECT_DIR || process.cwd()

  const sessionId = typeof payload.session_id === 'string' ? payload.session_id : ''

  // Resolve to absolute and forward-slash everything user-facing.
  const absPath = isAbsolute(filePathRaw) ? filePathRaw : resolve(cwdRaw, filePathRaw)

  if (!logDir) {
    // No destination configured — surface a warn and exit caller-side.
    logger.warn('BLASTRADIUS_LOG_DIR not configured; event dropped')
    return false
  }

  const hash = await hashFile(absPath)

  const event = buildEvent({
    ts: now.toISOString(),
    tool,
    path: toForwardSlashes(absPath),
    pathNorm: normalizePath(absPath, cwdRaw),
    cwd: toForwardSlashes(cwdRaw),
    hash,
    sessionId,
  })

  try {
    await appendJsonl(logFilePath(logDir, now), event)
    return true
  } catch (err) {
    logger.warn({ err: String(err) }, 'append failed')
    return false
  }
}

// ─── CLI entry point ─────────────────────────────────────────────────────────
//
// We only run the CLI block when this file is executed directly (e.g.
// `node src/hook/log-touch.js`), never when imported as a module (tests).
// The pathToFileURL comparison is the idiomatic ESM check.

const isMain = (() => {
  try {
    if (!process.argv[1]) return false
    return import.meta.url === pathToFileURL(resolve(process.argv[1])).href
  } catch {
    return false
  }
})()

if (isMain) {
  // Hard timeout: bail with exit 0 if we exceed the budget. unref() so the
  // timer never holds the process alive on its own.
  const timer = setTimeout(() => {
    logger.warn({ reason: 'timeout', budgetMs: HARD_TIMEOUT_MS }, 'BlastRadius hook timeout')
    process.exit(0)
  }, HARD_TIMEOUT_MS)
  timer.unref()

  ;(async () => {
    try {
      const stdinJson = await readStdin()
      // Source-of-truth order for the log dir:
      //   1. --log-dir CLI flag  (baked in by install-hook.ps1)
      //   2. BLASTRADIUS_LOG_DIR env var  (legacy / manual)
      // Either is fine; the CLI flag wins so the install-time choice
      // can't be silently overridden by a stale env var in the user's
      // shell.
      const logDir = parseLogDirArg(process.argv) || process.env.BLASTRADIUS_LOG_DIR || ''
      await runHook({ stdinJson, logDir })
    } catch (err) {
      logger.warn({ err: String(err) }, 'BlastRadius hook unexpected error')
    } finally {
      clearTimeout(timer)
      process.exit(0)
    }
  })()
}

// Suppress "unused" warning when the file is imported by tests and
// fileURLToPath isn't referenced in the CLI branch (it is — kept for
// future debug logging). Explicit no-op below avoids accidental tree
// shaking surprises in some bundlers.
void fileURLToPath
