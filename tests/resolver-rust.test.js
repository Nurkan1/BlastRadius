/**
 * Rust import resolver (rc9.22) — zero-dep scanner.
 *
 * Fixture crate in a tmpdir exercising the module tree: `mod NAME;` child
 * declarations, `use crate::…` / `use super::…` path resolution, and external
 * (`std::…`) imports being ignored. Same graph contract as the other
 * resolvers, verified through the dispatcher + the BFS helpers.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { build, consumersOf, detectLanguage, detectLanguages, isSourceFile } from '../src/server/graphResolver.js'
import { extractModDecls, extractUseClauses, expandUse } from '../src/server/resolvers/rust.js'

let repo

beforeAll(async () => {
  repo = await fs.mkdtemp(join(tmpdir(), 'blastradius-rs-'))
  await fs.writeFile(join(repo, 'Cargo.toml'), "[package]\nname = \"demo\"\nversion = \"0.1.0\"\n")

  const write = async (rel, body) => {
    const abs = join(repo, rel)
    await fs.mkdir(join(abs, '..'), { recursive: true })
    await fs.writeFile(abs, body, 'utf8')
  }

  // Crate layout:
  //   src/main.rs        mod db; mod models; use crate::{db::open, models::user::User};
  //   src/db.rs          leaf; use std::io (external → ignored)
  //   src/models/mod.rs  pub mod user;  (mod decl → models/user.rs)
  //   src/models/user.rs use crate::db::open; use super::greet; use std::fmt (external)
  await write('src/main.rs', [
    'mod db;',
    'mod models;',
    'use crate::db::open;',
    'use crate::models::user::User;',
    'fn main() { let _ = open(); let _u = User; }',
  ].join('\n') + '\n')

  await write('src/db.rs', [
    'use std::io;',           // external → ignored
    'pub fn open() -> u8 { 0 }',
  ].join('\n') + '\n')

  await write('src/models/mod.rs', [
    'pub mod user;',          // mod decl → src/models/user.rs
    'pub fn greet() {}',
  ].join('\n') + '\n')

  await write('src/models/user.rs', [
    'use crate::db::open;',   // → src/db.rs
    'use super::greet;',      // super from models::user → models (src/models/mod.rs)
    'use std::fmt;',          // external → ignored
    'pub struct User;',
  ].join('\n') + '\n')
})

afterAll(async () => {
  await fs.rm(repo, { recursive: true, force: true })
})

describe('detectLanguage', () => {
  it('classifies a Cargo.toml repo as rust', () => {
    expect(detectLanguage(repo)).toBe('rust')
    expect(detectLanguages(repo)).toEqual(['rust'])
  })
  it('treats .rs as a source file that triggers a rebuild', () => {
    expect(isSourceFile('src/models/user.rs')).toBe(true)
  })
})

describe('build(rust crate)', () => {
  let graph
  beforeAll(async () => { graph = await build(repo) })

  it('reports the rust language and all .rs files as modules', () => {
    expect(graph.stats.language).toBe('rust')
    expect(graph.stats.modules).toBe(4)
  })

  it('`mod NAME;` declares child-module edges (main → db, models)', () => {
    const deps = graph.forward.get('src/main.rs')
    expect(deps).toContain('src/db.rs')
    expect(deps).toContain('src/models/mod.rs')
  })

  it('resolves `use crate::…` item paths to the defining module file', () => {
    // use crate::models::user::User → drops the `User` item → models/user.rs
    expect(graph.forward.get('src/main.rs')).toContain('src/models/user.rs')
  })

  it('`pub mod user;` in models/mod.rs → models/user.rs', () => {
    expect(graph.forward.get('src/models/mod.rs')).toContain('src/models/user.rs')
  })

  it('resolves `use super::…` against the parent module', () => {
    // user.rs: use super::greet → parent module `models` → src/models/mod.rs
    expect(graph.forward.get('src/models/user.rs')).toContain('src/models/mod.rs')
    // and use crate::db::open → src/db.rs
    expect(graph.forward.get('src/models/user.rs')).toContain('src/db.rs')
  })

  it('ignores std / external crates (db.rs has no internal deps)', () => {
    const allTargets = [...graph.forward.values()].flatMap((s) => [...s])
    expect(allTargets.some((t) => t.includes('std') || t.includes('io') || t.includes('fmt'))).toBe(false)
    expect([...(graph.forward.get('src/db.rs') ?? [])]).toEqual([])
    expect(graph.stats.unresolved).toBeGreaterThan(0) // std::io, std::fmt
  })

  it('reverse map + BFS work across the module tree', () => {
    const dbConsumers = consumersOf(graph, 'src/db.rs', 1)
    expect(dbConsumers).toContain('src/main.rs')
    expect(dbConsumers).toContain('src/models/user.rs')
  })
})

describe('parser units', () => {
  it('extractModDecls picks `mod x;` but not inline `mod x { }`', () => {
    expect(extractModDecls('mod a;\npub mod b;\nmod c { fn x(){} }\n')).toEqual(['a', 'b'])
  })
  it('extractUseClauses captures multi-line brace clauses', () => {
    const clauses = extractUseClauses('use crate::a::{\n  b,\n  c,\n};\nuse std::io;\n')
    expect(clauses.length).toBe(2)
  })
  it('expandUse expands a brace group + strips aliases', () => {
    expect(expandUse('crate::a::{b, c::d}')).toEqual(['crate::a::b', 'crate::a::c::d'])
    expect(expandUse('crate::db::open as o')).toEqual(['crate::db::open'])
  })
})
