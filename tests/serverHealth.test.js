/**
 * serverHealth — pure decision logic for the "server stopped" banner (rc8.5).
 *
 * The banner-trigger logic is extracted into a pure function so it's
 * unit-testable in isolation. The SSE wiring + DOM manipulation that
 * consumes it lives in src/public/app.js and is verified by smoke
 * (killing the server mid-session), per the rc8.5 plan — Node's
 * EventSource lifecycle can't be faithfully driven from jsdom.
 *
 * Contract:
 *   - If the most recent /api/health probe succeeded, NEVER show the
 *     banner (the server is alive — any prior SSE blip was transient).
 *   - Otherwise, show the banner only after >= THRESHOLD consecutive
 *     failures, so a single reconnect hiccup doesn't flash a scary
 *     red banner.
 */

import { describe, it, expect } from 'vitest'
import {
  shouldShowServerDeadBanner,
  SERVER_DEAD_FAILURE_THRESHOLD,
} from '../src/public/serverHealth.js'

describe('shouldShowServerDeadBanner', () => {
  it('exposes a sane threshold (>= 2, so a single blip never triggers)', () => {
    expect(SERVER_DEAD_FAILURE_THRESHOLD).toBeGreaterThanOrEqual(2)
  })

  it('never shows the banner when health is OK, regardless of past failures', () => {
    expect(shouldShowServerDeadBanner(0, true)).toBe(false)
    expect(shouldShowServerDeadBanner(5, true)).toBe(false)
    expect(shouldShowServerDeadBanner(999, true)).toBe(false)
  })

  it('does not show the banner below the failure threshold', () => {
    expect(shouldShowServerDeadBanner(0, false)).toBe(false)
    expect(shouldShowServerDeadBanner(SERVER_DEAD_FAILURE_THRESHOLD - 1, false)).toBe(false)
  })

  it('shows the banner at exactly the threshold (failing health)', () => {
    expect(shouldShowServerDeadBanner(SERVER_DEAD_FAILURE_THRESHOLD, false)).toBe(true)
  })

  it('shows the banner above the threshold (failing health)', () => {
    expect(shouldShowServerDeadBanner(SERVER_DEAD_FAILURE_THRESHOLD + 10, false)).toBe(true)
  })

  it('treats non-boolean healthOk defensively (undefined = not ok)', () => {
    // The caller may pass undefined if a probe never ran. Treat that
    // as "health not confirmed" → eligible to show once failures pile up.
    expect(shouldShowServerDeadBanner(SERVER_DEAD_FAILURE_THRESHOLD, undefined)).toBe(true)
    expect(shouldShowServerDeadBanner(0, undefined)).toBe(false)
  })
})
