/**
 * MCP `summarize_progress` — multi-day window regression.
 *
 * The bug (rc8.2 era):
 *
 *   `summarize_progress` short-circuits with `reason: "no_events_recorded"`
 *   whenever the caller passes a `since` pointing to a past day, even when
 *   `session-YYYY-MM-DD.jsonl` for that day exists on disk. The handler
 *   reads ONLY from today's in-memory buffer (`getEvents()` /
 *   `getEventsForRepo()`) and never awaits `loadDays()` to materialise the
 *   historical cache.
 *
 *   `describe_node` (in the same module) does it right — uses
 *   `loadDays()` + `getEventsForRepoInRange()`. The asymmetry was the
 *   smoking gun.
 *
 * This file ships two scenarios:
 *
 *   - Case A — happy path: seed a JSONL for a fixed past day, ask
 *     `summarize_progress` for that day, expect aggregated events.
 *   - Case B — range > MAX_RANGE_DAYS: ask for a 31-day window, expect a
 *     NO-DATA response with `reason: "range_exceeds_max_days"`. The
 *     30-day cap lives in eventStore and throws RangeError synchronously
 *     from `loadDays()`; the handler must translate that into the
 *     contract's NO-DATA shape rather than letting it surface as a
 *     protocol-level error.
 *
 * Uses a real `EventStore` against a tempDir (so the JSONL seeding +
 * historical load path is exercised end-to-end) and the real
 * `createMcpServer` wired via `InMemoryTransport`.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { createMcpServer } from '../../src/mcp/server.js'
import { EventStore } from '../../src/server/eventStore.js'

// ─── Fixtures ──────────────────────────────────────────────────────────────

/** A fixed past day far enough back that it cannot be "today" on any CI
 *  clock and won't collide with the live tail buffer. */
const PAST_DAY = '2026-05-20'

const REPO_PATH = '/repo/active'

/** Build one synthetic touch event. `path` is the absolute file path the
 *  hook would have written; `pathNorm` is the repo-relative form. */
function ev({ ts, file, tool = 'Edit', agent = 'claude' }) {
  return {
    ts,
    path: `${REPO_PATH}/${file}`,
    pathNorm: file,
    cwd: REPO_PATH,
    tool,
    agent,
  }
}

async function writeDayFile(logDir, ymd, events) {
  const lines = events.map((e) => JSON.stringify(e)).join('\n') + '\n'
  await fs.writeFile(join(logDir, `session-${ymd}.jsonl`), lines, 'utf8')
}

// ─── Fakes ─────────────────────────────────────────────────────────────────

function fakePreferences() {
  return {
    get: () => ({
      currentRepo: REPO_PATH,
      parentDir: '/repo',
      autoSwitch: true,
      iterationWindowMs: 180_000,
      needsSetup: false,
    }),
  }
}

function fakeIterationMarker() {
  return { get: () => null, getIso: () => null }
}

function fakeRepoContext() {
  return {
    repoPath: REPO_PATH,
    treeScanner: {
      countFiles: async () => 0,
      getFileSet: async () => new Set(),
    },
    graphResolver: { getGraph: () => null },
    diffProvider: { getDiff: async () => ({ ok: true, raw: '', html: '' }) },
    // Knowledge graph isn't exercised by summarize_progress; minimal stub.
    knowledgeGraph: {
      getSnapshot: () => ({ nodes: new Map(), cycles: [], orphans: [], builtAt: 0, stats: { nodes: 0, edges: 0, cycles: 0, orphans: 0, withSummary: 0 } }),
      getNode: () => null,
    },
  }
}

function buildDeps(eventStore) {
  return {
    getRepoContext: () => fakeRepoContext(),
    eventStore,
    iterationMarker: fakeIterationMarker(),
    preferences: fakePreferences(),
    repoDetector: () => ({ getRepos: async () => [] }),
    depth: 2,
    appVersion: '1.0.0-test',
    serverInfo: { name: 'blastradius', version: '1.0.0-test' },
    knowledgeStore: {
      getRepoNodes: () => ({}),
      setNodeSummary: async () => ({ summary: '', tags: [], updatedAt: '' }),
    },
  }
}

async function connectClient(deps) {
  const server = createMcpServer(deps)
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  const client = new Client({ name: 'test-client', version: '1.0.0' })
  await client.connect(clientTransport)
  return { client, server }
}

function parsePayload(res) {
  return res.structuredContent ?? JSON.parse(res.content[0].text)
}

// ─── Lifecycle ─────────────────────────────────────────────────────────────

let tempDir
let store

beforeEach(async () => {
  tempDir = await fs.mkdtemp(join(tmpdir(), 'blastradius-summarize-range-'))
  store = new EventStore(tempDir)
})

afterEach(async () => {
  await fs.rm(tempDir, { recursive: true, force: true })
})

