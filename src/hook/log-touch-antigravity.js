#!/usr/bin/env node
/**
 * BlastRadius — Antigravity log-touch hook.
 *
 * Wire this script via the standard Antigravity hooks.json configuration:
 *
 *     {
 *       "hooks": {
 *         "PostToolUse": [{
 *           "matcher": "edit_file|patch_file|write_file|view_file|grep_search",
 *           "hooks": [{
 *             "type": "command",
 *             "command": "node ${PLUGIN_ROOT}/log-touch-antigravity.js",
 *             "timeout": 5
 *           }]
 *         }]
 *       }
 *     }
 *
 * The matcher list and template files land in commit 4 (templates/antigravity/).
 *
 * Why PostToolUse-only by convention:
 * -----------------------------------
 * The hook script is idempotent with respect to which event fires it
 * (Pre vs Post — payload schema is identical). Configuration in
 * `hooks.json` defaults to PostToolUse so we only log AFTER the agent
 * actually performed the operation. PreToolUse can be added when we
 * want "intended actions" telemetry, but for the heat map we want
 * confirmed effects only. See docs/antigravity-audit.md.
 *
 * Critical invariant (enforced in main())
 * ---------------------------------------
 * The string `{"decision":"allow"}\n` is written to stdout via a
 * SYNCHRONOUS write to fd=1 as the very first I/O of this process —
 * before reading stdin, before any parse, before any file I/O. This
 * keeps the agent unblocked even if the rest of the script throws or
 * hangs. The engine's fail-safe deny would otherwise block the tool
 * call, degrading UX for reasons unrelated to security.
 *
 * Performance budget
 * ------------------
 * Target: hook returns in < 50 ms. We achieve that by:
 *   - Writing `decision:allow` first, before any other I/O.
 *   - Hashing under 10 MB only (MAX_HASH_BYTES from log-touch.js); a
 *     stat-first gate aborts the open() for larger files in ~1 ms.
 *   - Deferring JSONL append to `setImmediate`, so the script can
 *     return without waiting on disk I/O.
 *
 * Observability without contamination
 * -----------------------------------
 * Antigravity injects stderr into the agent's prompt context. We must
 * NEVER write to stderr in normal operation. Diagnostic messages go to
 * a separate JSONL file `<log_dir>/antigravity-hook.log` (NOT mixed
 * with the event log, which is reserved for valid heat-map events).
 * Reason codes come from HOOK_WARN_REASONS in `log-touch.js`. The
 * payload itself is NEVER logged — only `rawLength` + a short, sanitized
 * `detail` — because paths may contain tokens and `Instructions` may
 * carry user data.
 *
 * Behavior matrix (also in docs/antigravity-audit.md):
 *
 *   stdin                                | action
 *   -------------------------------------|----------------------------
 *   valid JSON + complete schema + path  | event in JSONL, allow
 *     inside a workspacePaths entry      |
 *   JSON.parse fails                     | warn `malformed_stdin`, 0 events
 *   schema incomplete                    | warn `schema_partial`, 0 events
 *   tool name not in TOOL_MAP            | warn `tool_unsupported`, 0 events
 *   path outside every workspace         | warn `path_outside_workspaces`,
 *                                        |   1 event with pathNorm = abs path
 *                                        |   (fallback to workspacePaths[0])
 *   file > MAX_HASH_BYTES                | info `hash_skipped_large`,
 *                                        |   1 event with hash sentinel
 *   file unreadable (ENOENT, EACCES)     | info `hash_skipped_unreadable`,
 *                                        |   1 event with hash sentinel
 *   stdin empty (env-var-only invocation)| warn `malformed_stdin`, 0 events
 *                                        |   (we do NOT fall back to env vars
 *                                        |    — see decision 1 in audit doc)
 */

import { appendFileSync, statSync, writeSync } from 'node:fs'
import { join } from 'node:path'
import { argv } from 'node:process'
import { pathToFileURL } from 'node:url'
import {
  toForwardSlashes,
  hashFile,
  appendJsonl,
  logFilePath,
  MAX_HASH_BYTES,
  HOOK_WARN_REASONS,
} from './log-touch.js'

// ─── Antigravity tool → BlastRadius heat tool ───────────────────────────────
//
// Antigravity does not expose Read/Edit/Write distinctions natively, so
// we derive them from `toolCall.name`. `run_command` is deliberately
// absent — see docs/antigravity-audit.md §Design decision 3.

const TOOL_MAP = Object.freeze({
  edit_file: 'Edit',
  patch_file: 'Edit',
  write_file: 'Write',
  view_file: 'Read',
  grep_search: 'Read',
})

// ─── Constants ──────────────────────────────────────────────────────────────

const DECISION_ALLOW = '{"decision":"allow"}\n'
const STDOUT_FD = 1
const ENV_LOG_DIR = 'BLASTRADIUS_LOG_DIR'
const HOOK_DIAG_LOG = 'antigravity-hook.log'
const AGENT_NAME = 'antigravity'

