/**
 * Python import resolver (rc9.16) — zero-dependency.
 *
 * Produces the SAME graph contract as the JS/TS (dependency-cruiser) resolver
 * so every downstream consumer stays language-agnostic:
 *
 *   { forward: Map<file,Set<file>>, reverse: Map<file,Set<file>>,
 *     builtAt: number, stats: { modules, edges, unresolved, language: 'python' } }
 *
 * All paths are repo-relative with forward slashes — the same convention the
 * heat engine, tree, and diff modal use.
 *
 * Approach: a pragmatic, line-based scanner (NOT a full Python parser). It
 * builds a module index of the repo's own `.py` files, then resolves each
 * `import` / `from … import` statement against that index. Only imports that
 * resolve to a file INSIDE the repo become edges; stdlib and pip packages are
 * counted as `unresolved` and dropped (the Python analogue of node_modules).
 * This is "good enough for blast-radius" — it intentionally does not chase
 * dynamic imports (importlib) or namespace packages without __init__.py.
 *
 * Security / safety: read-only. Skips virtualenvs, caches, and VCS dirs;
 * caps the file count and per-file size so a pathological tree can't blow up
 * memory or wall time (the dispatcher also wraps this in a hard timeout).
 */

import { promises as fs } from 'node:fs'
import { join } from 'node:path'

const MAX_FILES = 5000
const MAX_FILE_BYTES = 2 * 1024 * 1024
const SKIP_DIRS = new Set([
  '.git', 'node_modules', '__pycache__', '.venv', 'venv', 'env', '.env',
  'site-packages', 'build', 'dist', '.tox', '.mypy_cache', '.pytest_cache',
  '.eggs', '.idea', '.vscode', '.ruff_cache', '.hypothesis',
])

/** Forward-slash a path. */
function fwd(p) {
  return p.replace(/\\/g, '/')
}

/** Recursively collect repo-relative `.py` file paths, skipping junk dirs and
 *  honouring the file cap. Returns forward-slashed paths. */
async function collectPyFiles(absRepo) {
  const out = []
  const stack = ['']
  while (stack.length && out.length < MAX_FILES) {
    const rel = stack.pop()
    const abs = rel ? join(absRepo, rel) : absRepo
    let entries
    try {
      entries = await fs.readdir(abs, { withFileTypes: true })
    } catch {
      continue // unreadable dir — skip
    }
    for (const e of entries) {
      const childRel = rel ? `${rel}/${e.name}` : e.name
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name)) continue
        stack.push(childRel)
      } else if (e.isFile() && e.name.endsWith('.py')) {
        out.push(fwd(childRel))
        if (out.length >= MAX_FILES) break
      }
    }
  }
  return out
}

/** Map a repo-relative `.py` path to its dotted module name.
 *  `a/b/c.py` → `a.b.c`; `a/b/__init__.py` → `a.b` (the package). */
function moduleNameFor(relPath) {
  let p = relPath.replace(/\.py$/, '')
  if (p.endsWith('/__init__')) p = p.slice(0, -'/__init__'.length)
  return p.split('/').filter(Boolean).join('.')
}

/** The dotted package a file lives in (its directory as a module path).
 *  `a/b/c.py` → `a.b`; `a/b/__init__.py` → `a.b`. */
function packageOf(relPath) {
  const mod = moduleNameFor(relPath)
  // For __init__.py the module IS the package; for a regular module drop the
  // last segment to get the containing package.
  if (relPath.endsWith('/__init__.py') || relPath === '__init__.py') return mod
  const parts = mod.split('.')
  parts.pop()
  return parts.join('.')
}

/**
 * Extract import statements from Python source. Returns an array of
 * { dots, base, names } where:
 *   - `import a.b, c`            → { dots:0, base:null, names:['a.b','c'] }
 *   - `from a.b import c, d`     → { dots:0, base:'a.b', names:['c','d'] }
 *   - `from . import x`          → { dots:1, base:'',    names:['x'] }
 *   - `from ..pkg import y`      → { dots:2, base:'pkg', names:['y'] }
 * `import *` and wildcard names are represented as the name '*'.
 */
