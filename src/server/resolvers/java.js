/**
 * Java import resolver (rc9.23) — ZERO-DEPENDENCY scanner.
 *
 * Per-language resolver behind graphResolver's dispatcher; returns the exact
 * same { forward, reverse, builtAt, stats } contract as JS/TS + Python + Go +
 * Rust, so it is invisible to every downstream consumer.
 *
 *   { forward: Map<file,Set<file>>, reverse: Map<file,Set<file>>,
 *     builtAt: number, stats: { modules, edges, unresolved, language: 'java' } }
 *
 * All paths are repo-relative with forward slashes.
 *
 * How Java resolution works (and why it is the cleanest of the five):
 *   - Every `.java` file declares its package with `package a.b.c;` (or the
 *     default package when omitted). The public top-level class matches the
 *     file name by convention, so the file's fully-qualified class name (FQCN)
 *     is `a.b.c.ClassName`. We index FQCN → file PURELY from the declared
 *     package + file name — NOT from the directory layout. That is exactly how
 *     `javac` resolves names, so a (rare) misplaced file still resolves right.
 *   - `import a.b.c.Foo;`        → FQCN `a.b.c.Foo` → the file declaring it.
 *   - `import a.b.c.*;`          → every file whose package is `a.b.c`.
 *   - `import static a.b.c.Foo.bar;` → strip the trailing member → `a.b.c.Foo`.
 *   - Inner classes (`import a.b.Outer.Inner;`) resolve by dropping trailing
 *     segments until a known FQCN is hit → `a.b.Outer`.
 *   - `java.*` / `javax.*` / `jakarta.*` and any unindexed FQCN are external
 *     (the Java analogue of node_modules) → ignored, counted as unresolved.
 *
 * Honest scope limits (NOT bugs): does not model SAME-PACKAGE implicit
 * references (Java needs no import for a class in the same package), secondary
 * package-private top-level classes whose name differs from the file, or
 * imports buried inside multi-line block comments. Good enough for blast-radius
 * impact awareness.
 *
 * Security / safety: read-only; skips build-output + VCS/tool dirs; file +
 * size caps; runs under the dispatcher's hard timeout.
 */

import { promises as fs } from 'node:fs'
import { join } from 'node:path'

const MAX_FILES = 8000
const MAX_FILE_BYTES = 2 * 1024 * 1024
// target/ (Maven), build/ + .gradle/ (Gradle), out/ + bin/ (IDE output).
const SKIP_DIRS = new Set([
  '.git', 'node_modules', 'target', 'build', '.gradle', 'out', 'bin', '.idea', '.vscode',
])

const fwd = (p) => p.replace(/\\/g, '/')
const baseOf = (rel) => { const i = rel.lastIndexOf('/'); return i === -1 ? rel : rel.slice(i + 1) }

/** Recursively collect repo-relative `.java` file paths (forward-slashed),
 *  skipping build-output, VCS and tool dirs. */
async function collectJavaFiles(absRepo) {
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
      } else if (e.isFile() && e.name.endsWith('.java')) {
        // package-info.java / module-info.java carry no top-level class FQCN.
        if (e.name === 'module-info.java') continue
        out.push(fwd(childRel))
        if (out.length >= MAX_FILES) break
      }
    }
  }
  return out
}

/** The declared package of a Java source ('' for the default package). */
export function extractPackage(text) {
  const m = /^[ \t]*package[ \t]+([\w$]+(?:\.[\w$]+)*)[ \t]*;/m.exec(String(text))
  return m ? m[1] : ''
}

/**
 * Extract import declarations. Returns objects:
 *   { path: string, wildcard: boolean, isStatic: boolean }
 * `path` keeps the trailing `.*` for wildcards; resolution strips it.
 */
export function extractImports(text) {
  const out = []
  const re = /^[ \t]*import[ \t]+(static[ \t]+)?([\w$.]+(?:\.\*)?)[ \t]*;/gm
  let m
  while ((m = re.exec(String(text))) !== null) {
    const path = m[2]
    out.push({ path, wildcard: path.endsWith('.*'), isStatic: !!m[1] })
  }
  return out
}

/** Build the import graph for a Java repo. */
export async function buildJava(repoPath, _opts = {}) {
  const absRepo = repoPath
  const files = await collectJavaFiles(absRepo)

  // FQCN → file (from declared package + file name) and package → Set<file>.
  const classIndex = new Map()
  const packageIndex = new Map()
  const pkgByFile = new Map()

  for (const file of files) {
    let text
    try {
      const stat = await fs.stat(join(absRepo, file))
      if (stat.size > MAX_FILE_BYTES) { pkgByFile.set(file, ''); continue }
      text = await fs.readFile(join(absRepo, file), 'utf8')
    } catch { pkgByFile.set(file, ''); continue }

    const pkg = extractPackage(text)
    const className = baseOf(file).replace(/\.java$/, '')
    const fqcn = pkg ? `${pkg}.${className}` : className
    classIndex.set(fqcn, file)
    pkgByFile.set(file, pkg)
    const set = packageIndex.get(pkg)
    if (set) set.add(file)
    else packageIndex.set(pkg, new Set([file]))
  }

  // Resolve a (possibly inner/static) FQCN to its defining file by dropping
  // trailing segments until a known class is hit. Package prefixes never live
  // in classIndex, so there are no false positives.
  const resolveClass = (fqcn) => {
    const segs = fqcn.split('.')
    while (segs.length) {
      const hit = classIndex.get(segs.join('.'))
      if (hit) return hit
      segs.pop()
    }
    return null
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
    } catch { forward.set(file, new Set()); continue }

    const deps = new Set()
    for (const imp of extractImports(text)) {
      if (imp.wildcard && !imp.isStatic) {
        // import a.b.* → every file in package a.b
        const pkg = imp.path.slice(0, -2) // drop ".*"
        const targets = packageIndex.get(pkg)
        if (!targets) { unresolved += 1; continue }
        let any = false
        for (const t of targets) {
          if (t === file) continue
          deps.add(t)
          any = true
        }
        if (!any) unresolved += 1
        continue
      }
      // Class import (plain, static, or static-wildcard `import static C.*`).
      const fqcn = imp.wildcard ? imp.path.slice(0, -2) : imp.path
      const target = resolveClass(fqcn)
      if (target && target !== file) deps.add(target)
      else if (!target) unresolved += 1
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
    stats: { modules: forward.size, edges, unresolved, language: 'java' },
  }
}

export const __test = { collectJavaFiles }