/**
 * Reasons we treat as informational (no real failure on our end, just
 * a signal worth recording) versus warnings (caller contract violation
 * or our own fallback). Driven by name pattern so adding a new
 * `hash_skipped_*` constant doesn't require updating this map.
 */
function severityFor(reason) {
  return reason.startsWith('hash_skipped') ? 'info' : 'warn'
}

// ─── Critical-path helpers ──────────────────────────────────────────────────

/**
 * Emit the engine's required `decision: allow` response via a
 * SYNCHRONOUS write to fd=1. We do not use `process.stdout.write` here
 * because on Windows pipes it can buffer — and if the process exits or
 * crashes before the buffer flushes, the engine sees no response and
 * applies fail-safe deny. `writeSync` blocks until the bytes reach the
 * kernel pipe buffer, which is exactly the guarantee we need.
 */
function emitAllow() {
  try {
    writeSync(STDOUT_FD, DECISION_ALLOW)
  } catch {
    // Even this can fail in surreal cases (closed stdout). Swallow —
    // there is nothing useful to do, and ANY recovery attempt risks
    // writing to stderr, which would contaminate the agent context.
  }
}

/** Resolve the log directory. Same convention as the Claude hook. */
function resolveLogDir() {
  return process.env[ENV_LOG_DIR] || './logs'
}

/**
 * Append one diagnostic line to `<log_dir>/antigravity-hook.log`.
 * Synchronous append-only JSONL. Swallows any error: this function
 * runs in the cold path of error handling — its own failures must
 * never compound into an agent-visible crash.
 *
 * The `detail` string is hard-capped at 200 chars to avoid leaking
 * payload contents (paths can carry tokens; instructions can carry
 * user data). Callers should pass short reason-specific strings only.
 */
function writeHookWarning(logDir, reason, detail = '', rawLength = 0) {
  try {
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      level: severityFor(reason),
      reason,
      rawLength,
      detail: detail ? String(detail).slice(0, 200) : '',
    })
    appendFileSync(join(logDir, HOOK_DIAG_LOG), line + '\n')
  } catch {
    // diagnostic-log failure is non-fatal by design
  }
}

/**
 * Read stdin to a string. Resolves on `end` even when the producer
 * sends an empty payload (in which case the returned buffer is `''`
 * and the caller will classify it as malformed_stdin).
 */
function readStdin() {
  return new Promise((resolve, reject) => {
    let buf = ''
    process.stdin.setEncoding('utf8')
    process.stdin.on('data', (chunk) => { buf += chunk })
    process.stdin.on('end', () => resolve(buf))
    process.stdin.on('error', reject)
  })
}

/**
 * Verify the parsed payload has the minimum shape we need to log a
 * useful event. Returns a normalised summary on success, or `null` on
 * any failure — leaving the caller to log `schema_partial` and bail.
 *
 * Schema (from official Antigravity hook contract):
 *   {
 *     conversationId: string,
 *     workspacePaths: string[],
 *     toolCall: { name: string, args: { Path: string, ... } }
 *   }
 *
 * Other fields (transcriptPath, artifactDirectoryPath, stepIdx) are
 * accepted but not required.
 */
function validatePayload(p) {
  if (!p || typeof p !== 'object') return null
  const tc = p.toolCall
  if (!tc || typeof tc !== 'object') return null
  if (typeof tc.name !== 'string' || tc.name.length === 0) return null
  const args = tc.args
  if (!args || typeof args !== 'object') return null
  // Path can appear under args.Path (per contract). Tools that don't
  // touch a single file (notably `grep_search` with multi-file results)
  // fail validation here on purpose — supporting those is a follow-up
  // covered by commit 6's fixture-based tests.
  if (typeof args.Path !== 'string' || args.Path.length === 0) return null
  if (!Array.isArray(p.workspacePaths) || p.workspacePaths.length === 0) return null
  return {
    toolName: tc.name,
    absPath: args.Path,
    workspacePaths: p.workspacePaths,
    conversationId: typeof p.conversationId === 'string' ? p.conversationId : '',
  }
}

/**
 * Find the workspace that contains the touched file. If none does,
 * fall back to `workspacePaths[0]` and signal the fallback to the
 * caller (which logs `path_outside_workspaces`).
 */
function resolveWorkspaceForPath(absPath, workspacePaths) {
  const fwd = toForwardSlashes(absPath)
  for (const ws of workspacePaths) {
    const wsFwd = toForwardSlashes(ws).replace(/\/+$/, '')
    if (fwd === wsFwd || fwd.startsWith(wsFwd + '/')) {
      return { workspacePath: wsFwd, contained: true }
    }
  }
  return {
    workspacePath: toForwardSlashes(workspacePaths[0]).replace(/\/+$/, ''),
    contained: false,
  }
}

/** Repo-relative slash-normalised path. Falls back to the absolute
 *  path if it lives outside the chosen workspace — same convention as
 *  the Claude hook's normalizePath. */
function normalizePathForEvent(absPath, workspacePath) {
  const fwd = toForwardSlashes(absPath)
  const prefix = workspacePath + '/'
  return fwd.startsWith(prefix) ? fwd.slice(prefix.length) : fwd
}

