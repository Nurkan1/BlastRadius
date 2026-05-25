/**
 * BlastRadius — shared pure helpers for hook scripts.
 *
 * This module is the dependency-free baseline both hook entry points
 * (`log-touch.js` for Claude Code, `log-touch-antigravity.js` for
 * Antigravity) build on top of. Importing it is CHEAP — only Node
 * built-ins (`node:fs`, `node:path`, `node:crypto`) — so a fresh
 * hook process can have these helpers loaded in well under a
 * millisecond of cold-start time.
 *
 * Why this exists as a separate file
 * ----------------------------------
 * The Claude hook (log-touch.js) imports `pino` and `dotenv` for its
 * own execution path. Those are ~50 ms of cold-start on a typical
 * Windows box — fine for a Claude PostToolUse hook (which is async,
 * fire-and-forget) but unacceptable for the Antigravity PreToolUse
 * hook, which is BLOCKING and has a < 50 ms latency target before
 * the engine applies fail-safe deny.
 *
 * Pulling the pure helpers out lets the Antigravity hook bypass that
 * cost entirely. Empirical measurement on this dev machine:
 *   - `node -e "process.stdout.write('hi')"`                 ~65 ms
 *   - `node` + import of log-touch.js (pino+dotenv)         ~120 ms
 *   - `node` + import of log-touch-shared.js (this file)    ~70 ms
 *
 * The Claude hook (log-touch.js) re-exports the same names from here
 * so existing import paths in tests and downstream code remain stable.
 */

import { createHash } from 'node:crypto'
import { createReadStream, promises as fs } from 'node:fs'
import { dirname, join, relative } from 'node:path'

// ─── Constants ──────────────────────────────────────────────────────────────

/**
 * Maximum file size we attempt to hash inside a hook. Beyond this
 * threshold the event is logged with `hash: "skipped:large-file"`.
 *
 * Why 10 MB: PreToolUse is blocking for Antigravity (fail-safe deny
 * on timeout) with a 50 ms latency budget. At ~200 MB/s read on SSD
 * and ~500 MB/s SHA-256 throughput, 10 MB hashes in ~50 ms worst case.
 * Anything larger blows the budget.
 *
 * See docs/antigravity-audit.md §Design decision 2 for rationale.
 */
export const MAX_HASH_BYTES = 10 * 1024 * 1024

/**
 * Reason codes that the Antigravity hook writes to its diagnostic
 * log (`<log_dir>/antigravity-hook.log`). Frozen so consumers cannot
 * silently invent new ones — every reason added here must also be
 * documented in docs/antigravity-audit.md.
 *
 * Severity:
 *   - `info`  → expected operational signal (large file, unreadable)
 *   - `warn`  → contract violation by the caller (malformed input)
 *
 * The mapping from reason → severity lives in the hook itself, so
 * this object stays a flat string enum suitable for export to the
 * browser if needed.
 */
export const HOOK_WARN_REASONS = Object.freeze({
  malformed_stdin: 'malformed_stdin',
  schema_partial: 'schema_partial',
  tool_unsupported: 'tool_unsupported',
  path_outside_workspaces: 'path_outside_workspaces',
  hash_skipped_large: 'hash_skipped_large',
  hash_skipped_unreadable: 'hash_skipped_unreadable',
})

// ─── Pure helpers (exported for tests + shared by both hooks) ───────────────

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
