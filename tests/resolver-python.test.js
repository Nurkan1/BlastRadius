/**
 * Python import resolver (rc9.16) — zero-dep scanner.
 *
 * Builds a fixture Python package tree in a tmpdir and asserts the resolver
 * produces the same graph contract as the JS/TS path: repo-relative
 * forward/reverse maps, internal-only edges (stdlib/pip ignored), and the BFS
 * helpers (consumersOf) work over the result unchanged.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { build, consumersOf, detectLanguage, isSourceFile } from '../src/server/graphResolver.js'
import { extractImports, __test } from '../src/server/resolvers/python.js'

let repo

beforeAll(async () => {
  repo = await fs.mkdtemp(join(tmpdir(), 'blastradius-py-'))
  // Mark it a Python project so detectLanguage picks the python resolver.
  await fs.writeFile(join(repo, 'pyproject.toml'), "[project]\nname='demo'\n")

  const write = async (rel, body) => {
    const abs = join(repo, rel)
    await fs.mkdir(join(abs, '..'), { recursive: true })
    await fs.writeFile(abs, body, 'utf8')
  }

  // Package layout:
  //   app/__init__.py
  //   app/main.py        imports app.models.user (absolute) + os (stdlib)
  //   app/models/__init__.py
  //   app/models/user.py imports ..db (relative parent) + from . import base
  //   app/models/base.py (leaf)
  //   app/db.py          (leaf)
  await write('app/__init__.py', '')
  await write('app/main.py', [
    'import os',                              // stdlib → ignored
    'from app.models.user import User',       // absolute submodule
    'import app.db',                          // absolute module
  ].join('\n') + '\n')
  await write('app/models/__init__.py', '')
  await write('app/models/user.py', [
    'from ..db import connect',               // relative parent package
    'from . import base',                     // relative sibling module
    'import json',                            // stdlib → ignored
  ].join('\n') + '\n')
  await write('app/models/base.py', 'X = 1\n')
  await write('app/db.py', 'def connect():\n    return None\n')
})

afterAll(async () => {
  await fs.rm(repo, { recursive: true, force: true })
})

describe('detectLanguage', () => {
  it('classifies a pyproject repo as python', () => {
    expect(detectLanguage(repo)).toBe('python')
  })
  it('treats .py as a source file that triggers a rebuild', () => {
    expect(isSourceFile('app/models/user.py')).toBe(true)
  })
})

describe('build(python repo)', () => {
  let graph
  beforeAll(async () => { graph = await build(repo) })

  it('reports the python language and a non-empty module set', () => {
    expect(graph.stats.language).toBe('python')
    expect(graph.stats.modules).toBeGreaterThanOrEqual(5)
  })

  it('resolves an absolute submodule import (main → models/user)', () => {
    expect(graph.forward.get('app/main.py')).toContain('app/models/user.py')
  })

  it('resolves an absolute module import (main → db)', () => {
    expect(graph.forward.get('app/main.py')).toContain('app/db.py')
  })

  it('resolves a relative parent import (models/user → db)', () => {
    expect(graph.forward.get('app/models/user.py')).toContain('app/db.py')
  })

  it('resolves a relative sibling import (models/user → models/base)', () => {
    expect(graph.forward.get('app/models/user.py')).toContain('app/models/base.py')
  })

  it('ignores stdlib imports (os, json never appear as edges)', () => {
    const allTargets = [...graph.forward.values()].flatMap((s) => [...s])
    expect(allTargets.some((t) => t.includes('os') || t.includes('json'))).toBe(false)
    expect(graph.stats.unresolved).toBeGreaterThan(0) // os/json counted as unresolved
  })

  it('builds a reverse map the BFS helper can walk (db is imported by 2 files)', () => {
    // app/db.py is imported by app/main.py and app/models/user.py.
    const consumers = consumersOf(graph, 'app/db.py', 1)
    expect(consumers).toContain('app/main.py')
    expect(consumers).toContain('app/models/user.py')
  })

  it('propagates transitively (base is reached from main via user at depth 2)', () => {
    const depth2 = consumersOf(graph, 'app/models/base.py', 2)
    expect(depth2).toContain('app/models/user.py') // depth 1
    expect(depth2).toContain('app/main.py')        // depth 2 (main → user → base)
  })
})

describe('extractImports (unit)', () => {
  it('parses plain, aliased, and multi imports', () => {
    const imps = extractImports('import a.b\nimport c as d, e.f\n')
    const flat = imps.flatMap((i) => i.names)
    expect(flat).toContain('a.b')
    expect(flat).toContain('c')
    expect(flat).toContain('e.f')
  })

  it('parses from-import with parentheses spanning lines', () => {
    const imps = extractImports('from pkg.mod import (\n  a,\n  b as c,\n)\n')
    const fr = imps.find((i) => i.base === 'pkg.mod')
    expect(fr).toBeTruthy()
    expect(fr.names).toEqual(expect.arrayContaining(['a', 'b']))
  })

  it('captures leading dots for relative imports', () => {
    const imps = extractImports('from ..pkg import x\nfrom . import y\n')
    expect(imps.find((i) => i.dots === 2 && i.base === 'pkg')).toBeTruthy()
    expect(imps.find((i) => i.dots === 1 && i.base === '')).toBeTruthy()
  })

  it('moduleNameFor + packageOf map paths correctly', () => {
    expect(__test.moduleNameFor('app/models/user.py')).toBe('app.models.user')
    expect(__test.moduleNameFor('app/models/__init__.py')).toBe('app.models')
    expect(__test.packageOf('app/models/user.py')).toBe('app.models')
    expect(__test.packageOf('app/models/__init__.py')).toBe('app.models')
  })
})
