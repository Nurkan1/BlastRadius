/**
 * serverHealth — pure decision logic for the "server stopped" banner (rc8.5).
 *
 * Extracted out of app.js so the trigger condition is unit-testable
 * without a DOM or a live EventSource. app.js imports
 * `shouldShowServerDeadBanner` and feeds it a running count of
 * consecutive SSE / health-probe failures plus the result of the most
 * recent /api/health probe.
 *
 * Why a threshold instead of "show on first error": EventSource emits
 * an `error` on every transient blip (server restart, brief network
 * hiccup, the dashboard waking from sleep) and then reconnects on its
 * own. Flashing a red "server stopped" banner on every blip would be
 * noise. We only assert "stopped" after several consecutive failures
 * AND a confirming failed health probe.
 */

/** Consecutive failures required before the banner is allowed to show.
 *  3 ≈ ~6 s of retries at EventSource's default reconnect cadence —
 *  long enough to rule out a transient blip, short enough that a real
 *  crash surfaces quickly. */
export const SERVER_DEAD_FAILURE_THRESHOLD = 3

/**
 * @param {number} consecutiveFailures  count of consecutive SSE errors /
 *   failed health probes since the last successful connection
 * @param {boolean} healthOk  whether the most recent /api/health probe
 *   succeeded. `true` short-circuits to "alive" regardless of history;
 *   anything falsy (false / undefined) means "not confirmed alive".
 * @returns {boolean} whether to show the server-stopped banner
 */
export function shouldShowServerDeadBanner(consecutiveFailures, healthOk) {
  // A confirmed-healthy probe always wins: the server is up, any prior
  // SSE error was transient. This is also how the banner auto-dismisses
  // after a "Retry connection" succeeds.
  if (healthOk === true) return false
  return Number(consecutiveFailures) >= SERVER_DEAD_FAILURE_THRESHOLD
}
