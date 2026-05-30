/**
 * EventStore — historical multi-day API (rc7+).
 *
 * Covers the additive surface introduced for date-range filters:
 *   - loadDays({from, to})              — disk read + cache, range cap
 *   - getEventsInRange({from, to})      — cache-only sync read
 *   - getEventsForRepoInRange(repo, …)  — per-repo + date-range
 *   - listDaysWithActivity()            — enumerate session-*.jsonl on disk
 *   - MAX_RANGE_DAYS constant
 *
 * Critical invariants validated here (the reasons rc7 is "additive,
 * not destructive"):
 *
 *   1. Loading historical events MUST NOT pollute the live `events`
 *      array used by tail(). The two stores stay disjoint.
 *   2. Missing JSONL files inside the requested range are skipped
 *      silently — they yield empty events for that day, not throws.
 *   3. The current day (if present in the range) is served from the
 *      live `events` array, not re-read from disk. This avoids
 *      racing the watcher's tail().
 *   4. Range > MAX_RANGE_DAYS is rejected with RangeError — the
 *      "load me last 5 years" footgun is closed at the type boundary.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { EventStore, MAX_RANGE_DAYS } from '../src/server/eventStore.js'

// ─── Helpers ──────────────────────────────────────────────────────────────

/** Build a YYYY-MM-DD key for `daysAgo` days before today, local time. */
function dateKeyDaysAgo(daysAgo) {
  const d = new Date()
  d.setDate(d.getDate() - daysAgo)
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

/** Write one JSONL file with N synthetic events at a specific UTC time. */
async function writeDayFile(logDir, ymd, events) {
  const file = join(logDir, `session-${ymd}.jsonl`)
  const lines = events.map((e) => JSON.stringify(e)).join('\n') + '\n'
  await fs.writeFile(file, lines, 'utf8')
}

function ev({ ts, path = '/repo/a.js', pathNorm = 'a.js', cwd = '/repo', tool = 'Edit', agent = 'claude' } = {}) {
  return { ts, path, pathNorm, cwd, tool, agent }
}

let tempDir
let store

beforeEach(async () => {
  tempDir = await fs.mkdtemp(join(tmpdir(), 'blastradius-events-historical-'))
  store = new EventStore(tempDir)
})

afterEach(async () => {
  await fs.rm(tempDir, { recursive: true, force: true })
})

// ─── Tests ────────────────────────────────────────────────────────────────

describe('EventStore — loadDays() happy path', () => {
  it('loads multiple past days and returns sorted events', async () => {
    const d1 = dateKeyDaysAgo(3)
    const d2 = dateKeyDaysAgo(2)
    const d3 = dateKeyDaysAgo(1)
    await writeDayFile(tempDir, d1, [ev({ ts: `${d1}T10:00:00Z`, path: '/repo/a' })])
    await writeDayFile(tempDir, d2, [ev({ ts: `${d2}T11:00:00Z`, path: '/repo/b' })])
    await writeDayFile(tempDir, d3, [ev({ ts: `${d3}T12:00:00Z`, path: '/repo/c' })])

    const out = await store.loadDays({ from: d1, to: d3 })

    expect(out).toHaveLength(3)
    // Sorted ts asc.
    expect(out[0].path).toBe('/repo/a')
    expect(out[1].path).toBe('/repo/b')
    expect(out[2].path).toBe('/repo/c')
  })

  it('serves cached days on a second call without re-reading disk', async () => {
    const d = dateKeyDaysAgo(5)
    await writeDayFile(tempDir, d, [ev({ ts: `${d}T08:00:00Z` })])
    const first = await store.loadDays({ from: d, to: d })

    // Delete the file from disk. If the second call hits the cache,
    // it still returns the event. If it re-reads, it returns [].
    await fs.unlink(join(tempDir, `session-${d}.jsonl`))
    const second = await store.loadDays({ from: d, to: d })

    expect(first).toHaveLength(1)
    expect(second).toHaveLength(1)
    expect(second[0].ts).toBe(`${d}T08:00:00Z`)
  })

  it('accepts both string and Date for `from` and `to`', async () => {
    const d = dateKeyDaysAgo(4)
    await writeDayFile(tempDir, d, [ev({ ts: `${d}T09:00:00Z` })])
    // rc9.13: day keys are UTC, so the Date must be an unambiguous UTC instant
    // (noon-Z), not local midnight — otherwise a +TZ machine maps it to the
    // previous UTC day and the file isn't found.
    const dateObj = new Date(d + 'T12:00:00Z')

    const a = await store.loadDays({ from: d, to: d })
    const b = await store.loadDays({ from: dateObj, to: dateObj })
    expect(a).toHaveLength(1)
    expect(b).toHaveLength(1)
  })
})

describe('EventStore — loadDays() missing files', () => {
  it('returns empty events for days with no JSONL file (no throw)', async () => {
    // 3-day range, only middle day exists.
    const d1 = dateKeyDaysAgo(5)
    const d2 = dateKeyDaysAgo(4)
    const d3 = dateKeyDaysAgo(3)
    await writeDayFile(tempDir, d2, [ev({ ts: `${d2}T10:00:00Z` })])

    const out = await store.loadDays({ from: d1, to: d3 })
    expect(out).toHaveLength(1)
  })

  it('returns empty array when no files exist in the entire range', async () => {
    const d1 = dateKeyDaysAgo(7)
    const d2 = dateKeyDaysAgo(5)
    const out = await store.loadDays({ from: d1, to: d2 })
    expect(out).toEqual([])
  })
})

describe('EventStore — loadDays() validation and caps', () => {
  it('throws RangeError when from > to', async () => {
    await expect(
      store.loadDays({ from: dateKeyDaysAgo(1), to: dateKeyDaysAgo(5) })
    ).rejects.toThrow(/on or after/)
  })

  it('throws RangeError on garbage input', async () => {
    await expect(store.loadDays({ from: 'not-a-date', to: dateKeyDaysAgo(0) }))
      .rejects.toThrow(/invalid from\/to/)
    await expect(store.loadDays({})).rejects.toThrow(/invalid from\/to/)
  })

  it('rejects ranges that exceed MAX_RANGE_DAYS', async () => {
    // Range of exactly MAX_RANGE_DAYS + 1.
    const from = dateKeyDaysAgo(MAX_RANGE_DAYS)
    const to = dateKeyDaysAgo(0)
    await expect(store.loadDays({ from, to }))
      .rejects.toThrow(/exceeds cap/)
  })

  it('accepts ranges of exactly MAX_RANGE_DAYS (boundary)', async () => {
    const from = dateKeyDaysAgo(MAX_RANGE_DAYS - 1)
    const to = dateKeyDaysAgo(0)
    const out = await store.loadDays({ from, to })
    expect(Array.isArray(out)).toBe(true)
  })
})

describe('EventStore — current-day overlap with historical query', () => {
  it('uses the live events array for today (not a re-read of disk)', async () => {
    const today = dateKeyDaysAgo(0)
    // Seed the live array directly (simulating what tail() would do).
    store.events.push(ev({ ts: `${today}T10:00:00Z`, path: '/live/from-tail' }))
    // Write a DIFFERENT event to disk under the same filename — if the
    // historical loader bypasses the cache and re-reads disk, the test
    // catches it.
    await writeDayFile(tempDir, today, [ev({ ts: `${today}T11:00:00Z`, path: '/disk/should-not-leak' })])

    const out = await store.loadDays({ from: today, to: today })
    expect(out).toHaveLength(1)
    expect(out[0].path).toBe('/live/from-tail')
  })

  it('combines historical past days with the live current day', async () => {
    const yesterday = dateKeyDaysAgo(1)
    const today = dateKeyDaysAgo(0)
    await writeDayFile(tempDir, yesterday, [ev({ ts: `${yesterday}T09:00:00Z`, path: '/y' })])
    store.events.push(ev({ ts: `${today}T10:00:00Z`, path: '/t' }))

    const out = await store.loadDays({ from: yesterday, to: today })
    expect(out).toHaveLength(2)
    expect(out[0].path).toBe('/y')
    expect(out[1].path).toBe('/t')
  })
})

describe('EventStore — loadDays MUST NOT pollute the live events array', () => {
  it('this.events stays untouched after a multi-day historical load', async () => {
    const d = dateKeyDaysAgo(3)
    await writeDayFile(tempDir, d, [
      ev({ ts: `${d}T08:00:00Z` }),
      ev({ ts: `${d}T09:00:00Z` }),
    ])

    expect(store.events).toHaveLength(0)
    await store.loadDays({ from: d, to: d })
    // Live array still empty — historical load went to historicalEvents.
    expect(store.events).toHaveLength(0)
    expect(store.historicalEvents.get(d)).toHaveLength(2)
  })
})

describe('EventStore — getEventsInRange() (sync, cache-only)', () => {
  it('returns [] for a range that has not been loaded yet', () => {
    const out = store.getEventsInRange({ from: dateKeyDaysAgo(3), to: dateKeyDaysAgo(1) })
    expect(out).toEqual([])
  })

  it('returns cached events without touching disk', async () => {
    const d = dateKeyDaysAgo(3)
    await writeDayFile(tempDir, d, [ev({ ts: `${d}T10:00:00Z`, path: '/x' })])
    await store.loadDays({ from: d, to: d })

    const sync = store.getEventsInRange({ from: d, to: d })
    expect(sync).toHaveLength(1)
    expect(sync[0].path).toBe('/x')
  })
})

describe('EventStore — getEventsForRepoInRange()', () => {
  it('filters events to the given repo path inside the date range', async () => {
    const d = dateKeyDaysAgo(2)
    await writeDayFile(tempDir, d, [
      ev({ ts: `${d}T10:00:00Z`, path: '/repo/a/src/x.js' }),
      ev({ ts: `${d}T10:05:00Z`, path: '/repo/b/src/y.js' }),
      ev({ ts: `${d}T10:10:00Z`, path: '/repo/a/lib/z.js' }),
    ])
    await store.loadDays({ from: d, to: d })

    const out = store.getEventsForRepoInRange('/repo/a', { from: d, to: d })
    expect(out).toHaveLength(2)
    // pathNorm rewritten to be repo-relative.
    expect(out.map((e) => e.pathNorm).sort()).toEqual(['lib/z.js', 'src/x.js'])
  })

  it('returns [] for an unknown repo path', async () => {
    const d = dateKeyDaysAgo(2)
    await writeDayFile(tempDir, d, [ev({ ts: `${d}T10:00:00Z`, path: '/repo/a/x.js' })])
    await store.loadDays({ from: d, to: d })

    expect(store.getEventsForRepoInRange('/repo/nowhere', { from: d, to: d })).toEqual([])
  })
})

describe('EventStore — listDaysWithActivity()', () => {
  it('lists every session-*.jsonl file, sorted desc, with byte sizes', async () => {
    const d1 = dateKeyDaysAgo(5)
    const d2 = dateKeyDaysAgo(2)
    const d3 = dateKeyDaysAgo(0)
    await writeDayFile(tempDir, d1, [ev({ ts: `${d1}T10:00:00Z` })])
    await writeDayFile(tempDir, d2, [ev({ ts: `${d2}T10:00:00Z` }), ev({ ts: `${d2}T11:00:00Z` })])
    await writeDayFile(tempDir, d3, [ev({ ts: `${d3}T10:00:00Z` })])

    const out = await store.listDaysWithActivity()
    expect(out.map((e) => e.date)).toEqual([d3, d2, d1])
    expect(out.every((e) => e.sizeBytes > 0)).toBe(true)
  })

  it('ignores non-matching files in logDir (other .jsonl, *.log, etc.)', async () => {
    await fs.writeFile(join(tempDir, 'something-else.jsonl'), '{}\n', 'utf8')
    await fs.writeFile(join(tempDir, 'server.log'), 'noise\n', 'utf8')
    const d = dateKeyDaysAgo(1)
    await writeDayFile(tempDir, d, [ev({ ts: `${d}T10:00:00Z` })])

    const out = await store.listDaysWithActivity()
    expect(out).toHaveLength(1)
    expect(out[0].date).toBe(d)
  })

  it('returns [] when logDir does not exist (graceful)', async () => {
    const ghostStore = new EventStore('/nonexistent/path/blastradius-xyzzy')
    const out = await ghostStore.listDaysWithActivity()
    expect(out).toEqual([])
  })

  it('caps the result at MAX_RANGE_DAYS most-recent entries', async () => {
    // Write MAX_RANGE_DAYS + 5 files spanning the past N days.
    for (let i = 0; i < MAX_RANGE_DAYS + 5; i++) {
      const d = dateKeyDaysAgo(i)
      await writeDayFile(tempDir, d, [ev({ ts: `${d}T10:00:00Z` })])
    }
    const out = await store.listDaysWithActivity()
    expect(out).toHaveLength(MAX_RANGE_DAYS)
    // Most recent first.
    expect(out[0].date).toBe(dateKeyDaysAgo(0))
  })
})
