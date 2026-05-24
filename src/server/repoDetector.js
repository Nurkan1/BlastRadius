/**
 * Repo detector — scans a parent directory looking for git repositories
 * (depth ≤3) and ranks them by recent activity from the event store.
 *
 * Two distinct surfaces:
 *
 *   1. `RepoDetector` class (stateful)
 *      - getRepos({force}) — cached scan with single-flight dedup
 *      - invalidate()      — drop cache (called by the parentDir watcher
 *                            when a .git dir appears or disappears)
 *
 *   2. `computeActiveRepo(events, currentRepo, autoSwitch, now)`
 *      - Pure function. Decides whether to auto-switch to a different
 *        repo based on recent event activity.
 *
 * Detection rules
 * ───────────────
 *   - A directory is a "repo" iff it contains a `.git` entry. The entry
 *     may be either a directory (regular repo) or a file (submodule
 *     pointer that contains `gitdir: …`). Both count.
 *   - Walk depth is capped at 3 from parentDir (parent itself is
 *     depth 0; repos at depth 1; nested groups go up to depth 3).
 *   - Symlinks are NEVER followed during the walk — they bring cycle
 *     and escape risks for zero correctness gain.
 *   - EACCES (and any other readdir error) on a subdir is logged at
 *     debug level and the subdir is skipped. The rest of the scan
 *     continues.
 *   - Vendor / generated dirs are skipped: node_modules, dist, build,
 *     .next, .cache, .turbo, .vercel, coverage, .vitest-cache.
 *
 * Activity ranking
 * ────────────────
 *   - Only repos with at least one event in the last 7 days are
 *     reported (the rest are noise — usually old projects).
 *   - `eventCount` counts events whose `cwd` matches the repo path
 *     exactly (forward-slash normalized).
 *   - Sorted by `lastActivity` desc.
 */

import { promises as fs } from 'node:fs'
import { basename, resolve, sep } from 'node:path'

const DEFAULT_TTL_MS = 30_000
const DEFAULT_MAX_DEPTH = 3
const ACTIVITY_WINDOW_MS = 7 * 24 * 60 * 60 * 1000
const SKIP_DIRS = new Set([
  'node_modules', 'dist', 'build', '.next', '.cache',
  '.turbo', '.vercel', 'coverage', '.vitest-cache',
])

const noopLogger = () => ({ debug() {}, info() {}, warn() {} })

/** Normalize a path for cwd-matching against events. */
export function normalizePath(p) {
  if (p == null) return ''
  return String(p).replace(/\\/g, '/').replace(/\/+$/, '')
}

/**
 * Pure decision function. Returns the repoPath that SHOULD be active,
 * possibly the same as `currentRepo` (no change).
 *
 * Rule (mirrors the brief):
 *   - When autoSwitch is false, return currentRepo unchanged.
 *   - Look at events in last 60s ("window").
 *   - A repo (other than currentRepo) is an *eligible* candidate iff:
 *       a) it has ≥ 2 events in the window
 *       b) its event span (max ts − min ts) ≥ 30s — "sustained"
 *   - Among eligible candidates, pick the one with the most recent ts.
 *   - If none is eligible, keep currentRepo.
 *
 * @param {Array<{cwd?:string, ts?:string}>} events
 * @param {string|null} currentRepo
 * @param {boolean} autoSwitch
 * @param {Date} [now]
 * @returns {string|null}
 */
export function computeActiveRepo(events, currentRepo, autoSwitch, now = new Date()) {
  if (!autoSwitch) return currentRepo ?? null
  if (!Array.isArray(events) || events.length === 0) return currentRepo ?? null

  const WINDOW_MS = 60_000
  const SUSTAINED_MS = 30_000
  const nowMs = now instanceof Date && !Number.isNaN(now.getTime()) ? now.getTime() : Date.now()
  const cutoff = nowMs - WINDOW_MS
  const current = normalizePath(currentRepo ?? '')

  // perRepo: { count, minTs, maxTs }
  const perRepo = new Map()
  for (const ev of events) {
    const cwd = normalizePath(ev?.cwd)
    if (!cwd) continue
    if (cwd === current) continue           // we want OTHER repos as candidates
    const ts = ev?.ts ? Date.parse(ev.ts) : NaN
    if (!Number.isFinite(ts)) continue
    if (ts < cutoff) continue
    const slot = perRepo.get(cwd)
    if (slot) {
      slot.count += 1
      if (ts < slot.minTs) slot.minTs = ts
      if (ts > slot.maxTs) slot.maxTs = ts
    } else {
      perRepo.set(cwd, { count: 1, minTs: ts, maxTs: ts })
    }
  }

  let bestRepo = null
  let bestTs = -Infinity
  for (const [repo, { count, minTs, maxTs }] of perRepo) {
    if (count < 2) continue
    if (maxTs - minTs < SUSTAINED_MS) continue
    if (maxTs > bestTs) {
      bestTs = maxTs
      bestRepo = repo
    }
  }
  return bestRepo ?? currentRepo ?? null
}

/**
 * Lightweight summary returned by getRepos().
 * @typedef {Object} RepoSummary
 * @property {string}      path           Absolute, forward-slashed.
 * @property {string}      name           Basename, for display.
 * @property {boolean}     hasGit         Always true (filter); kept for forward-compat.
 * @property {string|null} lastActivity   ISO of latest matching event in last 7d, or null.
 * @property {number}      eventCount     Events with cwd matching this repo in last 7d.
 */

