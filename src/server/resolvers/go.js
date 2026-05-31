/**
 * Go import resolver (rc9.17) — zero-dependency.
 *
 * Produces the SAME graph contract as the JS/TS and Python resolvers, so every
 * downstream consumer stays language-agnostic:
 *
 *   { forward: Map<file,Set<file>>, reverse: Map<file,Set<file>>,
 *     builtAt: number, stats: { modules, edges, unresolved, language: 'go' } }
 *
 * All paths are repo-relative with forward slashes.
 *
 * How Go resolution works (and why it's clean):
 *   - `go.mod` declares the module path, e.g. `module github.com/foo/bar`.
 *     That string is the import prefix for the repo's OWN packages.
 *   - A Go *package* is a directory; its import path is
 *     `<modulePath>/<dir-relative-to-repo-root>` (or just `<modulePath>` at
 *     the root). Imports name PACKAGES (directories), not files.
 *   - An import is INTERNAL when it starts with the module path; anything else
 *     (stdlib like `fmt`, third-party like `github.com/other/x`) is ignored —
 *     the Go analogue of node_modules.
 *
 * Because BlastRadius's graph is keyed on FILES (to line up with the heat-map,
 * tree, and diff), we expand each internal package import to EVERY `.go` file
 * in that package's directory. That is exactly the right model for blast
 * radius: touching any file in an imported package can affect its importers.
 *
 * Scope limits (honest): does not model implicit intra-package coupling (files
 * in the same package that call each other without an import), build tags, or
 * `replace` directives in go.mod. Good enough for impact awareness.
 *
 * Security / safety: read-only. Skips `vendor/`, VCS/tool dirs, and Go-ignored
 * `_`/`.`-prefixed dirs; caps file count and per-file size; runs under the
 * dispatcher's hard timeout.
 */

import { promises as fs } from 'node:fs'
import { join } from 'node:path'

const MAX_FILES = 8000
const MAX_FILE_BYTES = 2 * 1024 * 1024
const SKIP_DIRS = new Set(['.git', 'node_modules', 'vendor', 'testdata'])

function fwd(p) {
  return p.replace(/\\/g, '/')
}

/** Read the module path from go.mod (`module <path>`). Null if absent. */
async function readModulePath(absRepo) {
  try {
    const text = await fs.readFile(join(absRepo, 'go.mod'), 'utf8')
    const m = /^\s*module\s+(\S+)/m.exec(text)
    return m ? m[1].trim() : null
  } catch {
    return null
  }
}

/** Recursively collect repo-relative `.go` file paths (forward-slashed),
 *  skipping vendor/VCS dirs and Go-ignored `_`/`.`-prefixed dirs. */
async function collectGoFiles(absRepo) {
  const out = []
  const stack = ['']
  while (stack.length && out.length < MAX_FILES) {
    const rel = stack.pop()
    const abs = rel ? join(absRepo, rel) : absRepo
    let entries
    try {
      entries = await fs.readdir(abs, { withFileTypes: true })
    } catch {
      continue
    }
    for (const e of entries) {
      const childRel = rel ? `${rel}/${e.name}` : e.name
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name)) continue
        // Go tooling ignores directories starting with '.' or '_'.
        if (e.name.startsWith('.') || e.name.startsWith('_')) continue
        stack.push(childRel)
      } else if (e.isFile() && e.name.endsWith('.go')) {
        out.push(fwd(childRel))
        if (out.length >= MAX_FILES) break
      }
    }
  }
  return out
}

/** The directory portion of a repo-relative file path ('' for root). */
function dirOf(relPath) {
  const i = relPath.lastIndexOf('/')
  return i === -1 ? '' : relPath.slice(0, i)
}

/**
 * Extract imported package paths from Go source. Handles both the single form
 * `import "path"` / `import alias "path"` and the block form
 * `import ( ... )`. Returns an array of import-path strings (no aliases).
 */
export function extractImports(text) {
  const src = String(text)
  const paths = []

  // Block imports: import ( ... ) — capture the whole parenthesised body.
  const blockRe = /\bimport\s*\(([\s\S]*?)\)/g
  let m
  while ((m = blockRe.exec(src)) !== null) {
    for (const line of m[1].split('\n')) {
      const q = /"([^"]+)"/.exec(line)
      if (q) paths.push(q[1])
    }
  }

  // Single-line imports: import "path" or import alias "path" (not followed by
  // a paren — those are the block form handled above).
  const singleRe = /^\s*import\s+(?:[A-Za-z_.][\w.]*\s+)?"([^"]+)"/gm
  while ((m = singleRe.exec(src)) !== null) {
    paths.push(m[1])
  }

  return paths
}

/**
 * Build the import graph for a Go repo.
 * @param {string} repoPath
 * @returns {Promise<{forward:Map,reverse:Map,builtAt:number,stats:object}>}
 */
export async function buildGo(repoPath, _opts = {}) {
  const absRepo = repoPath
  const modulePath = await readModulePath(absRepo)
  const files = await collectGoFiles(absRepo)

  // Map each package import path → the list of .go files in that directory.
  // Import path = modulePath + '/' + dir (or modulePath itself at the root).
  const pkgFiles = new Map()
  for (const f of files) {
    if (!modulePath) break
    const dir = dirOf(f)
    const importPath = dir ? `${modulePath}/${dir}` : modulePath
    const list = pkgFiles.get(importPath)
    if (list) list.push(f)
    else pkgFiles.set(importPath, [f])
  }

  const forward = new Map()
  const reverse = new Map()
  let edges = 0
  let unresolved = 0

  for (const file of files) {
    let text
    try {
      const stat = await fs.stat(join(absRepo, file))
      if (stat.size > MAX_FILE_BYTES) { forward.set(file, new Set()); continue }
      text = await fs.readFile(join(absRepo, file), 'utf8')
    } catch {
      forward.set(file, new Set())
      continue
    }

    const deps = new Set()
    for (const imp of extractImports(text)) {
      // Internal import only when it starts with the module path.
      if (!modulePath || (imp !== modulePath && !imp.startsWith(modulePath + '/'))) {
        unresolved += 1
        continue
      }
      const targets = pkgFiles.get(imp)
      if (!targets) { unresolved += 1; continue }
      for (const t of targets) {
        if (t === file) continue // same-package self / file importing its own pkg
        deps.add(t)
      }
    }

    forward.set(file, deps)
    for (const target of deps) {
      const incoming = reverse.get(target)
      if (incoming) incoming.add(file)
      else reverse.set(target, new Set([file]))
      edges += 1
    }
  }

  return {
    forward,
    reverse,
    builtAt: Date.now(),
    stats: { modules: forward.size, edges, unresolved, language: 'go' },
  }
}

export const __test = { collectGoFiles, readModulePath, dirOf }
