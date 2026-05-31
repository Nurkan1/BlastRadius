/**
 * Go import resolver (rc9.17) — zero-dep scanner.
 *
 * Builds a fixture Go module in a tmpdir and asserts the resolver produces the
 * same graph contract as the JS/TS and Python paths: repo-relative
 * forward/reverse maps, internal-only edges (stdlib/third-party ignored),
 * package imports expanded to every .go file in the package directory, and the
 * BFS helpers (consumersOf) work over the result unchanged.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { build, consumersOf, detectLanguage, isSourceFile } from '../src/server/graphResolver.js'
import { extractImports, __test } from '../src/server/resolvers/go.js'

const MODULE = 'github.com/acme/demo'
let repo

beforeAll(async () => {
  repo = await fs.mkdtemp(join(tmpdir(), 'blastradius-go-'))
  await fs.writeFile(join(repo, 'go.mod'), `module ${MODULE}\n\ngo 1.22\n`)

  const write = async (rel, body) => {
    const abs = join(repo, rel)
    await fs.mkdir(join(abs, '..'), { recursive: true })
    await fs.writeFile(abs, body, 'utf8')
  }

  // Layout:
  //   main.go                imports internal/db (block) + fmt (stdlib)
  //   internal/db/db.go      package db, imports internal/model
  //   internal/db/pool.go    package db (second file in the same package)
  //   internal/model/model.go  leaf package
  await write('main.go', [
    'package main',
    '',
    'import (',
    '\t"fmt"',                                   // stdlib → ignored
    `\t"${MODULE}/internal/db"`,                 // internal package import
    '\t"github.com/other/lib"',                  // third-party → ignored
    ')',
    '',
    'func main() { fmt.Println(db.Open()) }',
  ].join('\n') + '\n')

  await write('internal/db/db.go', [
    'package db',
    '',
    `import "${MODULE}/internal/model"`,          // single-line internal import
    '',
    'func Open() model.T { return model.T{} }',
  ].join('\n') + '\n')

  await write('internal/db/pool.go', 'package db\n\nvar pool int\n')

  await write('internal/model/model.go', 'package model\n\ntype T struct{}\n')
})

afterAll(async () => {
  await fs.rm(repo, { recursive: true, force: true })
})

describe('detectLanguage', () => {
  it('classifies a go.mod repo as go', () => {
    expect(detectLanguage(repo)).toBe('go')
  })
  it('treats .go as a source file that triggers a rebuild', () => {
    expect(isSourceFile('internal/db/db.go')).toBe(true)
  })
})

describe('build(go repo)', () => {
  let graph
  beforeAll(async () => { graph = await build(repo) })

  it('reports the go language and all .go files as modules', () => {
    expect(graph.stats.language).toBe('go')
    expect(graph.stats.modules).toBe(4)
  })

  it('expands a package import to EVERY file in that package dir', () => {
    // main.go imports the `db` package → edges to both files in internal/db/.
    const deps = graph.forward.get('main.go')
    expect(deps).toContain('internal/db/db.go')
    expect(deps).toContain('internal/db/pool.go')
  })

  it('resolves a single-line internal import (db → model)', () => {
    expect(graph.forward.get('internal/db/db.go')).toContain('internal/model/model.go')
  })

  it('ignores stdlib and third-party imports', () => {
    const allTargets = [...graph.forward.values()].flatMap((s) => [...s])
    expect(allTargets.some((t) => t.includes('fmt') || t.includes('other'))).toBe(false)
    expect(graph.stats.unresolved).toBeGreaterThan(0) // fmt + github.com/other/lib
  })

  it('builds a reverse map the BFS helper can walk', () => {
    // internal/model is imported by internal/db/db.go (depth 1), which is
    // imported by main.go (depth 2 via the db package).
    const d1 = consumersOf(graph, 'internal/model/model.go', 1)
    expect(d1).toContain('internal/db/db.go')
    const d2 = consumersOf(graph, 'internal/model/model.go', 2)
    expect(d2).toContain('main.go')
  })

  it('does not create self-edges within a package', () => {
    expect(graph.forward.get('internal/db/pool.go')?.has('internal/db/pool.go')).toBeFalsy()
  })
})

describe('extractImports (unit)', () => {
  it('parses a block import with stdlib + aliased + internal', () => {
    const text = 'import (\n\t"fmt"\n\tm "github.com/x/y"\n\t_ "side/effect"\n)\n'
    const paths = extractImports(text)
    expect(paths).toEqual(expect.arrayContaining(['fmt', 'github.com/x/y', 'side/effect']))
  })
  it('parses single-line and aliased single imports', () => {
    expect(extractImports('import "github.com/a/b"\n')).toContain('github.com/a/b')
    expect(extractImports('import alias "github.com/c/d"\n')).toContain('github.com/c/d')
  })
  it('reads the module path from go.mod', async () => {
    expect(await __test.readModulePath(repo)).toBe(MODULE)
  })
  it('dirOf maps file paths to package dirs', () => {
    expect(__test.dirOf('internal/db/db.go')).toBe('internal/db')
    expect(__test.dirOf('main.go')).toBe('')
  })
})
