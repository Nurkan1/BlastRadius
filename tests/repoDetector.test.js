import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, symlinkSync, chmodSync } from 'node:fs'
import { tmpdir, platform } from 'node:os'
import { join, sep } from 'node:path'

import {
  RepoDetector,
  computeActiveRepo,
  normalizePath,
} from '../src/server/repoDetector.js'

const NOW = new Date('2026-05-24T12:00:00.000Z')

function ev({ cwd, offsetMs = 0, tool = 'Edit' }) {
  return {
    ts: new Date(NOW.getTime() - offsetMs).toISOString(),
    tool,
    pathNorm: 'src/x.ts',
    path: `${cwd}/src/x.ts`,
    cwd,
    sessionId: 's',
    hash: 'sha256:0',
  }
}

// ─── computeActiveRepo (pure function) ───────────────────────────────────────

describe('computeActiveRepo', () => {
  const REPO_A = '/code/a'
  const REPO_B = '/code/b'

  it('returns currentRepo when autoSwitch is false even with activity elsewhere', () => {
    const events = [
      ev({ cwd: REPO_B, offsetMs: 50_000 }),
      ev({ cwd: REPO_B, offsetMs: 10_000 }),
    ]
    expect(computeActiveRepo(events, REPO_A, false, NOW)).toBe(REPO_A)
  })

  it('returns currentRepo with empty events', () => {
    expect(computeActiveRepo([], REPO_A, true, NOW)).toBe(REPO_A)
  })

  it('returns null/currentRepo with no candidate meeting the sustained criterion', () => {
    // Only ONE event in B → no span → not eligible
    const events = [ev({ cwd: REPO_B, offsetMs: 10_000 })]
    expect(computeActiveRepo(events, REPO_A, true, NOW)).toBe(REPO_A)
  })

  it('switches when candidate has ≥2 events spanning ≥30s in last 60s', () => {
    const events = [
      ev({ cwd: REPO_B, offsetMs: 45_000 }), // 45s ago
      ev({ cwd: REPO_B, offsetMs: 5_000 }),  //  5s ago → span 40s
    ]
    expect(computeActiveRepo(events, REPO_A, true, NOW)).toBe(REPO_B)
  })

  it('does NOT switch when span is < 30s (burst, not sustained)', () => {
    const events = [
      ev({ cwd: REPO_B, offsetMs: 10_000 }),
      ev({ cwd: REPO_B, offsetMs: 5_000 }),   // span 5s
    ]
    expect(computeActiveRepo(events, REPO_A, true, NOW)).toBe(REPO_A)
  })

  it('events outside the 60s window do not count', () => {
    const events = [
      ev({ cwd: REPO_B, offsetMs: 90_000 }), // 90s ago — out of window
      ev({ cwd: REPO_B, offsetMs: 5_000 }),  // only 1 event in window → not eligible
    ]
    expect(computeActiveRepo(events, REPO_A, true, NOW)).toBe(REPO_A)
  })

  it('ignores events in the current repo', () => {
    const events = [
      ev({ cwd: REPO_A, offsetMs: 50_000 }),
      ev({ cwd: REPO_A, offsetMs: 5_000 }),
      // No events in B at all → no switch
    ]
    expect(computeActiveRepo(events, REPO_A, true, NOW)).toBe(REPO_A)
  })

  it('picks the candidate with most recent activity when multiple are eligible', () => {
    const REPO_C = '/code/c'
    const events = [
      ev({ cwd: REPO_B, offsetMs: 45_000 }),
      ev({ cwd: REPO_B, offsetMs: 15_000 }), // B span 30s, latest = 15s ago
      ev({ cwd: REPO_C, offsetMs: 40_000 }),
      ev({ cwd: REPO_C, offsetMs: 5_000 }),  // C span 35s, latest = 5s ago → wins
    ]
    expect(computeActiveRepo(events, REPO_A, true, NOW)).toBe(REPO_C)
  })

  it('handles malformed events without throwing', () => {
    const events = [
      null,
      {},
      { cwd: REPO_B },                    // no ts
      { cwd: REPO_B, ts: 'not-a-date' },  // bad ts
      ev({ cwd: REPO_B, offsetMs: 5_000 }),
    ]
    // Only 1 valid event in window for REPO_B → not sustained
    expect(computeActiveRepo(events, REPO_A, true, NOW)).toBe(REPO_A)
  })

  it('Windows-style cwd is normalized', () => {
    const events = [
      { ...ev({ cwd: 'C:\\code\\b', offsetMs: 50_000 }) },
      { ...ev({ cwd: 'C:/code/b',  offsetMs: 10_000 }) },
    ]
    expect(computeActiveRepo(events, 'C:/code/a', true, NOW)).toBe('C:/code/b')
  })

  it('returns null when there is no currentRepo, no autoSwitch, no candidate', () => {
    expect(computeActiveRepo([], null, false, NOW)).toBe(null)
  })

  it('returns null when autoSwitch is on but nothing is happening', () => {
    expect(computeActiveRepo([], null, true, NOW)).toBe(null)
  })
})

