import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { EventStore } from '../src/server/eventStore.js'

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Build an event row that mimics the hook's on-disk format. */
function ev({
  ts = '2026-05-24T12:00:00.000Z',
  tool = 'Edit',
  path,
  pathNorm,
  cwd,
  hash = 'sha256:abc',
  sessionId = 'sid',
}) {
  return { ts, tool, path, pathNorm, cwd, hash, sessionId }
}

/** Spin up an EventStore against a temp empty log dir and inject events
 *  directly into its internal array. We bypass file IO because the
 *  filter is pure on `this.events`. */
function storeWith(events) {
  const dir = mkdtempSync(join(tmpdir(), 'br-evstore-'))
  const store = new EventStore(dir)
  store.events = events
  return { store, dir }
}

const REPO_BR = 'C:/Users/me/Documents/BlastRadius'
const REPO_IB = 'C:/Users/me/Documents/IdeaBlast'

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('EventStore.getEventsForRepo — path-based filter', () => {
  // tmp dirs created per test get cleaned up by the OS; the filter is
  // pure on `store.events`, so no afterEach is needed.

  it('matches events by absolute path inside the repo, regardless of cwd', () => {
    const { store } = storeWith([
      // Edited a BlastRadius file from a Claude Code session opened in
      // IdeaBlast cwd. Pre-fix this was silently dropped.
      ev({
        path: `${REPO_BR}/src/public/app.js`,
        pathNorm: `${REPO_BR}/src/public/app.js`, // absolute because outside cwd
        cwd: REPO_IB,
      }),
    ])
    const out = store.getEventsForRepo(REPO_BR)
    expect(out).toHaveLength(1)
    // pathNorm should be rewritten to repo-relative so the heat engine
    // and tree set use the same key.
    expect(out[0].pathNorm).toBe('src/public/app.js')
    // The rest of the event payload is preserved.
    expect(out[0].path).toBe(`${REPO_BR}/src/public/app.js`)
    expect(out[0].tool).toBe('Edit')
  })

  it('still matches when cwd IS the repo (back-compat with current hook output)', () => {
    const { store } = storeWith([
      ev({
        path: `${REPO_BR}/src/server/index.js`,
        pathNorm: `${REPO_BR}/src/server/index.js`,
        cwd: REPO_BR,
      }),
    ])
    const out = store.getEventsForRepo(REPO_BR)
    expect(out).toHaveLength(1)
    expect(out[0].pathNorm).toBe('src/server/index.js')
  })

  it('excludes events whose absolute path is outside the repo', () => {
    const { store } = storeWith([
      ev({
        path: `${REPO_IB}/src/App.tsx`,
        pathNorm: `${REPO_IB}/src/App.tsx`,
        cwd: REPO_BR,
      }),
    ])
    const out = store.getEventsForRepo(REPO_BR)
    expect(out).toHaveLength(0)
  })

  it('legacy events with repo-relative pathNorm + matching cwd still work', () => {
    // Older hook versions wrote pathNorm relative to cwd when the file
    // was inside cwd. The new filter should keep accepting those so we
    // don't lose historical context after the upgrade.
    const { store } = storeWith([
      ev({
        path: `${REPO_BR}/src/server/index.js`,
        pathNorm: 'src/server/index.js', // already relative — legacy shape
        cwd: REPO_BR,
      }),
    ])
    const out = store.getEventsForRepo(REPO_BR)
    expect(out).toHaveLength(1)
    expect(out[0].pathNorm).toBe('src/server/index.js')
  })

  it('legacy event with relative pathNorm but non-matching cwd is dropped', () => {
    // Without an absolute path inside the repo AND without a matching
    // cwd, there is no way to attribute the event to this repo. The
    // safe default is to drop it.
    const { store } = storeWith([
      ev({
        path: 'src/server/index.js', // suspicious — relative `path`
        pathNorm: 'src/server/index.js',
        cwd: REPO_IB,
      }),
    ])
    const out = store.getEventsForRepo(REPO_BR)
    expect(out).toHaveLength(0)
  })

  it('handles Windows backslash paths in the event payload', () => {
    const { store } = storeWith([
      ev({
        path: 'C:\\Users\\me\\Documents\\BlastRadius\\src\\public\\app.js',
        pathNorm: 'C:\\Users\\me\\Documents\\BlastRadius\\src\\public\\app.js',
        cwd: 'C:\\Users\\me\\Documents\\IdeaBlast',
      }),
    ])
    const out = store.getEventsForRepo(REPO_BR)
    expect(out).toHaveLength(1)
    expect(out[0].pathNorm).toBe('src/public/app.js')
  })

  it('handles trailing slashes on the repoPath argument', () => {
    const { store } = storeWith([
      ev({
        path: `${REPO_BR}/src/x.ts`,
        pathNorm: `${REPO_BR}/src/x.ts`,
        cwd: REPO_IB,
      }),
    ])
    expect(store.getEventsForRepo(`${REPO_BR}/`)).toHaveLength(1)
    expect(store.getEventsForRepo(`${REPO_BR}///`)).toHaveLength(1)
  })

  it('returns [] for missing / non-string / empty repoPath', () => {
    const { store } = storeWith([
      ev({ path: `${REPO_BR}/x.ts`, pathNorm: `${REPO_BR}/x.ts`, cwd: REPO_BR }),
    ])
    expect(store.getEventsForRepo('')).toEqual([])
    expect(store.getEventsForRepo(null)).toEqual([])
    expect(store.getEventsForRepo(undefined)).toEqual([])
    expect(store.getEventsForRepo(123)).toEqual([])
  })

  it('skips malformed events without throwing', () => {
    const { store } = storeWith([
      null,
      undefined,
      'not an object',
      {}, // no path / pathNorm / cwd
      ev({ path: `${REPO_BR}/ok.ts`, pathNorm: `${REPO_BR}/ok.ts`, cwd: REPO_BR }),
    ])
    const out = store.getEventsForRepo(REPO_BR)
    expect(out).toHaveLength(1)
    expect(out[0].pathNorm).toBe('ok.ts')
  })

  it('does not match a sibling repo whose path is a prefix substring', () => {
    // Guard against "C:/foo/bar matches C:/foo/barbaz" via naive
    // startsWith. The targetPrefix MUST include a trailing '/'.
    const REPO_A = 'C:/repos/proj'
    const REPO_B = 'C:/repos/proj-old'
    const { store } = storeWith([
      ev({ path: `${REPO_B}/x.ts`, pathNorm: `${REPO_B}/x.ts`, cwd: REPO_A }),
    ])
    const out = store.getEventsForRepo(REPO_A)
    expect(out).toHaveLength(0)
  })

  it('exact match on the repo root itself yields pathNorm = ""', () => {
    // Edge case: event.path equals repoPath exactly (rare but legal).
    const { store } = storeWith([
      ev({ path: REPO_BR, pathNorm: REPO_BR, cwd: REPO_BR }),
    ])
    const out = store.getEventsForRepo(REPO_BR)
    expect(out).toHaveLength(1)
    expect(out[0].pathNorm).toBe('')
  })
})
