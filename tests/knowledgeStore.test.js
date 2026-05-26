/**
 * KnowledgeStore — JSON persistence for the Knowledge Graph semantic layer.
 *
 * Each test boots a fresh store anchored to a unique tmp directory so we
 * never touch the real ~/.blastradius/knowledge.json on the developer
 * machine. Patterns mirror tests/preferences.test.js — same atomic-write
 * + corruption-recovery contract.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  KnowledgeStore,
  emptyStore,
  getDefaultPaths,
  SCHEMA_VERSION,
  SUMMARY_MAX_CHARS,
  TAGS_MAX,
  TAG_MAX_CHARS,
  NODES_PER_REPO_CAP,
} from '../src/server/knowledgeStore.js'

let tempDir
let paths
let store

beforeEach(async () => {
  tempDir = await fs.mkdtemp(join(tmpdir(), 'blastradius-knowledge-'))
  paths = getDefaultPaths(tempDir)
  store = new KnowledgeStore({ paths })
})

afterEach(async () => {
  await fs.rm(tempDir, { recursive: true, force: true })
})

// ─── Load / boot semantics ────────────────────────────────────────────────

describe('KnowledgeStore — load() boot semantics', () => {
  it('returns an empty store when the file does not exist', async () => {
    const s = await store.load()
    expect(s.version).toBe(SCHEMA_VERSION)
    expect(s.repos).toEqual({})
  })

  it('is idempotent — a second load() does not re-read the disk', async () => {
    await store.load()
    // Sneak a different file underneath. If load() re-reads, the new
    // content would show up. If it's idempotent (as documented), the
    // in-memory empty store wins. load() does NOT create the dir
    // (only _flush() does), so we mkdir manually before the write.
    await fs.mkdir(paths.dir, { recursive: true })
    await fs.writeFile(paths.file, JSON.stringify({
      version: SCHEMA_VERSION,
      repos: { 'somewhere': { nodes: { 'x.js': { summary: 'sneaky', tags: [], updatedAt: '2026-01-01T00:00:00Z' } } } },
    }), 'utf8')
    const second = await store.load()
    expect(second.repos.somewhere).toBeUndefined()
  })

  it('quarantines a corrupted JSON file and starts with empty store', async () => {
    await fs.mkdir(paths.dir, { recursive: true })
    await fs.writeFile(paths.file, '{ this is not valid JSON', 'utf8')
    const s = await store.load()
    // Empty in-memory.
    expect(s.repos).toEqual({})
    // Corrupted file renamed.
    const entries = await fs.readdir(paths.dir)
    const corrupted = entries.find((e) => e.startsWith('knowledge.json.bak.corrupted-'))
    expect(corrupted).toBeDefined()
    // Original is gone.
    await expect(fs.stat(paths.file)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('rejects a JSON file with the wrong schema version', async () => {
    await fs.mkdir(paths.dir, { recursive: true })
    await fs.writeFile(paths.file, JSON.stringify({ version: 999, repos: {} }), 'utf8')
    const s = await store.load()
    expect(s.repos).toEqual({})
  })

  it('rejects a JSON file with the wrong top-level shape', async () => {
    await fs.mkdir(paths.dir, { recursive: true })
    await fs.writeFile(paths.file, JSON.stringify({ random: 'object' }), 'utf8')
    const s = await store.load()
    expect(s.repos).toEqual({})
  })
})

// ─── Read API ──────────────────────────────────────────────────────────────

describe('KnowledgeStore — read API', () => {
  it('getRepoNodes returns {} for an unknown repo', async () => {
    await store.load()
    expect(store.getRepoNodes('/unknown')).toEqual({})
  })

  it('getNodeSummary returns null for an unknown node', async () => {
    await store.load()
    expect(store.getNodeSummary('/repo', 'unknown.js')).toBeNull()
  })

  it('normalizes path separators when reading', async () => {
    await store.load()
    await store.setNodeSummary('C:\\repo', 'src\\foo.js', { summary: 'x', tags: ['a'] })
    expect(store.getNodeSummary('C:/repo', 'src/foo.js')).not.toBeNull()
    // Both lookups hit the same record.
    expect(store.getNodeSummary('C:\\repo/', 'src/foo.js').summary).toBe('x')
  })
})

// ─── Write API + caps ──────────────────────────────────────────────────────

describe('KnowledgeStore — setNodeSummary()', () => {
  it('persists a new entry and survives a fresh load() of a new instance', async () => {
    await store.load()
    await store.setNodeSummary('/repo', 'src/foo.js', {
      summary: 'Hot path for the heat engine.',
      tags: ['core', 'pure'],
    })

    // Brand-new store pointed at the same dir; should pick up the file.
    const second = new KnowledgeStore({ paths })
    await second.load()
    const entry = second.getNodeSummary('/repo', 'src/foo.js')
    expect(entry).toMatchObject({
      summary: 'Hot path for the heat engine.',
      tags: ['core', 'pure'],
    })
    expect(typeof entry.updatedAt).toBe('string')
  })

  it('rewriting the same node replaces the entry', async () => {
    await store.load()
    await store.setNodeSummary('/repo', 'a.js', { summary: 'first', tags: ['x'] })
    const first = store.getNodeSummary('/repo', 'a.js')
    // Small wait so updatedAt advances.
    await new Promise((r) => setTimeout(r, 5))
    await store.setNodeSummary('/repo', 'a.js', { summary: 'second', tags: ['y'] })
    const second = store.getNodeSummary('/repo', 'a.js')
    expect(second.summary).toBe('second')
    expect(second.tags).toEqual(['y'])
    expect(Date.parse(second.updatedAt)).toBeGreaterThanOrEqual(Date.parse(first.updatedAt))
  })

  it('writing repo A does not affect repo B', async () => {
    await store.load()
    await store.setNodeSummary('/repo-a', 'x.js', { summary: 'a-summary', tags: [] })
    await store.setNodeSummary('/repo-b', 'x.js', { summary: 'b-summary', tags: [] })
    expect(store.getNodeSummary('/repo-a', 'x.js').summary).toBe('a-summary')
    expect(store.getNodeSummary('/repo-b', 'x.js').summary).toBe('b-summary')
  })

  it('strips control characters from summary and tags', async () => {
    await store.load()
    const dirty = 'has\x00null and\x07bell'
    await store.setNodeSummary('/repo', 'a.js', { summary: dirty, tags: ['ok\x00tag'] })
    const entry = store.getNodeSummary('/repo', 'a.js')
    expect(entry.summary).not.toMatch(/[\x00-\x08]/)
    expect(entry.tags[0]).toBe('oktag')
  })

  it('drops empty tags after cleaning instead of throwing', async () => {
    await store.load()
    await store.setNodeSummary('/repo', 'a.js', { summary: 'x', tags: ['real', '\x00\x00\x00'] })
    const entry = store.getNodeSummary('/repo', 'a.js')
    expect(entry.tags).toEqual(['real'])
  })
})

describe('KnowledgeStore — cap rejections', () => {
  it('rejects a summary longer than SUMMARY_MAX_CHARS', async () => {
    await store.load()
    const tooLong = 'x'.repeat(SUMMARY_MAX_CHARS + 1)
    await expect(
      store.setNodeSummary('/repo', 'a.js', { summary: tooLong, tags: [] })
    ).rejects.toMatchObject({ code: 'summary_too_long' })
  })

  it('accepts a summary at exactly SUMMARY_MAX_CHARS (boundary)', async () => {
    await store.load()
    const exact = 'x'.repeat(SUMMARY_MAX_CHARS)
    await store.setNodeSummary('/repo', 'a.js', { summary: exact, tags: [] })
    expect(store.getNodeSummary('/repo', 'a.js').summary).toHaveLength(SUMMARY_MAX_CHARS)
  })

  it('rejects more than TAGS_MAX tags', async () => {
    await store.load()
    const tooMany = Array.from({ length: TAGS_MAX + 1 }, (_, i) => `t${i}`)
    await expect(
      store.setNodeSummary('/repo', 'a.js', { summary: 'x', tags: tooMany })
    ).rejects.toMatchObject({ code: 'too_many_tags' })
  })

  it('rejects a tag longer than TAG_MAX_CHARS', async () => {
    await store.load()
    const long = 'x'.repeat(TAG_MAX_CHARS + 1)
    await expect(
      store.setNodeSummary('/repo', 'a.js', { summary: 'x', tags: [long] })
    ).rejects.toMatchObject({ code: 'tag_too_long' })
  })

  it('rejects non-string tags', async () => {
    await store.load()
    await expect(
      store.setNodeSummary('/repo', 'a.js', { summary: 'x', tags: [42] })
    ).rejects.toMatchObject({ code: 'tag_invalid_type' })
  })

  it('rejects empty repo path', async () => {
    await store.load()
    await expect(
      store.setNodeSummary('', 'a.js', { summary: 'x', tags: [] })
    ).rejects.toMatchObject({ code: 'invalid_repo' })
  })

  it('rejects empty node path', async () => {
    await store.load()
    await expect(
      store.setNodeSummary('/repo', '', { summary: 'x', tags: [] })
    ).rejects.toMatchObject({ code: 'invalid_path' })
  })
})

// ─── Delete API ────────────────────────────────────────────────────────────

describe('KnowledgeStore — deleteNode()', () => {
  it('returns true when deleting an existing node and persists the removal', async () => {
    await store.load()
    await store.setNodeSummary('/repo', 'a.js', { summary: 'x', tags: [] })
    const removed = await store.deleteNode('/repo', 'a.js')
    expect(removed).toBe(true)
    expect(store.getNodeSummary('/repo', 'a.js')).toBeNull()

    const second = new KnowledgeStore({ paths })
    await second.load()
    expect(second.getNodeSummary('/repo', 'a.js')).toBeNull()
  })

  it('returns false for an unknown node (idempotent)', async () => {
    await store.load()
    const removed = await store.deleteNode('/repo', 'never-existed.js')
    expect(removed).toBe(false)
  })
})

// ─── File-level invariants ────────────────────────────────────────────────

describe('KnowledgeStore — file write invariants', () => {
  it('writes an atomically replaced file (no .tmp left behind on success)', async () => {
    await store.load()
    await store.setNodeSummary('/repo', 'a.js', { summary: 'x', tags: [] })
    const entries = await fs.readdir(paths.dir)
    expect(entries).toContain('knowledge.json')
    expect(entries).not.toContain('knowledge.json.tmp')
  })

  it('written file is valid pretty-printed JSON with stable shape', async () => {
    await store.load()
    await store.setNodeSummary('/repo', 'a.js', { summary: 'x', tags: ['t'] })
    const raw = await fs.readFile(paths.file, 'utf8')
    // Pretty-printed → has newlines.
    expect(raw).toMatch(/\n/)
    const parsed = JSON.parse(raw)
    expect(parsed.version).toBe(SCHEMA_VERSION)
    expect(parsed.repos['/repo'].nodes['a.js'].summary).toBe('x')
  })

  it('emptyStore() produces a load()-compatible shape', async () => {
    const empty = emptyStore()
    await fs.mkdir(paths.dir, { recursive: true })
    await fs.writeFile(paths.file, JSON.stringify(empty), 'utf8')
    const s = await store.load()
    expect(s.repos).toEqual({})
  })
})
