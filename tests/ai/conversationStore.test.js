/**
 * ConversationStore — AI conversation persistence + advice counter (rc9.1).
 *
 * Uses a throwaway homeDir so it never touches the real ~/.blastradius.
 * Verifies: save → load round-trip, stable id on overwrite, list ordering,
 * the per-project counter, project sanitization, and that crafted ids
 * can't traverse out.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ConversationStore } from '../../src/server/ai/conversationStore.js'

let home
let store
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'br-conv-'))
  store = new ConversationStore({ homeDir: home })
})
afterEach(() => {
  if (home) rmSync(home, { recursive: true, force: true })
})

const turn = (u, a) => [{ role: 'user', content: u }, { role: 'assistant', content: a }]

describe('ConversationStore.save / load', () => {
  it('creates a conversation with a UUID id + title from the first user message', async () => {
    const conv = await store.save('BlastRadius', null, turn('¿qué hago primero?', 'Empieza por…'))
    expect(ConversationStore.isValidId(conv.id)).toBe(true)
    expect(conv.title).toBe('¿qué hago primero?')
    expect(conv.messages).toHaveLength(2)

    const loaded = await store.load('BlastRadius', conv.id)
    expect(loaded.id).toBe(conv.id)
    expect(loaded.messages[1].content).toBe('Empieza por…')
  })

  it('keeps the same id (and createdAt) when overwriting an existing conversation', async () => {
    const first = await store.save('proj', null, turn('a', 'b'))
    const second = await store.save('proj', first.id, [...turn('a', 'b'), ...turn('c', 'd')])
    expect(second.id).toBe(first.id)
    expect(second.createdAt).toBe(first.createdAt)
    expect(second.messages).toHaveLength(4)
  })

  it('rejects an invalid / traversal id on load (returns null)', async () => {
    expect(await store.load('proj', '../../../etc/passwd')).toBeNull()
    expect(await store.load('proj', 'not-a-uuid')).toBeNull()
    expect(ConversationStore.isValidId('../x')).toBe(false)
  })
})

describe('ConversationStore.list', () => {
  it('returns metadata newest-first', async () => {
    const a = await store.save('proj', null, turn('first', 'r1'))
    await new Promise((r) => setTimeout(r, 5))
    const b = await store.save('proj', null, turn('second', 'r2'))
    const list = await store.list('proj')
    expect(list.map((c) => c.id)).toEqual([b.id, a.id]) // newest first
    expect(list[0]).toMatchObject({ title: 'second', messageCount: 2 })
  })

  it('is empty for an unknown project', async () => {
    expect(await store.list('never-used')).toEqual([])
  })
})

describe('ConversationStore counter', () => {
  it('increments per saved turn, scoped per project', async () => {
    expect(await store.counter('proj')).toBe(0)
    const c = await store.save('proj', null, turn('a', 'b'))
    expect(await store.counter('proj')).toBe(1)
    await store.save('proj', c.id, [...turn('a', 'b'), ...turn('c', 'd')])
    expect(await store.counter('proj')).toBe(2)
    // Different project keeps its own counter.
    expect(await store.counter('other')).toBe(0)
  })
})

describe('ConversationStore.safeProject', () => {
  it('sanitizes unsafe names to a single folder segment', () => {
    expect(ConversationStore.safeProject('../../etc')).not.toContain('..')
    expect(ConversationStore.safeProject('My Repo/sub')).toBe('My-Repo-sub')
    expect(ConversationStore.safeProject('')).toBe('default')
  })

  it('writes under <home>/.blastradius/conversations/<project>/', async () => {
    await store.save('Demo', null, turn('a', 'b'))
    expect(existsSync(join(home, '.blastradius', 'conversations', 'Demo'))).toBe(true)
  })
})
