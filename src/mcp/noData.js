/**
 * NO-DATA contract for BlastRadius MCP tools and resources.
 *
 * Every tool and resource must NEVER throw on "absence" — it must
 * return a structured object whose value fields are `null` and whose
 * `reason` is a short, machine-readable string explaining WHY.
 *
 * This contract is mandatory because MCP clients (Claude Code,
 * Antigravity 2.0) cannot distinguish "the call errored" from "the
 * answer is legitimately empty" if we throw. Throwing buries the
 * difference in a generic `tools/call` failure that an LLM cannot
 * reason about. A structured `{ ..., reason }` payload lets the
 * model phrase the user-facing answer ("no active iteration yet —
 * close one or wait for activity") instead of "the tool errored".
 *
 * Reason codes (stable, lower_snake_case):
 *   - 'no_active_repo'       — preferences.currentRepo is null
 *   - 'needs_setup'          — fresh install, wizard mode
 *   - 'no_active_iteration'  — iterationMarker hasn't been closed yet
 *   - 'no_events_in_window'  — events exist but none fall in the asked window
 *   - 'no_events_recorded'   — eventStore is empty (no hook events today)
 *   - 'unknown_window'       — caller asked for a window we don't support
 *   - 'unknown_repo'         — the requested repo path isn't tracked
 *
 * Helpers below build the canonical shapes. Keep call sites short
 * (`return noData.iteration('no_active_iteration')`) so the contract
 * is visible in every return statement.
 */

/** Iteration-shaped no-data response. */
export function iteration(reason, extras = {}) {
  return {
    iteration: null,
    iterationStartedAt: null,
    metrics: null,
    activities: null,
    reason,
    ...extras,
  }
}

/** Heat-map-shaped no-data response. */
export function heat(reason, extras = {}) {
  return {
    files: null,
    metrics: null,
    propagation: null,
    attributions: null,
    reason,
    ...extras,
  }
}

/** Repo-shaped no-data response. */
export function repo(reason, extras = {}) {
  return {
    repo: null,
    reason,
    ...extras,
  }
}

/** Generic value/reason envelope. Use sparingly — prefer the typed
 *  helpers above so the shape is predictable per tool. */
export function value(reason, extras = {}) {
  return { value: null, reason, ...extras }
}

/** Wrap a payload as MCP `content` (text block with JSON serialization).
 *  Tools must return `{ content: [...] }`. We always emit a single
 *  text block of stringified JSON so the model can inspect the full
 *  structure, including the `reason` field when applicable. */
export function asMcpContent(payload) {
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(payload, null, 2),
      },
    ],
    // Structured content lets new MCP clients consume the JSON
    // directly without re-parsing the text block. Older clients
    // ignore it and fall back to `content`.
    structuredContent: payload,
  }
}