// ─── Tests ─────────────────────────────────────────────────────────────────

describe('summarize_progress — multi-day window (rc8.x regression)', () => {
  it('Case A — past-day happy path: seeds a JSONL for 2026-05-20, asks for that day, returns aggregated events', async () => {
    // Seed: 4 events on PAST_DAY across 2 files, mixed tools.
    await writeDayFile(tempDir, PAST_DAY, [
      ev({ ts: `${PAST_DAY}T08:00:00Z`, file: 'src/a.js', tool: 'Edit' }),
      ev({ ts: `${PAST_DAY}T08:01:00Z`, file: 'src/a.js', tool: 'Read' }),
      ev({ ts: `${PAST_DAY}T08:02:00Z`, file: 'src/b.js', tool: 'Write', agent: 'antigravity' }),
      ev({ ts: `${PAST_DAY}T08:03:00Z`, file: 'src/b.js', tool: 'Read' }),
    ])

    const { client } = await connectClient(buildDeps(store))

    const res = await client.callTool({
      name: 'summarize_progress',
      arguments: {
        since: `${PAST_DAY}T00:00:00Z`,
        until: `${PAST_DAY}T23:59:59Z`,
        allRepos: true,
      },
    })
    const payload = parsePayload(res)

    // The load-bearing assertions — these fail under the rc8.2 baseline
    // because the handler returns `reason: "no_events_recorded"` without
    // ever consulting the JSONL on disk.
    expect(payload.reason).toBeNull()
    expect(payload.totals).not.toBeNull()
    expect(payload.totals.edits).toBeGreaterThanOrEqual(1)
    expect(payload.totals.reads).toBeGreaterThanOrEqual(1)
    expect(payload.totals.writes).toBeGreaterThanOrEqual(1)
    expect(Array.isArray(payload.files)).toBe(true)
    expect(payload.files.length).toBeGreaterThanOrEqual(2)
    const paths = payload.files.map((f) => f.path).sort()
    expect(paths).toEqual(['src/a.js', 'src/b.js'])
  })

  it('Case D — events with no `agent` field are attributed to "claude" (rc9.21 alignment)', async () => {
    // Raw events WITHOUT an `agent` field — exactly what the Claude PostToolUse
    // hook writes. summarize_progress must infer "claude" via the shared
    // cascade (not leave agents empty), matching get_iteration_summary. An
    // explicit agent must still be preserved.
    const noAgentDay = '2026-05-19'
    // Real Claude PostToolUse events have a sessionId but NO `agent` field —
    // the inferAgent cascade resolves those to "claude" (branch 4). (An event
    // with neither agent nor sessionId is "manual" — scripted seeding — which
    // is why the sessionId matters here.)
    const raw = (ts, file, tool) => ({ ts, path: `${REPO_PATH}/${file}`, pathNorm: file, cwd: REPO_PATH, tool, sessionId: 'sess-claude-1' })
    await writeDayFile(tempDir, noAgentDay, [
      raw(`${noAgentDay}T09:00:00Z`, 'src/x.js', 'Edit'),
      raw(`${noAgentDay}T09:01:00Z`, 'src/x.js', 'Read'),
      { ts: `${noAgentDay}T09:02:00Z`, path: `${REPO_PATH}/src/y.js`, pathNorm: 'src/y.js', cwd: REPO_PATH, tool: 'Write', agent: 'antigravity' },
    ])
    const { client } = await connectClient(buildDeps(store))
    const res = await client.callTool({
      name: 'summarize_progress',
      arguments: { since: `${noAgentDay}T00:00:00Z`, until: `${noAgentDay}T23:59:59Z`, allRepos: true },
    })
    const payload = parsePayload(res)
    const x = payload.files.find((f) => f.path === 'src/x.js')
    const y = payload.files.find((f) => f.path === 'src/y.js')
    expect(x).toBeTruthy()
    expect(x.agents).toEqual(['claude'])        // inferred (was [] before rc9.21)
    expect(y.agents).toEqual(['antigravity'])   // explicit agent preserved
  })

  it('Case B — range > MAX_RANGE_DAYS: returns NO-DATA reason "range_exceeds_max_days" with maxDays: 30', async () => {
    // No JSONL needed — the cap is enforced before any disk read.
    const { client } = await connectClient(buildDeps(store))

    // 31-day window: 2026-04-01 → 2026-05-02 spans 32 days inclusive,
    // safely over the 30-day cap.
    const res = await client.callTool({
      name: 'summarize_progress',
      arguments: {
        since: '2026-04-01T00:00:00Z',
        until: '2026-05-02T23:59:59Z',
        allRepos: true,
      },
    })
    const payload = parsePayload(res)

    expect(payload.reason).toBe('range_exceeds_max_days')
    expect(payload.totals).toBeNull()
    expect(payload.maxDays).toBe(30)
  })
})