/**
 * Compute the file hash subject to the size policy. Returns a string
 * that is ALWAYS suitable for the event's `hash` field — never
 * `null`, never empty. Skip sentinels are documented in
 * docs/antigravity-audit.md §Design decision 2.
 */
async function safeHash(absPath, logDir) {
  let size
  try {
    size = statSync(absPath).size
  } catch {
    writeHookWarning(logDir, HOOK_WARN_REASONS.hash_skipped_unreadable, absPath)
    return 'skipped:unreadable'
  }
  if (size > MAX_HASH_BYTES) {
    writeHookWarning(logDir, HOOK_WARN_REASONS.hash_skipped_large, `size=${size}`)
    return 'skipped:large-file'
  }
  try {
    return await hashFile(absPath)
  } catch {
    writeHookWarning(logDir, HOOK_WARN_REASONS.hash_skipped_unreadable, absPath)
    return 'skipped:unreadable'
  }
}

// ─── Main ───────────────────────────────────────────────────────────────────

export async function main() {
  // ─────────────────────────────────────────────────────────────────────────
  // CRITICAL INVARIANT — this MUST be the very first I/O of the script.
  // Move it down even one line and a crash during stdin parse leaves the
  // agent blocked waiting for our decision.
  // ─────────────────────────────────────────────────────────────────────────
  emitAllow()

  const logDir = resolveLogDir()

  let raw = ''
  try {
    raw = await readStdin()
  } catch (err) {
    writeHookWarning(logDir, HOOK_WARN_REASONS.malformed_stdin, String(err))
    return
  }
  const rawLength = raw.length

  // Empty stdin → still classified as malformed. We do NOT fall back
  // to env vars (decision 1 in the audit doc); ANTIGRAVITY_TOOL_PATH
  // does not exist in the official contract and inventing events
  // would pollute the heat map.
  if (rawLength === 0) {
    writeHookWarning(logDir, HOOK_WARN_REASONS.malformed_stdin, 'empty stdin', 0)
    return
  }

  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    writeHookWarning(logDir, HOOK_WARN_REASONS.malformed_stdin, String(err?.message ?? err), rawLength)
    return
  }

  const valid = validatePayload(parsed)
  if (!valid) {
    writeHookWarning(logDir, HOOK_WARN_REASONS.schema_partial, '', rawLength)
    return
  }

  const tool = TOOL_MAP[valid.toolName]
  if (!tool) {
    writeHookWarning(logDir, HOOK_WARN_REASONS.tool_unsupported, valid.toolName, rawLength)
    return
  }

  const { workspacePath, contained } = resolveWorkspaceForPath(
    valid.absPath,
    valid.workspacePaths,
  )
  if (!contained) {
    writeHookWarning(logDir, HOOK_WARN_REASONS.path_outside_workspaces, valid.absPath)
  }

  const hash = await safeHash(valid.absPath, logDir)

  const event = {
    ts: new Date().toISOString(),
    tool,
    path: toForwardSlashes(valid.absPath),
    pathNorm: normalizePathForEvent(valid.absPath, workspacePath),
    cwd: workspacePath,
    hash,
    sessionId: valid.conversationId,
    agent: AGENT_NAME,
  }

  // setImmediate defers the JSONL append off the script's exit path.
  // The script returns from main() and the process can exit as soon as
  // its event loop drains; the disk write does not block the
  // microsecond at which the agent unblocks. If `appendJsonl` itself
  // fails, we log a diagnostic and swallow — the event is lost but the
  // agent is unaffected.
  setImmediate(() => {
    appendJsonl(logFilePath(logDir), event).catch((err) => {
      writeHookWarning(logDir, 'append_failed', String(err?.message ?? err))
    })
  })
}

// Suppress any unhandled rejection — node would otherwise print to
// stderr, which would contaminate the agent's prompt context. The
// `decision:allow` was emitted as the first line of main() so we are
// safe to swallow here.
//
// Auto-invoke only when this file is run as the script entry point
// (the Antigravity engine calls `node log-touch-antigravity.js`).
// Imports from test code (`import { main } from '...'`) follow the
// else branch and do not consume stdin or write to stdout.

/**
 * ESM equivalent of `require.main === module`. We compare our own
 * module URL against the file URL of argv[1] (the script Node was
 * told to run). Wrapped in try/catch because pathToFileURL throws
 * on missing or malformed argv (e.g. when launched via `node -e`).
 */
function isMainEntry() {
  try {
    if (!argv[1]) return false
    return import.meta.url === pathToFileURL(argv[1]).href
  } catch {
    return false
  }
}

if (isMainEntry()) {
  main().catch(() => {})
}

// Exported helpers below this line are for unit testing. Their
// behavior is observable through main() but exposing them
// individually keeps test setup hermetic (no spawn, no stdin pipe).
export {
  validatePayload,
  resolveWorkspaceForPath,
  normalizePathForEvent,
  safeHash,
  writeHookWarning,
  emitAllow,
  isMainEntry,
  TOOL_MAP,
  DECISION_ALLOW,
  AGENT_NAME,
}
