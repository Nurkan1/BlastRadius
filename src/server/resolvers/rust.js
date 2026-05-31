/**
 * Rust import resolver (rc9.22) — ZERO-DEPENDENCY scanner.
 *
 * Per-language resolver behind graphResolver's dispatcher; returns the exact
 * same { forward, reverse, builtAt, stats } contract as JS/TS + Python + Go, so
 * it is invisible to every downstream consumer.
 *
 * Rust's module system is a TREE, not directory-flat — this is the subtlest of
 * the four resolvers. Approach:
 *   1. Index every `.rs` file to its module path using Rust's file conventions:
 *      - src/lib.rs, src/main.rs (and bin/*.rs)  → crate root  (module path "")
 *      - src/foo.rs       → module `foo`
 *      - src/foo/mod.rs   → module `foo`
 *      - src/a/b.rs       → module `a::b`
 *      Paths are taken relative to the nearest crate root dir (the dir holding
 *      lib.rs/main.rs; falls back to `src/` or the repo root).
 *   2. Edges come from two signals:
 *      - `mod NAME;`  — declares a child module → edge to NAME.rs or NAME/mod.rs
 *        in the current file's module dir (the strong structural signal). Inline
 *        `mod NAME { … }` is intentionally ignored (no separate file).
 *      - `use crate::… / self::… / super::…` — resolve the module path against
 *        the index (dropping trailing item segments) → edge to the defining
 *        file. `use crate::Foo` (a root item) → the crate root file.
 *   3. Internal-only: std/core, external crates (bare `use serde::…`), and
 *      unresolved paths are ignored — the Rust analogue of node_modules.
 *
 * Honest scope limits (NOT bugs): does not evaluate `#[path = "…"]`,
 * `#[cfg(...)]`-gated modules, macro-generated modules, glob re-exports, or
 * Cargo workspace cross-crate edges. Good enough for blast-radius impact.
 *
 * Security/safety: read-only; skips target/ + VCS/tool dirs; file + size caps;
 * runs under the dispatcher's withTimeout.
 */

import { promises as fs } from 'node:fs'
import { join } from 'node:path'

const MAX_FILES = 8000
const MAX_FILE_BYTES = 2 * 1024 * 1024
const SKIP_DIRS = new Set(['.git', 'node_modules', 'target', 'vendor', '.idea', '.vscode'])

const fwd = (p) => p.replace(/\\/g, '/')
const dirOf = (rel) => { const i = rel.lastIndexOf('/'); return i === -1 ? '' : rel.slice(0, i) }
const baseOf = (rel) => { const i = rel.lastIndexOf('/'); return i === -1 ? rel : rel.slice(i + 1) }

async function collectRsFiles(absRepo) {
  const out = []
  const stack = ['']
  while (stack.length && out.length < MAX_FILES) {
    const rel = stack.pop()
    const abs = rel ? join(absRepo, rel) : absRepo
    let entries
    try { entries = await fs.readdir(abs, { withFileTypes: true }) } catch { continue }
    for (const e of entries) {
      const childRel = rel ? `${rel}/${e.name}` : e.name
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name) || e.name.startsWith('.')) continue
        stack.push(childRel)
      } else if (e.isFile() && e.name.endsWith('.rs')) {
        out.push(fwd(childRel))
        if (out.length >= MAX_FILES) break
      }
    }
  }
  return out
}

/** Strip ` as Alias`, collapse whitespace. */
function normalizeUseClause(clause) {
  return String(clause).replace(/\s+as\s+[A-Za-z_]\w*/g, '').replace(/\s+/g, '')
}

/** Split a brace group's inner list on top-level commas (one level deep). */
function splitTopLevel(inner) {
  const parts = []
  let depth = 0, start = 0
  for (let i = 0; i < inner.length; i += 1) {
    const c = inner[i]
    if (c === '{') depth += 1
    else if (c === '}') depth -= 1
    else if (c === ',' && depth === 0) { parts.push(inner.slice(start, i)); start = i + 1 }
  }
  parts.push(inner.slice(start))
  return parts.filter(Boolean)
}

/** Expand a (normalized) use clause into concrete path strings. Handles a
 *  single top-level `{ … }` group (the common case). */
export function expandUse(rawClause) {
  const clause = normalizeUseClause(rawClause)
  const bi = clause.indexOf('{')
  if (bi === -1) return [clause]
  const prefix = clause.slice(0, bi)
  const inner = clause.slice(bi + 1, clause.lastIndexOf('}'))
  return splitTopLevel(inner).flatMap((part) => {
    if (part.includes('{')) return [] // nested brace — out of scope
    return [prefix + part]
  }).filter(Boolean)
}