// ─── normalizePath ──────────────────────────────────────────────────────────

describe('normalizePath', () => {
  it('converts backslashes to forward slashes', () => {
    expect(normalizePath('C:\\code\\repo')).toBe('C:/code/repo')
  })
  it('strips trailing slashes', () => {
    expect(normalizePath('/x/y/')).toBe('/x/y')
    expect(normalizePath('/x/y///')).toBe('/x/y')
  })
  it('handles null/undefined safely', () => {
    expect(normalizePath(null)).toBe('')
    expect(normalizePath(undefined)).toBe('')
  })
})

// ─── RepoDetector — fixture-based integration ───────────────────────────────

describe('RepoDetector.getRepos (fixture)', () => {
  let parentDir

  beforeAll(() => {
    parentDir = mkdtempSync(join(tmpdir(), 'br-repos-'))

    // Layout:
    //   parentDir/
    //     repo-a/.git/        (regular repo)         → detected, has activity
    //     repo-b/.git         (submodule pointer file) → detected, has activity
    //     repo-c/.git/        (repo, NO activity)      → filtered out by 7-day rule
    //     just-folder/        (no .git)               → ignored
    //     nested/
    //       deep/
    //         repo-d/.git/   (depth 3)                → detected, has activity
    //     too-deep/
    //       a/b/c/
    //         repo-e/.git/   (depth 4)                → ignored (over max depth)
    //     node_modules/      (skipped — vendor)
    //       fake-pkg/.git/  (would never be a real repo)
    //     dist/repo-x/.git/  (skipped — vendor)
    mkdirSync(join(parentDir, 'repo-a', '.git'), { recursive: true })
    mkdirSync(join(parentDir, 'repo-c', '.git'), { recursive: true })
    mkdirSync(join(parentDir, 'just-folder'), { recursive: true })
    mkdirSync(join(parentDir, 'nested', 'deep', 'repo-d', '.git'), { recursive: true })
    mkdirSync(join(parentDir, 'too-deep', 'a', 'b', 'c', 'repo-e', '.git'), { recursive: true })
    mkdirSync(join(parentDir, 'node_modules', 'fake-pkg', '.git'), { recursive: true })
    mkdirSync(join(parentDir, 'dist', 'repo-x', '.git'), { recursive: true })

    // repo-b: .git as a FILE (submodule pointer)
    mkdirSync(join(parentDir, 'repo-b'), { recursive: true })
    writeFileSync(join(parentDir, 'repo-b', '.git'), 'gitdir: ../.git/modules/repo-b\n')
  })

  afterAll(() => {
    if (parentDir) rmSync(parentDir, { recursive: true, force: true })
  })

  function eventStoreWithEvents(eventsArr) {
    return { getEvents: () => eventsArr }
  }

  it('discovers regular .git dir + submodule .git file but skips vendor dirs and over-depth', async () => {
    const events = [
      // Build full absolute paths to match the fixture
      ev({ cwd: normalizePath(join(parentDir, 'repo-a')), offsetMs: 60_000 }),
      ev({ cwd: normalizePath(join(parentDir, 'repo-b')), offsetMs: 120_000 }),
      ev({ cwd: normalizePath(join(parentDir, 'nested', 'deep', 'repo-d')), offsetMs: 180_000 }),
      // repo-e (over depth) — even with activity, it shouldn't be found
      ev({ cwd: normalizePath(join(parentDir, 'too-deep', 'a', 'b', 'c', 'repo-e')), offsetMs: 30_000 }),
    ]
    const det = new RepoDetector({ parentDir, eventStore: eventStoreWithEvents(events) })
    const repos = await det.getRepos({ now: NOW })

    const names = repos.map((r) => r.name).sort()
    expect(names).toEqual(['repo-a', 'repo-b', 'repo-d'])
    // repo-c was found but filtered (no activity)
    // repo-e was NOT found (over depth)
    // node_modules/fake-pkg never reached
  })

  it('orders by lastActivity desc', async () => {
    const events = [
      ev({ cwd: normalizePath(join(parentDir, 'repo-a')), offsetMs: 60_000 }),     // most recent
      ev({ cwd: normalizePath(join(parentDir, 'repo-b')), offsetMs: 120_000 }),
      ev({ cwd: normalizePath(join(parentDir, 'nested', 'deep', 'repo-d')), offsetMs: 300_000 }),
    ]
    const det = new RepoDetector({ parentDir, eventStore: eventStoreWithEvents(events) })
    const repos = await det.getRepos({ now: NOW })
    expect(repos.map((r) => r.name)).toEqual(['repo-a', 'repo-b', 'repo-d'])
  })

  it('returns empty when no events match any repo', async () => {
    const det = new RepoDetector({ parentDir, eventStore: eventStoreWithEvents([]) })
    expect(await det.getRepos({ now: NOW })).toEqual([])
  })

  it('caches results within TTL', async () => {
    const events = [ev({ cwd: normalizePath(join(parentDir, 'repo-a')), offsetMs: 60_000 })]
    const det = new RepoDetector({
      parentDir,
      eventStore: eventStoreWithEvents(events),
      ttlMs: 60_000,
    })
    const first = await det.getRepos({ now: NOW })
    const second = await det.getRepos({ now: NOW })
    expect(second).toBe(first) // same cached reference
  })

  it('refetches after invalidate()', async () => {
    const events = [ev({ cwd: normalizePath(join(parentDir, 'repo-a')), offsetMs: 60_000 })]
    const det = new RepoDetector({ parentDir, eventStore: eventStoreWithEvents(events) })
    const first = await det.getRepos({ now: NOW })
    det.invalidate()
    const second = await det.getRepos({ now: NOW })
    expect(second).not.toBe(first) // fresh array
    expect(second.length).toBe(first.length)
  })

  it('dedupes concurrent callers (single-flight)', async () => {
    const events = [ev({ cwd: normalizePath(join(parentDir, 'repo-a')), offsetMs: 60_000 })]
    let scanCount = 0
    // Wrap the event store to count getEvents() calls — proxy for how
    // many scans actually ran the inner activity map.
    const wrappedStore = {
      getEvents: () => { scanCount += 1; return events },
    }
    const det = new RepoDetector({ parentDir, eventStore: wrappedStore })
    const [a, b, c] = await Promise.all([
      det.getRepos({ now: NOW }),
      det.getRepos({ now: NOW }),
      det.getRepos({ now: NOW }),
    ])
    expect(a).toBe(b)
    expect(b).toBe(c)
    expect(scanCount).toBe(1) // ONE scan even with 3 concurrent callers
  })

  it('filters out repos with no activity in the last 7 days', async () => {
    const events = [
      // repo-a: very recent
      ev({ cwd: normalizePath(join(parentDir, 'repo-a')), offsetMs: 60_000 }),
      // repo-b: 8 days ago → outside window
      ev({ cwd: normalizePath(join(parentDir, 'repo-b')), offsetMs: 8 * 24 * 60 * 60 * 1000 }),
    ]
    const det = new RepoDetector({ parentDir, eventStore: eventStoreWithEvents(events) })
    const repos = await det.getRepos({ now: NOW })
    expect(repos.map((r) => r.name)).toEqual(['repo-a'])
  })

  it('does not crash when parentDir does not exist', async () => {
    const det = new RepoDetector({ parentDir: '/this/does/not/exist', eventStore: { getEvents: () => [] } })
    await expect(det.getRepos({ now: NOW })).resolves.toEqual([])
  })

  it('JSONL events for ghost repos (paths not in scan) are silently ignored', async () => {
    const events = [
      ev({ cwd: normalizePath(join(parentDir, 'repo-a')), offsetMs: 60_000 }),
      ev({ cwd: '/no/such/repo', offsetMs: 30_000 }),
      ev({ cwd: '/another/ghost', offsetMs: 10_000 }),
    ]
    const det = new RepoDetector({ parentDir, eventStore: eventStoreWithEvents(events) })
    const repos = await det.getRepos({ now: NOW })
    expect(repos.map((r) => r.name)).toEqual(['repo-a'])
  })
})

