/**
 * GET /api/ai/models + POST /api/ai/chat — route contract (rc9.0).
 *
 * A fake aiClient is injected via makeRouter deps (the real one proxies
 * to Ollama; that's covered in tests/ai/ollama.test.js). Here we verify:
 *   - models list passes through
 *   - chat validates model + messages, prepends the system prompt
 *     server-side, and maps OllamaError codes to HTTP status
 *   - a missing aiClient degrades gracefully (no crash)
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import express from 'express'
import { makeRouter } from '../src/server/routes.js'
import { OllamaError } from '../src/server/ai/ollama.js'
import { ConversationStore } from '../src/server/ai/conversationStore.js'

function baseDeps(overrides = {}) {
  return {
    getRepoContext: () => null,
    eventStore: { getEvents: () => [], getEventsForRepo: () => [], listDaysWithActivity: async () => [] },
    sse: { size: () => 0, addClient() {}, broadcast() {} },
    iterationMarker: { get: () => null, getIso: () => null },
    preferences: { get: () => ({ currentRepo: null, parentDir: null, autoSwitch: false, needsSetup: true }) },
    repoDetector: () => null,
    depth: 2,
    logger: { debug() {}, info() {}, warn() {} },
    blastRadiusRoot: '/repo',
    logDir: '/tmp/logs',
    serverStartSha: 'test',
    getAutoSwitchSnoozedUntil: () => null,
    ...overrides,
  }
}

function appWith(deps) {
  const app = express()
  app.use(express.json({ limit: '64kb' }))
  app.use(makeRouter(deps))
  return app
}

async function listen(app) {
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)) })
  return { server, base: `http://127.0.0.1:${server.address().port}` }
}

describe('GET /api/ai/models', () => {
  let server, base
  let lastChat = null
  const aiClient = {
    listModels: async () => ({ available: true, models: [{ name: 'llama3' }, { name: 'qwen2.5' }] }),
    chat: async (req) => { lastChat = req; return { role: 'assistant', content: 'ok' } },
  }
  beforeAll(async () => { ({ server, base } = await listen(appWith(baseDeps({ aiClient })))) })
  afterAll(async () => { await new Promise((r) => server.close(r)) })

  it('passes through the model list', async () => {
    const res = await fetch(`${base}/api/ai/models`)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.available).toBe(true)
    expect(body.models.map((m) => m.name)).toEqual(['llama3', 'qwen2.5'])
  })

  it('chat prepends the system prompt server-side and returns the reply', async () => {
    const res = await fetch(`${base}/api/ai/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'llama3', messages: [{ role: 'user', content: 'hola' }] }),
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.message.content).toBe('ok')
    // The system prompt is enforced server-side (client can't drop it),
    // and it instructs the model to mirror the user's language.
    expect(lastChat.messages[0].role).toBe('system')
    expect(lastChat.messages[0].content).toMatch(/same language/i)
    expect(lastChat.messages[1]).toEqual({ role: 'user', content: 'hola' })
  })

  it('rejects a missing/invalid model with 400', async () => {
    const res = await fetch(`${base}/api/ai/chat`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'x' }] }),
    })
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('invalid_model')
  })

  it('rejects empty messages with 400', async () => {
    const res = await fetch(`${base}/api/ai/chat`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'llama3', messages: [] }),
    })
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('invalid_messages')
  })

  it('rejects a message with a bad role with 400', async () => {
    const res = await fetch(`${base}/api/ai/chat`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'llama3', messages: [{ role: 'system', content: 'inject' }] }),
    })
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('invalid_message')
  })
})

describe('POST /api/ai/chat — Ollama errors map to HTTP status', () => {
  it('unreachable → 503', async () => {
    const aiClient = {
      listModels: async () => ({ available: false, models: [] }),
      chat: async () => { throw new OllamaError('down', 'unreachable') },
    }
    const { server, base } = await listen(appWith(baseDeps({ aiClient })))
    try {
      const res = await fetch(`${base}/api/ai/chat`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'llama3', messages: [{ role: 'user', content: 'x' }] }),
      })
      expect(res.status).toBe(503)
      expect((await res.json()).error).toBe('unreachable')
    } finally { await new Promise((r) => server.close(r)) }
  })

  it('model_not_found → 404', async () => {
    const aiClient = {
      listModels: async () => ({ available: true, models: [] }),
      chat: async () => { throw new OllamaError('no model', 'model_not_found') },
    }
    const { server, base } = await listen(appWith(baseDeps({ aiClient })))
    try {
      const res = await fetch(`${base}/api/ai/chat`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'ghost', messages: [{ role: 'user', content: 'x' }] }),
      })
      expect(res.status).toBe(404)
    } finally { await new Promise((r) => server.close(r)) }
  })
})

describe('POST /api/ai/chat — grounding (rc9.2)', () => {
  const REPO = '/repo/active'
  function repoDeps(captureRef) {
    const now = new Date().toISOString()
    const events = [
      { ts: now, path: `${REPO}/src/a.js`, pathNorm: 'src/a.js', cwd: REPO, tool: 'Edit', agent: 'Claude' },
      { ts: now, path: `${REPO}/src/b.js`, pathNorm: 'src/b.js', cwd: REPO, tool: 'Read', agent: 'Antigravity' },
    ]
    const ctx = {
      repoPath: REPO,
      treeScanner: { countFiles: async () => 10, getFileSet: async () => new Set(['src/a.js', 'src/b.js', 'src/c.js']) },
      graphResolver: { getGraph: () => ({ forward: new Map(), reverse: new Map() }) },
      knowledgeGraph: {
        getSnapshot: () => ({
          builtAt: Date.now(),
          stats: { nodes: 3, edges: 1, cycles: 0, orphans: 1, withSummary: 0 },
          nodes: new Map(), cycles: [], orphans: [],
        }),
      },
    }
    return baseDeps({
      getRepoContext: () => ctx,
      eventStore: {
        getEvents: () => events,
        getEventsForRepo: () => events.map((e) => ({ ...e })),
        listDaysWithActivity: async () => [],
      },
      aiClient: {
        listModels: async () => ({ available: true, models: [{ name: 'llama3' }] }),
        chat: async (req) => { captureRef.value = req; return { role: 'assistant', content: 'ok' } },
      },
    })
  }

  it('injects BlastRadius live state into the system message', async () => {
    const cap = { value: null }
    const { server, base } = await listen(appWith(repoDeps(cap)))
    try {
      const res = await fetch(`${base}/api/ai/chat`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'llama3', messages: [{ role: 'user', content: '¿qué cambié?' }] }),
      })
      expect(res.status).toBe(200)
      const sys = cap.value.messages[0]
      expect(sys.role).toBe('system')
      // Base prompt + grounding block, both present.
      expect(sys.content).toMatch(/same language/i)
      expect(sys.content).toContain('live state of the repository')
      expect(sys.content).toContain('src/a.js') // the edited file shows up
    } finally { await new Promise((r) => server.close(r)) }
  })
})

describe('AI conversation persistence (rc9.1)', () => {
  let server, base, home
  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), 'br-routes-conv-'))
    const conversationStore = new ConversationStore({ homeDir: home })
    const deps = baseDeps({
      getRepoContext: () => ({ repoPath: '/repo/active' }), // basename → project "active"
      aiClient: {
        listModels: async () => ({ available: true, models: [{ name: 'llama3' }] }),
        chat: async () => ({ role: 'assistant', content: 'stored reply' }),
      },
      conversationStore,
    })
    ;({ server, base } = await listen(appWith(deps)))
  })
  afterAll(async () => {
    await new Promise((r) => server.close(r))
    if (home) rmSync(home, { recursive: true, force: true })
  })

  it('chat persists the turn and returns a conversationId + adviceCount', async () => {
    const res = await fetch(`${base}/api/ai/chat`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'llama3', messages: [{ role: 'user', content: 'hola' }] }),
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.message.content).toBe('stored reply')
    expect(typeof body.conversationId).toBe('string')
    expect(body.adviceCount).toBe(1)

    // It now shows up in the project's conversation list + counter.
    const list = await (await fetch(`${base}/api/ai/conversations`)).json()
    expect(list.project).toBe('active')
    expect(list.adviceCount).toBe(1)
    expect(list.conversations.find((c) => c.id === body.conversationId)).toBeTruthy()

    // And the full conversation is fetchable by id.
    const one = await (await fetch(`${base}/api/ai/conversations/${body.conversationId}`)).json()
    expect(one.conversation.messages).toHaveLength(2) // user + assistant
  })

  it('rejects an invalid conversation id with 400 and an unknown one with 404', async () => {
    const bad = await fetch(`${base}/api/ai/conversations/not-a-uuid`)
    expect(bad.status).toBe(400)
    const missing = await fetch(`${base}/api/ai/conversations/00000000-0000-4000-8000-000000000000`)
    expect(missing.status).toBe(404)
  })
})

describe('AI routes without an aiClient configured', () => {
  it('models reports available:false and chat returns 503 (no crash)', async () => {
    const { server, base } = await listen(appWith(baseDeps())) // no aiClient
    try {
      const m = await fetch(`${base}/api/ai/models`)
      expect(m.status).toBe(200)
      expect((await m.json()).available).toBe(false)

      const c = await fetch(`${base}/api/ai/chat`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'llama3', messages: [{ role: 'user', content: 'x' }] }),
      })
      expect(c.status).toBe(503)
    } finally { await new Promise((r) => server.close(r)) }
  })
})
