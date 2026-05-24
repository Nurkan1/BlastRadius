/**
 * Watcher — wraps two chokidar instances:
 *
 *   1. JSONL watcher on BLASTRADIUS_LOG_DIR. Fires whenever the hook
 *      appends a new line to the day's session-YYYY-MM-DD.jsonl. We
 *      coalesce bursts with `awaitWriteFinish` so partial writes don't
 *      trigger spurious empty tails.
 *
 *   2. Tree watcher on BLASTRADIUS_TARGET_REPO. Fires on add/unlink of
 *      files or directories. Ignores node_modules, .git, dist, build,
 *      .next, coverage, .turbo, .vercel. Only structural changes
 *      (paths appearing or disappearing) invalidate the cached tree —
 *      content edits do not.
 *
 * The watcher does not parse anything itself. It hands off to the
 * caller via two callbacks:
 *   - onJsonlChange()  — call eventStore.tail() then sse.broadcast()
 *   - onTreeChange()   — call treeScanner.invalidate() then sse.broadcast()
 */

import chokidar from 'chokidar'
import { dirname, sep } from 'node:path'
import { logFilePath } from '../hook/log-touch.js'

const TREE_IGNORE_REGEXES = [
  /(^|[\\/])node_modules([\\/]|$)/,
  /(^|[\\/])\.git([\\/]|$)/,
  /(^|[\\/])dist([\\/]|$)/,
  /(^|[\\/])build([\\/]|$)/,
  /(^|[\\/])\.next([\\/]|$)/,
  /(^|[\\/])\.cache([\\/]|$)/,
  /(^|[\\/])\.turbo([\\/]|$)/,
  /(^|[\\/])\.vercel([\\/]|$)/,
  /(^|[\\/])coverage([\\/]|$)/,
  /(^|[\\/])\.vitest-cache([\\/]|$)/,
]

export class Watcher {
  /**
   * @param {{
   *   logDir: string,
   *   targetRepo: string,
   *   onJsonlChange: () => void | Promise<void>,
   *   onTreeChange: () => void | Promise<void>,
   *   logger?: { debug: Function, info: Function, warn: Function }
   * }} opts
   */
  constructor(opts) {
    this.logDir = opts.logDir
    this.targetRepo = opts.targetRepo
    this.onJsonlChange = opts.onJsonlChange ?? (() => {})
    this.onTreeChange = opts.onTreeChange ?? (() => {})
    this.logger = opts.logger ?? noopLogger()
    /** @type {import('chokidar').FSWatcher | null} */
    this.jsonlWatcher = null
    /** @type {import('chokidar').FSWatcher | null} */
    this.treeWatcher = null
    this.started = false
  }

  start() {
    if (this.started) return
    this.started = true
    this.#startJsonlWatcher()
    this.#startTreeWatcher()
  }

  async stop() {
    const promises = []
    if (this.jsonlWatcher) promises.push(this.jsonlWatcher.close())
    if (this.treeWatcher) promises.push(this.treeWatcher.close())
    this.jsonlWatcher = null
    this.treeWatcher = null
    this.started = false
    await Promise.allSettled(promises)
  }

  // ─── Internals ─────────────────────────────────────────────────────────

  #startJsonlWatcher() {
    // Watch the directory itself, not just the file — that way we
    // automatically pick up the new day's file at midnight without
    // having to restart the watcher.
    this.jsonlWatcher = chokidar.watch(this.logDir, {
      ignoreInitial: true,
      depth: 0,
      // The hook appends in <100ms with explicit fsync, so writes are
      // already coherent. The small stability window absorbs the case
      // of two appends a few ms apart being seen as one change burst.
      awaitWriteFinish: { stabilityThreshold: 100, pollInterval: 25 },
    })

    const onFsEvent = (evtType, filePath) => {
      const today = logFilePath(this.logDir, new Date())
      if (filePath !== today) return // ignore yesterday's file edits, lock files, etc.
      this.logger.debug({ evtType, filePath }, 'jsonl change detected')
      Promise.resolve(this.onJsonlChange()).catch((err) => {
        this.logger.warn({ err: String(err) }, 'onJsonlChange threw')
      })
    }

    this.jsonlWatcher.on('add', (p) => onFsEvent('add', p))
    this.jsonlWatcher.on('change', (p) => onFsEvent('change', p))
    this.jsonlWatcher.on('error', (err) => {
      this.logger.warn({ err: String(err) }, 'jsonl watcher error')
    })
  }

  #startTreeWatcher() {
    this.treeWatcher = chokidar.watch(this.targetRepo, {
      ignoreInitial: true,
      ignored: (p) => TREE_IGNORE_REGEXES.some((re) => re.test(p)),
      depth: 50,
      awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 100 },
      // The tree watcher cares about structure, not content. We don't
      // listen to "change" events.
    })

    const fire = (kind, p) => {
      this.logger.debug({ kind, p }, 'tree structure change')
      Promise.resolve(this.onTreeChange()).catch((err) => {
        this.logger.warn({ err: String(err) }, 'onTreeChange threw')
      })
    }

    this.treeWatcher.on('add', (p) => fire('add', p))
    this.treeWatcher.on('unlink', (p) => fire('unlink', p))
    this.treeWatcher.on('addDir', (p) => fire('addDir', p))
    this.treeWatcher.on('unlinkDir', (p) => fire('unlinkDir', p))
    this.treeWatcher.on('error', (err) => {
      this.logger.warn({ err: String(err) }, 'tree watcher error')
    })
  }
}

function noopLogger() {
  const f = () => {}
  return { debug: f, info: f, warn: f }
}

// Export the directory helper for tests / sanity checks.
export function jsonlDirFor(logFile) {
  return dirname(logFile)
}

// `sep` is intentionally re-exported so consumers can verify the
// platform separator if they want to. (Currently unused; kept for
// future debug tooling.)
export { sep as PATH_SEP }