export class RepoDetector {
  /**
   * @param {{
   *   parentDir: string,
   *   eventStore?: { getEvents: () => Array },
   *   ttlMs?: number,
   *   maxDepth?: number,
   *   logger?: { debug:Function, info:Function, warn:Function },
   * }} opts
   */
  constructor(opts = {}) {
    if (!opts.parentDir || typeof opts.parentDir !== 'string') {
      throw new Error('RepoDetector: parentDir is required')
    }
    this.parentDir = resolve(opts.parentDir)
    this.eventStore = opts.eventStore ?? { getEvents: () => [] }
    this.ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS
    this.maxDepth = opts.maxDepth ?? DEFAULT_MAX_DEPTH
    this.logger = opts.logger ?? noopLogger()

    /** @type {{ repos: RepoSummary[], builtAt: number } | null} */
    this._cache = null
    /** @type {Promise<RepoSummary[]> | null} */
    this._inflight = null
  }

  /** Replace the parent dir; drops the cache. */
  setParentDir(parentDir) {
    this.parentDir = resolve(parentDir)
    this.invalidate()
  }

  invalidate() {
    this._cache = null
  }

  /**
   * Return the list of repos under `parentDir` with activity in the
   * last 7 days. Uses an in-memory cache (`ttlMs`) and dedupes
   * concurrent callers (single-flight) so 10 simultaneous /api/repos
   * requests trigger ONE underlying scan.
   */
  async getRepos({ force = false, now = new Date() } = {}) {
    if (!force && this._cache && (now.getTime() - this._cache.builtAt) < this.ttlMs) {
      return this._cache.repos
    }
    if (this._inflight) return this._inflight

    const promise = (async () => {
      const t0 = now.getTime()
      let repoPaths = []
      try {
        repoPaths = await this._walkForRepos(this.parentDir, 0)
      } catch (err) {
        // Parent dir vanished mid-scan (USB unplug, etc.). Keep last
        // cache around if we have one; otherwise return empty.
        this.logger.warn({ err: String(err?.message ?? err), parentDir: this.parentDir }, 'repo scan failed')
        return this._cache?.repos ?? []
      }

      // Build the activity map from the event store ONCE per scan.
      const activity = this._activityMap(now)
      const repos = repoPaths
        .map((p) => {
          const a = activity.get(p) ?? { lastActivity: null, eventCount: 0 }
          return {
            path: p,
            name: basename(p) || p,
            hasGit: true,
            lastActivity: a.lastActivity,
            eventCount: a.eventCount,
          }
        })
        // Show ALL detected git repos, not just active ones — the
        // first-time-use case has NO events yet, but the user still
        // needs to see and pick a repo. Sort: active first (most
        // recent activity at the top), then idle ones alphabetically
        // at the bottom.
        .sort((a, b) => {
          if (a.lastActivity && b.lastActivity) {
            return b.lastActivity.localeCompare(a.lastActivity)
          }
          if (a.lastActivity && !b.lastActivity) return -1
          if (!a.lastActivity && b.lastActivity) return 1
          return a.name.localeCompare(b.name)
        })

      this._cache = { repos, builtAt: now.getTime() }
      this.logger.debug({ found: repos.length, ms: Date.now() - t0 }, 'repo scan complete')
      return repos
    })()
      .finally(() => { this._inflight = null })
    this._inflight = promise
    return promise
  }

  /**
   * Walk parentDir up to maxDepth looking for entries named `.git`
   * (directory OR file — submodules use a file). Returns an array of
   * absolute, forward-slashed repo paths (the *parent* of each `.git`).
   *
   * Symlinks are not followed. Vendor dirs and inaccessible subdirs
   * are skipped silently. Walking stops descending into a directory
   * once that directory has been identified as a repo (no recursion
   * inside a discovered repo).
   */
  async _walkForRepos(absDir, depth) {
    if (depth > this.maxDepth) return []

    let entries
    try {
      entries = await fs.readdir(absDir, { withFileTypes: true })
    } catch (err) {
      // EACCES, ENOENT, etc. → skip this directory; the scan continues
      // with siblings.
      this.logger.debug({ err: String(err?.message ?? err), absDir }, 'readdir skipped')
      return []
    }

    // First pass: does this directory itself contain `.git`?
    for (const entry of entries) {
      if (entry.name === '.git' && (entry.isDirectory() || entry.isFile())) {
        // It's a repo. Don't descend further — that would over-count
        // nested files when the user has a flat repo layout.
        return [normalizePath(absDir)]
      }
    }

    // Otherwise, descend into non-vendor subdirs.
    const repos = []
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      if (entry.isSymbolicLink()) continue
      if (SKIP_DIRS.has(entry.name)) continue
      if (entry.name.startsWith('.')) continue   // skip dotfiles dirs except .git (handled above)
      const childAbs = `${absDir}${sep}${entry.name}`
      const sub = await this._walkForRepos(childAbs, depth + 1)
      if (sub.length > 0) repos.push(...sub)
    }
    return repos
  }

  /** Build a map<repoPath, { lastActivity, eventCount }> from events
   *  in the last 7 days. Events whose cwd doesn't match any repo are
   *  simply not in the map (and won't appear in getRepos's output). */
  _activityMap(now) {
    const cutoff = now.getTime() - ACTIVITY_WINDOW_MS
    const map = new Map()
    const events = this.eventStore.getEvents?.() ?? []
    for (const ev of events) {
      const cwd = normalizePath(ev?.cwd)
      if (!cwd) continue
      const ts = ev?.ts ? Date.parse(ev.ts) : NaN
      if (!Number.isFinite(ts) || ts < cutoff) continue
      const slot = map.get(cwd)
      if (slot) {
        slot.eventCount += 1
        if (ev.ts > slot.lastActivity) slot.lastActivity = ev.ts
      } else {
        map.set(cwd, { lastActivity: ev.ts, eventCount: 1 })
      }
    }
    return map
  }
}