/** Extract `mod NAME;` declarations (not inline `mod NAME { … }`). */
export function extractModDecls(text) {
  const out = []
  const re = /^[ \t]*(?:pub(?:\([^)]*\))?[ \t]+)?mod[ \t]+([A-Za-z_]\w*)[ \t]*;/gm
  let m
  while ((m = re.exec(text)) !== null) out.push(m[1])
  return out
}

/** Extract raw `use …;` clauses (may span lines inside braces). */
export function extractUseClauses(text) {
  const out = []
  const re = /^[ \t]*(?:pub(?:\([^)]*\))?[ \t]+)?use[ \t]+([^;]+);/gm
  let m
  while ((m = re.exec(text)) !== null) out.push(m[1])
  return out
}

export async function buildRust(repoPath, _opts = {}) {
  const absRepo = repoPath
  const files = await collectRsFiles(absRepo)

  // Crate root dirs = dirs holding lib.rs / main.rs (longest-prefix wins).
  const roots = [...new Set(
    files.filter((f) => { const b = baseOf(f); return b === 'lib.rs' || b === 'main.rs' })
      .map((f) => dirOf(f)),
  )].sort((a, b) => b.length - a.length)

  const rootDirFor = (d) => {
    for (const r of roots) {
      if (d === r || (r !== '' && d.startsWith(r + '/'))) return r
      if (r === '' ) return ''
    }
    if (d === 'src' || d.startsWith('src/')) return 'src'
    return ''
  }

  /** Module segments + the dir that holds this module's children. */
  function moduleInfo(f) {
    const d = dirOf(f)
    const b = baseOf(f)
    const root = rootDirFor(d)
    const relDir = root ? (d === root ? '' : d.slice(root.length + 1)) : d
    const dirSegs = relDir ? relDir.split('/') : []
    if (b === 'lib.rs' || b === 'main.rs') return { segs: [], moduleDir: d }
    if (b === 'mod.rs') return { segs: dirSegs, moduleDir: d }
    const name = b.replace(/\.rs$/, '')
    return { segs: [...dirSegs, name], moduleDir: d ? `${d}/${name}` : name }
  }

  const index = new Map()      // "a::b" → file
  const infoByFile = new Map()
  for (const f of files) {
    const info = moduleInfo(f)
    infoByFile.set(f, info)
    index.set(info.segs.join('::'), f)
  }

  /** Resolve module segments to a file, dropping trailing item segments. */
  function resolveSegs(segs) {
    const s = [...segs]
    while (s.length) {
      const hit = index.get(s.join('::'))
      if (hit) return hit
      s.pop()
    }
    return index.get('') ?? null // crate root (lib.rs/main.rs) item
  }

  const forward = new Map()
  const reverse = new Map()
  let edges = 0
  let unresolved = 0

  const addEdge = (fromFile, toFile, deps) => {
    if (!toFile || toFile === fromFile) return
    deps.add(toFile)
  }

  for (const file of files) {
    let text
    try {
      const stat = await fs.stat(join(absRepo, file))
      if (stat.size > MAX_FILE_BYTES) { forward.set(file, new Set()); continue }
      text = await fs.readFile(join(absRepo, file), 'utf8')
    } catch { forward.set(file, new Set()); continue }

    const info = infoByFile.get(file)
    const deps = new Set()

    // 1) `mod NAME;` → child module file.
    for (const name of extractModDecls(text)) {
      const childFile = index.get([...info.segs, name].join('::'))
      if (childFile) addEdge(file, childFile, deps)
      else unresolved += 1
    }

    // 2) `use` paths.
    for (const clause of extractUseClauses(text)) {
      for (const path of expandUse(clause)) {
        const segs = path.split('::').filter(Boolean)
        if (!segs.length) continue
        let abs
        if (segs[0] === 'crate' || segs[0] === '$crate') {
          abs = segs.slice(1)
        } else if (segs[0] === 'self') {
          abs = [...info.segs, ...segs.slice(1)]
        } else if (segs[0] === 'super') {
          let up = 0
          while (segs[up] === 'super') up += 1
          abs = [...info.segs.slice(0, Math.max(0, info.segs.length - up)), ...segs.slice(up)]
        } else if (index.has(segs[0])) {
          abs = segs // bare path into a known top-level module (2015-edition / re-export)
        } else {
          unresolved += 1 // std / core / external crate
          continue
        }
        const target = resolveSegs(abs.filter((x) => x !== '*'))
        if (target) addEdge(file, target, deps)
        else unresolved += 1
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
    stats: { modules: forward.size, edges, unresolved, language: 'rust' },
  }
}

export const __test = { collectRsFiles }
