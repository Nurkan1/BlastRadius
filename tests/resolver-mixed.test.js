/**
 * Mixed-repo graph union (rc9.18).
 *
 * A monorepo with more than one language (e.g. a Go backend + a Python service,
 * or a JS frontend + a backend) should get the UNION of all its language
 * graphs, not just the primary one. Because each resolver only emits keys for
 * its own file extensions, the maps are disjoint and the union is conflict-free.
 *
 * These tests use a Go+Python fixture (both zero-dep resolvers → fully
 * deterministic, no dependency-cruiser in a tmpdir) to prove the merge, plus
 * detectLanguages unit cases that include jsts.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { build, consumersOf, detectLanguages, detectLanguage } from '../src/server/graphResolver.js'

const MODULE = 'github.com/acme/svc'
let repo

beforeAll(async () => {
  repo = await fs.mkdtemp(join(tmpdir(), 'blastradius-mixed-'))
  // BOTH a Go module and a Python project in the same tree.
  await fs.writeFile(join(repo, 'go.mod'), `module ${MODULE}\n\ngo 1.22\n`)
  await fs.writeFile(join(repo, 'pyproject.toml'), "[project]\nname='svc'\n")

  const write = async (rel, body) => {
    const abs = join(repo, rel)
    await fs.mkdir(join(abs, '..'), { recursive: true })
    await fs.writeFile(abs, body, 'utf8')
  }

  // Go side: cmd/main.go imports internal/store
  await write('cmd/main.go', [
    'package main',
    `import "${MODULE}/internal/store"`,
    'func main() { _ = store.New() }',
  ].join('\n') + '\n')
  await write('internal/store/store.go', 'package store\n\nfunc New() int { return 0 }\n')

  // Python side: pyapp/api.py imports pyapp.models
  await write('pyapp/__init__.py', '')
  await write('pyapp/api.py', 'from pyapp.models import User\n')
  await write('pyapp/models.py', 'class User: pass\n')
})

afterAll(async () => {
  await fs.rm(repo, { recursive: true, force: true })
})

describe('detectLanguages', () => {
  it('lists every language present, deterministically (jsts, go, python)', () => {
    expect(detectLanguages(repo)).toEqual(['go', 'python'])
  })

  it('falls back to [jsts] when no marker exists', async () => {
    const empty = await fs.mkdtemp(join(tmpdir(), 'blastradius-empty-'))
    try {
      expect(detectLanguages(empty)).toEqual(['jsts'])
    } finally {
      await fs.rm(empty, { recursive: true, force: true })
    }
  })

  it('detectLanguage (singular) still returns ONE primary for back-compat', () => {
    // go.mod wins over python in the priority order.
    expect(detectLanguage(repo)).toBe('go')
  })
})

describe('build(mixed repo) — union', () => {
  let graph
  beforeAll(async () => { graph = await build(repo) })

  it('labels the graph with all languages joined', () => {
    expect(graph.stats.language).toBe('go+python')
  })

  it('contains the Go subgraph (cmd/main.go → internal/store/store.go)', () => {
    expect(graph.forward.get('cmd/main.go')).toContain('internal/store/store.go')
  })

  it('contains the Python subgraph (pyapp/api.py → pyapp/models.py)', () => {
    expect(graph.forward.get('pyapp/api.py')).toContain('pyapp/models.py')
  })

  it('reverse map + BFS work across the union, independently per language', () => {
    expect(consumersOf(graph, 'internal/store/store.go', 1)).toContain('cmd/main.go')
    expect(consumersOf(graph, 'pyapp/models.py', 1)).toContain('pyapp/api.py')
  })

  it('module count is the sum of both languages, with no cross-language edges', () => {
    // 2 Go files + 3 Python files = 5 modules.
    expect(graph.stats.modules).toBe(5)
    // A Go file never depends on a Python file and vice versa.
    const goDeps = [...(graph.forward.get('cmd/main.go') ?? [])]
    expect(goDeps.every((d) => d.endsWith('.go'))).toBe(true)
    const pyDeps = [...(graph.forward.get('pyapp/api.py') ?? [])]
    expect(pyDeps.every((d) => d.endsWith('.py'))).toBe(true)
  })
})
