/**
 * Java import resolver (rc9.23) — zero-dep scanner.
 *
 * Fixture Maven-style project in a tmpdir exercising the resolution model:
 * `package` declaration + file name → FQCN index, explicit `import a.b.C;`,
 * wildcard `import a.b.*;` (type-import-on-demand), `import static C.member;`
 * (trailing member stripped), inner-class imports (drop-to-known-FQCN), and
 * external `java.*` imports being ignored. Same graph contract as the other
 * resolvers, verified through the dispatcher + the BFS helpers.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { build, consumersOf, detectLanguage, detectLanguages, isSourceFile } from '../src/server/graphResolver.js'
import { extractPackage, extractImports } from '../src/server/resolvers/java.js'

let repo

beforeAll(async () => {
  repo = await fs.mkdtemp(join(tmpdir(), 'blastradius-java-'))
  await fs.writeFile(join(repo, 'pom.xml'), '<project><artifactId>demo</artifactId></project>\n')

  const write = async (rel, body) => {
    const abs = join(repo, rel)
    await fs.mkdir(join(abs, '..'), { recursive: true })
    await fs.writeFile(abs, body, 'utf8')
  }

  // Maven layout under src/main/java/com/demo/**
  //   App.java     package com.demo;        import com.demo.db.Repo; import com.demo.model.*;
  //   db/Repo.java package com.demo.db;     import java.util.List;  (external → ignored)
  //   model/User.java   package com.demo.model;  (has inner class Address)
  //   model/Role.java   package com.demo.model;
  //   util/Helper.java  package com.demo.util;
  //        import static com.demo.db.Repo.find;   (static → Repo)
  //        import com.demo.model.User.Address;     (inner class → User)
  await write('src/main/java/com/demo/App.java', [
    'package com.demo;',
    'import com.demo.db.Repo;',
    'import com.demo.model.*;',
    'public class App { void run(Repo r, User u, Role x) {} }',
  ].join('\n') + '\n')

  await write('src/main/java/com/demo/db/Repo.java', [
    'package com.demo.db;',
    'import java.util.List;',          // external → ignored
    'public class Repo { public static Object find() { return null; } }',
  ].join('\n') + '\n')

  await write('src/main/java/com/demo/model/User.java', [
    'package com.demo.model;',
    'public class User { public static class Address {} }',
  ].join('\n') + '\n')

  await write('src/main/java/com/demo/model/Role.java', [
    'package com.demo.model;',
    'public class Role {}',
  ].join('\n') + '\n')

  await write('src/main/java/com/demo/util/Helper.java', [
    'package com.demo.util;',
    'import static com.demo.db.Repo.find;',   // static import → Repo.java
    'import com.demo.model.User.Address;',     // inner class → User.java
    'public class Helper {}',
  ].join('\n') + '\n')
})

afterAll(async () => {
  await fs.rm(repo, { recursive: true, force: true })
})

describe('detectLanguage', () => {
  it('classifies a pom.xml repo as java', () => {
    expect(detectLanguage(repo)).toBe('java')
    expect(detectLanguages(repo)).toEqual(['java'])
  })
  it('treats .java as a source file that triggers a rebuild', () => {
    expect(isSourceFile('src/main/java/com/demo/App.java')).toBe(true)
  })
})

describe('build(java project)', () => {
  let graph
  beforeAll(async () => { graph = await build(repo) })

  const F = {
    app: 'src/main/java/com/demo/App.java',
    repo: 'src/main/java/com/demo/db/Repo.java',
    user: 'src/main/java/com/demo/model/User.java',
    role: 'src/main/java/com/demo/model/Role.java',
    helper: 'src/main/java/com/demo/util/Helper.java',
  }

  it('reports the java language and all .java files as modules', () => {
    expect(graph.stats.language).toBe('java')
    expect(graph.stats.modules).toBe(5)
  })

  it('resolves an explicit `import a.b.C;` to the declaring file', () => {
    expect(graph.forward.get(F.app)).toContain(F.repo)
  })

  it('expands a wildcard `import a.b.*;` to every file in that package', () => {
    const deps = graph.forward.get(F.app)
    expect(deps).toContain(F.user)
    expect(deps).toContain(F.role)
  })

  it('strips the trailing member of a `import static C.member;`', () => {
    expect(graph.forward.get(F.helper)).toContain(F.repo)
  })

  it('resolves an inner-class import by dropping to the known FQCN', () => {
    // import com.demo.model.User.Address → User.java
    expect(graph.forward.get(F.helper)).toContain(F.user)
  })

  it('ignores java.* / external imports (Repo has no internal deps)', () => {
    // Every resolved target must be one of the 5 fixture files — an external
    // import (java.util.List) must never sneak in as a node.
    const known = new Set(Object.values(F))
    const allTargets = [...graph.forward.values()].flatMap((s) => [...s])
    expect(allTargets.every((t) => known.has(t))).toBe(true)
    expect([...(graph.forward.get(F.repo) ?? [])]).toEqual([])
    expect(graph.stats.unresolved).toBeGreaterThan(0) // java.util.List
  })

  it('reverse map + BFS work across packages', () => {
    const repoConsumers = consumersOf(graph, F.repo, 1)
    expect(repoConsumers).toContain(F.app)
    expect(repoConsumers).toContain(F.helper)
    const userConsumers = consumersOf(graph, F.user, 1)
    expect(userConsumers).toContain(F.app)
    expect(userConsumers).toContain(F.helper)
  })

  it('does not create a self-edge from a wildcard import of one\'s own package', () => {
    // Role/User are in com.demo.model; neither imports the package wildcard,
    // but assert generally that no file depends on itself.
    for (const [f, deps] of graph.forward) expect(deps.has(f)).toBe(false)
  })
})

describe('parser units', () => {
  it('extractPackage reads the declared package, empty for default', () => {
    expect(extractPackage('package com.demo.api;\npublic class X {}')).toBe('com.demo.api')
    expect(extractPackage('public class X {}')).toBe('')
  })
  it('extractImports flags static + wildcard correctly', () => {
    const imps = extractImports([
      'import com.a.B;',
      'import com.a.*;',
      'import static com.a.B.C;',
      'import static com.a.B.*;',
    ].join('\n'))
    expect(imps).toEqual([
      { path: 'com.a.B', wildcard: false, isStatic: false },
      { path: 'com.a.*', wildcard: true, isStatic: false },
      { path: 'com.a.B.C', wildcard: false, isStatic: true },
      { path: 'com.a.B.*', wildcard: true, isStatic: true },
    ])
  })
  it('does not pick up a commented-out import on a `//` line', () => {
    expect(extractImports('// import com.a.B;\nimport com.a.C;')).toEqual([
      { path: 'com.a.C', wildcard: false, isStatic: false },
    ])
  })
})