export function extractImports(text) {
  // Strip full-line comments cheaply (good enough for top-of-file imports).
  const src = String(text)
  const out = []

  // `from <dots><module> import <names | (names)>` — the import list may span
  // multiple lines inside parentheses, so allow newlines in the group.
  const fromRe = /^[ \t]*from[ \t]+(\.*)([\w.]*)[ \t]+import[ \t]+(\([^)]*\)|[^\n#]+)/gm
  let m
  while ((m = fromRe.exec(src)) !== null) {
    const dots = m[1].length
    const base = m[2] || ''
    const names = parseNameList(m[3])
    out.push({ dots, base, names })
  }

  // `import a.b.c, d as e`
  const importRe = /^[ \t]*import[ \t]+([^\n#]+)/gm
  while ((m = importRe.exec(src)) !== null) {
    const names = m[1]
      .split(',')
      .map((s) => s.trim().split(/\s+as\s+/)[0].trim())
      .filter((s) => /^[\w.]+$/.test(s))
    if (names.length) out.push({ dots: 0, base: null, names })
  }

  return out
}

/** Parse the names portion of a `from … import …` clause. */
function parseNameList(raw) {
  return String(raw)
    .replace(/^\(|\)$/g, '')
    .split(',')
    .map((s) => s.trim().split(/\s+as\s+/)[0].trim())
    .filter(Boolean)
    .map((s) => (s === '*' ? '*' : s))
    .filter((s) => s === '*' || /^[\w]+$/.test(s))
}

/**
 * Build the import graph for a Python repo.
 * @param {string} repoPath
 * @returns {Promise<{forward:Map,reverse:Map,builtAt:number,stats:object}>}
 */
export async function buildPython(repoPath, _opts = {}) {
  const absRepo = repoPath
  const files = await collectPyFiles(absRepo)

  // Module index: dotted name → repo-relative file. Both the regular module
  // name and (for packages) the package name resolve to their file.
  const moduleIndex = new Map()
  for (const f of files) moduleIndex.set(moduleNameFor(f), f)

  /** Resolve a dotted module to a repo file, or null if external/unknown. */
  const resolveModule = (dotted) => {
    if (!dotted) return null
    return moduleIndex.get(dotted) ?? null
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
    const addTarget = (dotted) => {
      const target = resolveModule(dotted)
      if (!target) { unresolved += 1; return }
      if (target === file) return // self-import
      deps.add(target)
    }

    for (const imp of extractImports(text)) {
      if (imp.base === null) {
        // `import a.b.c` — resolve the dotted module (and any importable parent
        // package along the way is implied by the module file itself).
        for (const name of imp.names) addTarget(name)
        continue
      }
      // `from … import …`
      let baseDotted
      if (imp.dots > 0) {
        // Relative: climb `dots-1` packages up from the current file's package.
        const pkgParts = packageOf(file).split('.').filter(Boolean)
        const up = imp.dots - 1
        const anchor = up > 0 ? pkgParts.slice(0, Math.max(0, pkgParts.length - up)) : pkgParts
        baseDotted = [...anchor, ...(imp.base ? imp.base.split('.') : [])].filter(Boolean).join('.')
      } else {
        baseDotted = imp.base
      }
      // Each imported name may itself be a submodule (base.name); otherwise the
      // dependency is on the base module the names are pulled from.
      let resolvedAny = false
      for (const name of imp.names) {
        if (name === '*') continue
        const sub = baseDotted ? `${baseDotted}.${name}` : name
        if (resolveModule(sub)) { addTarget(sub); resolvedAny = true }
      }
      if (resolveModule(baseDotted)) { addTarget(baseDotted); resolvedAny = true }
      if (!resolvedAny) unresolved += 1
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
    stats: { modules: forward.size, edges, unresolved, language: 'python' },
  }
}

export const __test = { collectPyFiles, moduleNameFor, packageOf, parseNameList }
