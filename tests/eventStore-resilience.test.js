/**
 * EventStore resilience (rc9.15) — agent-immunity + concurrency hardening.
 *
 * The hook cannot be trusted to flush whole lines atomically: an agent may
 * write half a JSON line, the OS may interleave appends, or a crash may leave
 * a truncated tail. The store must NEVER lose, duplicate, or choke on any of
 * this — and it must never call process.exit.
 *
 * Two of these tests are a bug-bites-back RED baseline for the rc9.15 tail()
 * fix: with the old code (which advanced lastSize past an incomplete final
 * line) an event whose line straddles a tail() boundary is silently lost.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { EventStore } from '../src/server/eventStore.js'

const KEY = '2026-05-30'
const NOW = new Date(`${KEY}T10:00:00Z`)

let tempDir
let file

beforeEach(async () => {
  tempDir = await fs.mkdtemp(join(tmpdir(), 'blastradius-resilience-'))
  file = join(tempDir, `session-${KEY}.jsonl`)
})
afterEach(async () => {
  await fs.rm(tempDir, { recursive: true, force: true })
  vi.restoreAllMocks()
})

function evLine(i) {
  return JSON.stringify({
    ts: `${KEY}T10:00:${String(i % 60).padStart(2, '0')}Z`,
    path: `/repo/c${i}.js`,
    pathNorm: `c${i}.js`,
    cwd: '/repo',
    tool: 'Edit',
    seq: i,
  })
}

describe('EventStore — fuzzing (garbage immunity)', () => {
  it('eats arbitrary garbage + malformed JSON without throwing, exiting, or losing valid events', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit was called — forbidden in the server')
    })

    const lines = []
    let validCount = 0
    for (let i = 0; i < 200; i++) {
      switch (i % 5) {
        case 0:
          lines.push(evLine(i)); validCount++; break
        case 1:
          lines.push('{ broken json ' + i); break // unterminated
        case 2:
          lines.push('this is not json at all ' + i); break
        case 3:
          lines.push(''); break // blank line
        default:
          lines.push('42'); break // valid JSON but not an event object → dropped by safeParse
      }
    }
    await fs.writeFile(file, lines.join('\n') + '\n', 'utf8')

    const store = new EventStore(tempDir)
    await expect(store.loadInitial(NOW)).resolves.toBeUndefined()
    expect(store.getEvents()).toHaveLength(validCount)
    // A second garbage append must also be survived cleanly.
    await fs.appendFile(file, '\0\0 garbage \xff not utf8-ish\n{ also broken\n', 'utf8')
    await expect(store.tail(NOW)).resolves.toBeInstanceOf(Array)
    expect(store.getEvents()).toHaveLength(validCount)
    expect(exitSpy).not.toHaveBeenCalled()
  })
})

describe('EventStore — partial-line resilience (bug-bites-back)', () => {
  it('does not lose an event whose line is appended in two parts across a tail()', async () => {
    const store = new EventStore(tempDir)
    await fs.writeFile(file, '', 'utf8')
    await store.loadInitial(NOW) // empty start

    const full = evLine(1) + '\n'
    const half = Math.floor(full.length / 2)

    // First half lands with NO trailing newline — an in-flight write.
    await fs.appendFile(file, full.slice(0, half), 'utf8')
    const firstTail = await store.tail(NOW)
    expect(firstTail).toHaveLength(0) // nothing complete yet — correct

    // The rest of the line completes. With the old code, lastSize had already
    // advanced past the partial bytes, so this read starts mid-line → the
    // event is lost. The fix keeps the partial bytes pending.
    await fs.appendFile(file, full.slice(half), 'utf8')
    const secondTail = await store.tail(NOW)
    expect(secondTail).toHaveLength(1)
    expect(store.getEvents()).toHaveLength(1)
    expect(store.getEvents()[0].seq).toBe(1)
  })
})

describe('EventStore — extreme concurrency (no loss, no duplicates)', () => {
  it('captures 100 events exactly once when they arrive in tiny interleaved chunks', async () => {
    const N = 100
    const store = new EventStore(tempDir)
    await fs.writeFile(file, '', 'utf8')
    await store.loadInitial(NOW)

    const blob = Array.from({ length: N }, (_, i) => evLine(i)).join('\n') + '\n'

    // Write in 7-byte fragments (a prime → boundaries almost never align with
    // a newline) and tail() after each fragment, simulating the watcher racing
    // a stream of small appends.
    const CHUNK = 7
    for (let off = 0; off < blob.length; off += CHUNK) {
      await fs.appendFile(file, blob.slice(off, off + CHUNK), 'utf8')
      await store.tail(NOW)
    }
    await store.tail(NOW) // final flush

    const seqs = store.getEvents().map((e) => e.seq).sort((a, b) => a - b)
    expect(seqs).toEqual(Array.from({ length: N }, (_, i) => i)) // every seq once, none lost/duped
  })
})