// ─── EACCES robustness (POSIX-only — Windows has different perm model) ──────

describe('RepoDetector — permission denied tolerance', () => {
  let parentDir
  let restrictedDir
  const isPosix = platform() !== 'win32'

  beforeEach(() => {
    if (!isPosix) return
    parentDir = mkdtempSync(join(tmpdir(), 'br-perm-'))
    mkdirSync(join(parentDir, 'good-repo', '.git'), { recursive: true })
    restrictedDir = join(parentDir, 'restricted')
    mkdirSync(restrictedDir, { recursive: true })
    chmodSync(restrictedDir, 0o000)
  })

  afterEach(() => {
    if (!isPosix) return
    try { chmodSync(restrictedDir, 0o755) } catch { /* ignore */ }
    if (parentDir) rmSync(parentDir, { recursive: true, force: true })
  })

  it.runIf(isPosix)('continues the scan when one subdir is unreadable (EACCES)', async () => {
    const events = [ev({
      cwd: normalizePath(join(parentDir, 'good-repo')),
      offsetMs: 60_000,
    })]
    const det = new RepoDetector({ parentDir, eventStore: { getEvents: () => events } })
    const repos = await det.getRepos({ now: NOW })
    expect(repos.map((r) => r.name)).toEqual(['good-repo'])
  })
})

