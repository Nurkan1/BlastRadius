/**
 * Agent inference — pure function, zero dependencies.
 *
 * Every event in the JSONL log gets attributed to ONE agent:
 *   - "claude"      — Claude Code hook output (PostToolUse)
 *   - "antigravity" — Antigravity hook output (PreToolUse + PostToolUse)
 *   - "manual"      — any other source (CLI replay, scripted seeding, ...)
 *
 * The function never throws and never returns null. Unknown / malformed
 * input still resolves to one of the three canonical strings — see the
 * cascade below.
 *
 * Why this lives in its own module
 * --------------------------------
 *   1. Pure, no IO, no state → trivially testable from both server- and
 *      browser-side test runners.
 *   2. The frontend needs the same logic to label rows in the side
 *      panel and to power the platform filter — keeping it server-only
 *      would force the same cascade to be reimplemented in app.js with
 *      inevitable drift.
 *   3. The decision tree is small enough to inline anywhere, but
 *      centralising it means future agents (e.g. Cursor, Aider) just
 *      add one branch in one place rather than being grepped for
 *      across the codebase.
 *
 * Back-compat default
 * -------------------
 * Pre-refactor JSONL events have no `agent` field. They were ALL
 * produced by Claude Code's hook (the only real source before this
 * audit — the so-called "Antigravity support" was a manual CLI marker
 * that the second branch of the cascade still recognizes). So events
 * without an `agent` field default to "claude" rather than "unknown" —
 * an unknown default would silently make the historical "Claude" UI
 * filter forget the entire pre-refactor archive.
 *
 * Cascade order
 * -------------
 *   1. Explicit `agent` field on the event, if it is a non-empty string.
 *      This is the canonical post-refactor signal.
 *   2. Legacy literal `sessionId === "antigravity-session"` — the marker
 *      `scripts/log-external.js` writes today. Kept until the log files
 *      that contain it age out of session windows (~weeks).
 *   3. Missing/empty `sessionId` → "manual" (scripted seeding, test
 *      fixtures, replay tools).
 *   4. Anything else → "claude".
 *
 * Defensive notes
 * ---------------
 *   - Non-object / null / undefined input returns the default ("claude")
 *     without throwing. Test fixtures and tail-read partial JSON
 *     occasionally feed us garbage; the hot path must not crash.
 *   - `agent` field with a non-string value (number, object, null) is
 *     ignored — the cascade falls through to sessionId-based detection.
 *     A malformed log line shouldn't be able to mis-attribute future
 *     events.
 */

/** Canonical agent strings. Exported so consumers can switch on them
 *  with compile-time-safe equality (no magic strings in callers). */
export const AGENT_CLAUDE = 'claude'
export const AGENT_ANTIGRAVITY = 'antigravity'
export const AGENT_MANUAL = 'manual'

/** Display labels used by the UI side panel and the platform filter.
 *  Kept here so the presentation layer never has to invent its own
 *  mapping (and so we never drift on capitalization / spaces). */
export const AGENT_DISPLAY = Object.freeze({
  [AGENT_CLAUDE]: 'Claude Code',
  [AGENT_ANTIGRAVITY]: 'Antigravity',
  [AGENT_MANUAL]: 'Manual / CLI',
})

/** Legacy sessionId literal `scripts/log-external.js` writes for
 *  Antigravity events. Kept as a const so test fixtures and the
 *  cascade share the same string. */
export const LEGACY_ANTIGRAVITY_SESSION_ID = 'antigravity-session'

/**
 * Infer the agent that produced an event.
 *
 * @param {object|null|undefined} ev  JSONL event row (or anything else;
 *                                    the function tolerates malformed input).
 * @returns {'claude'|'antigravity'|'manual'}
 */
export function inferAgent(ev) {
  if (!ev || typeof ev !== 'object') return AGENT_CLAUDE

  // 1. Explicit field on the event (new schema, post-refactor).
  if (typeof ev.agent === 'string' && ev.agent.length > 0) {
    // Normalise to lowercase — fixtures and future emitters may
    // capitalise. We're authoritative about the canonical form.
    const lower = ev.agent.toLowerCase()
    if (lower === AGENT_CLAUDE) return AGENT_CLAUDE
    if (lower === AGENT_ANTIGRAVITY) return AGENT_ANTIGRAVITY
    if (lower === AGENT_MANUAL) return AGENT_MANUAL
    // Unknown agent string explicitly set on the event: trust the
    // emitter and pass it through lowercased. Filter code in the UI
    // will simply not match it, which is the right fallback (better
    // than masquerading as "claude").
    return lower
  }

  // 2. Legacy sessionId-based detection.
  if (ev.sessionId === LEGACY_ANTIGRAVITY_SESSION_ID) return AGENT_ANTIGRAVITY

  // 3. Missing/empty sessionId → manual.
  if (!ev.sessionId || (typeof ev.sessionId === 'string' && ev.sessionId.length === 0)) {
    return AGENT_MANUAL
  }

  // 4. Default for every other case — including all pre-refactor
  //    JSONL events written by Claude Code's hook, which never
  //    carried `agent`.
  return AGENT_CLAUDE
}

/** Human-readable label for the inferred agent. Wraps `inferAgent` so
 *  callers don't need to import both. */
export function agentDisplayName(ev) {
  const a = inferAgent(ev)
  return AGENT_DISPLAY[a] ?? a
}
