/**
 * Tree scanner — walks the target repo respecting .gitignore (plus a
 * hard-coded set of directories we never care about: node_modules, .git,
 * dist, build, .next, .cache).
 *
 * The result is a nested {name, type, path, children?} structure where:
 *   - `path` is forward-slashed, relative to the repo root, empty at root
 *   - dirs always carry `children` (possibly empty)
 *   - files never carry `children`
 *
 * Caching: scans are expensive on big repos. We memoize the tree for
 * `cacheTtlMs` and let the caller invalidate explicitly (the watcher
 * does so on add/unlink/addDir/unlinkDir). The cache also tracks the
 * total file count so /api/heat can compute blastRadius without a
 * second traversal.
 *
 * This module is strictly read-only on the target repo.
 */

import { promises as fs } from 'node:fs'
import { basename, join } from 'node:path'
import ignore from 'ignore'

const DEFAULT_CACHE_TTL_MS = 30_000
const HARD_IGNORE = [
  'node_modules/',
  '.git/',
  'dist/',
  'build/',
  '.next/',
  '.cache/',
  '.turbo/',
  '.vercel/',
  'coverage/',
  '.vitest-cache/',
]

export class TreeScanner {
  /**
   * @param {string} rootDir Absolute path to the repo to scan.
   * @param {{ cacheTtlMs?: number }} [opts]
   */
  constructor(rootDir, opts = {}) {
    if (!rootDir || typeof rootDir !== 'string') {
      throw new Error('TreeScanner: rootDir is required')
    }
    this.rootDir = rootDir
    this.cacheTtlMs = opts.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS
    this.cachedTree = null
    this.cachedAt = 0
    this.cachedFileCount = 0
  }

  /** Drop the cache so the next getTree() call rescans. */
  invalidate() {
    this.cachedTree = null
    this.cachedAt = 0
    this.cachedFileCount = 0
  }

  /** Return the tree (cached if fresh). */
  async getTree({ force = false } = {}) {
    const now = Date.now()
    if (!force && this.cachedTree && now - this.cachedAt < this.cacheTtlMs) {
      return this.cachedTree
    }
    const ig = await this.#loadIgnore()
    const children = await this.#walk(this.rootDir, ig, '')
    const root = {
      name: basename(this.rootDir) || this.rootDir,
      type: 'dir',
      path: '',
      children,
    }
    this.cachedTree = root
    this.cachedAt = now
    this.cachedFileCount = this.#countFiles(root)
    return root
  }

  /** Total file count in the cached tree. Forces a scan if needed. */
  async countFiles() {
    if (!this.cachedTree) await this.getTree()
    return this.cachedFileCount
  }

  // ─── Internals ─────────────────────────────────────────────────────────

  async #loadIgnore() {
    const ig = ignore().add(HARD_IGNORE)
    try {
      const text = await fs.readFile(join(this.rootDir, '.gitignore'), 'utf8')
      ig.add(text)
    } catch (err) {
      if (err.code !== 'ENOENT') throw err
      // No .gitignore — fine, hard ignores still apply.
    }
    return ig
  }

  /**
   * Depth-first walk producing the children array for a directory.
   * `relPath` is the directory path relative to repo root (forward-slashed).
   */
  async #walk(absDir, ig, relPath) {
    let entries
    try {
      entries = await fs.readdir(absDir, { withFileTypes: true })
    } catch {
      return [] // unreadable directory → treat as empty
    }

    const children = []
    for (const entry of entries) {
      // Symlinks: skip to avoid cycles. fs.readdir(withFileTypes) returns
      // isSymbolicLink === true even when the target is a dir/file.
      if (entry.isSymbolicLink()) continue
      if (!entry.isDirectory() && !entry.isFile()) continue

      const name = entry.name
      const childRel = relPath ? `${relPath}/${name}` : name

      // ignore checks: dir patterns conventionally end with "/"
      const ignoreKey = entry.isDirectory() ? `${childRel}/` : childRel
      if (ig.ignores(ignoreKey)) continue

      if (entry.isDirectory()) {
        const sub = await this.#walk(join(absDir, name), ig, childRel)
        children.push({ name, type: 'dir', path: childRel, children: sub })
      } else {
        children.push({ name, type: 'file', path: childRel })
      }
    }

    // Stable ordering: dirs first, then files, alphabetical within each
    // group. Helps the frontend render predictably + makes diffs cleaner.
    children.sort((a, b) => {
      if (a.type !== b.type) return a.type === 'dir' ? -1 : 1
      return a.name.localeCompare(b.name)
    })

    return children
  }

  #countFiles(node) {
    if (node.type === 'file') return 1
    let n = 0
    for (const child of node.children || []) n += this.#countFiles(child)
    return n
  }
}
