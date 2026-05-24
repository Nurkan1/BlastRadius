/**
 * Iteration marker — small in-memory singleton that tracks when the
 * current iteration started.
 *
 * Phase 2 defined `window: "iteration"` as "last 3 minutes". Phase 4
 * upgrades it: when the user clicks "Mark end of iteration" the marker
 * advances to NOW, and the iteration window becomes "events since that
 * moment". Before the first close, the marker stays null and the
 * heatEngine falls back to the 3-minute heuristic.
 *
 * In-memory is intentional: iterations are session-scoped and don't
 * need to survive a server restart. If we ever want persistence we
 * can swap the implementation behind the same interface.
 */
export class IterationMarker {
  constructor() {
    /** @type {Date | null} */
    this._startedAt = null
  }

  /** Current iteration start, or null if the heuristic 3-min window
   *  should be used. */
  get() {
    return this._startedAt
  }

  /** Convenience for routes / tests. */
  getIso() {
    return this._startedAt ? this._startedAt.toISOString() : null
  }

  /** Close the current iteration. The next iteration starts at `now`.
   *  Returns the freshly-set timestamp so callers can echo it back. */
  close(now = new Date()) {
    this._startedAt = now instanceof Date ? now : new Date()
    return this._startedAt
  }

  /** Wipe the marker — restores Phase 2 behaviour. */
  reset() {
    this._startedAt = null
  }
}