// ─── Symlink safety (POSIX-only — Windows requires elevated perms) ──────────

describe('RepoDetector — symlinks are not followed', () => {
  let parentDir
  let externalRepo
  const isPosix = platform() !== 'win32'

  beforeEach(() => {
    if (!isPosix) return
    parentDir = mkdtempSync(join(tmpdir(), 'br-link-'))
    externalRepo = mkdtempSync(join(tmpdir(), 'br-extrepo-'))
    mkdirSync(join(externalRepo, '.git'), { recursive: true })
    // Plant a symlink to an external repo
    try {
      symlinkSync(externalRepo, join(parentDir, 'linked'))
    } catch { /* on some envs symlinks are restricted */ }
    // Also plant a regular repo so the scan has SOMETHING to find
    mkdirSync(join(parentDir, 'real-repo', '.git'), { recursive: true })
  })

  afterEach(() => {
    if (!isPosix) return
    if (parentDir) rmSync(parentDir, { recursive: true, force: true })
    if (externalRepo) rmSync(externalRepo, { recursive: true, force: true })
  })

  it.runIf(isPosix)('does not follow symlinks pointing to outside-parentDir repos', async () => {
    const events = [ev({
      cwd: normalizePath(join(parentDir, 'real-repo')),
      offsetMs: 60_000,
    }), ev({
      cwd: normalizePath(externalRepo),
      offsetMs: 30_000,
    })]
    const det = new RepoDetector({ parentDir, eventStore: { getEvents: () => events } })
    const repos = await det.getRepos({ now: NOW })
    // real-repo IS found; linked → externalRepo is NOT (symlink skipped)
    expect(repos.map((r) => r.name)).toEqual(['real-repo'])
  })
})
