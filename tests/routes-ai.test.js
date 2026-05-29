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
    // Widen the AI-chat token bucket so functional cases that fire several
    // requests back-to-back aren't throttled. The limiter itself is covered
    // by its own describe block below with a deliberately tiny bucket.
    aiChatRateLimitOptions: { maxTokens: 1000, refillTokens: 1000, refillIntervalMs: 1_000 },
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

  it('returns a context usage estimate so the UI can warn (rc9.5)', async () => {
    const res = await fetch(`${base}/api/ai/chat`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'llama3', messages: [{ role: 'user', content: 'hola' }] }),
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(typeof body.usage.estimatedTokens).toBe('number')
    expect(body.usage.estimatedTokens).toBeGreaterThan(0)
    // The fake client exposes no contextLimit → route falls back to default.
    expect(body.usage.contextLimit).toBe(8192)
  })

  it('reflects the AI client context window in usage (rc9.5)', async () => {
    const aiClient2 = {
      listModels: async () => ({ available: true, models: [{ name: 'llama3' }] }),
      chat: async () => ({ role: 'assistant', content: 'ok' }),
      contextLimit: 16384,
    }
    const { server: s2, base: b2 } = await listen(appWith(baseDeps({ aiClient: aiClient2 })))
    try {
      const res = await fetch(`${b2}/api/ai/chat`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'llama3', messages: [{ role: 'user', content: 'hola' }] }),
      })
      expect((await res.json()).usage.contextLimit).toBe(16384)
    } finally { await new Promise((r) => s2.close(r)) }
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

  it('preserves base64 image attachments on the message (rc9.2)', async () => {
    const res = await fetch(`${base}/api/ai/chat`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'llama3', messages: [{ role: 'user', content: '¿color?', images: ['QUJD'] }] }),
    })
    expect(res.status).toBe(200)
    const user = lastChat.messages.find((m) => m.role === 'user')
    expect(user.images).toEqual(['QUJD'])
  })

  it('strips a data: URL prefix off an image (defensive)', async () => {
    const res = await fetch(`${base}/api/ai/chat`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'llama3', messages: [{ role: 'user', content: 'x', images: ['data:image/png;base64,QUJD'] }] }),
    })
    expect(res.status).toBe(200)
    expect(lastChat.messages.find((m) => m.role === 'user').images).toEqual(['QUJD'])
  })

  it('allows an image-only message (no text)', async () => {
    const res = await fetch(`${base}/api/ai/chat`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'llama3', messages: [{ role: 'user', content: '', images: ['QUJD'] }] }),
    })
    expect(res.status).toBe(200)
  })

  it('rejects too many images and non-base64 image data', async () => {
    const many = await fetch(`${base}/api/ai/chat`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'llama3', messages: [{ role: 'user', content: 'x', images: ['QUJD', 'QUJD', 'QUJD', 'QUJD', 'QUJD'] }] }),
    })
    expect(many.status).toBe(400)
    expect((await many.json()).error).toBe('too_many_images')

    const bad = await fetch(`${base}/api/ai/chat`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'llama3', messages: [{ role: 'user', content: 'x', images: ['@@@ not base64 @@@'] }] }),
    })
    expect(bad.status).toBe(400)
    expect((await bad.json()).error).toBe('invalid_image')
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

  it('deletes a conversation (rc9.3): 200, then 404; bad id → 400', async () => {
    // Create one via chat, then delete it.
    const chat = await (await fetch(`${base}/api/ai/chat`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'llama3', messages: [{ role: 'user', content: 'borra esto' }] }),
    })).json()
    const id = chat.conversationId
    expect(typeof id).toBe('string')

    const del = await fetch(`${base}/api/ai/conversations/${id}`, { method: 'DELETE' })
    expect(del.status).toBe(200)
    expect((await del.json()).deleted).toBe(true)

    // Gone now → 404; and an invalid id → 400.
    expect((await fetch(`${base}/api/ai/conversations/${id}`, { method: 'DELETE' })).status).toBe(404)
    expect((await fetch(`${base}/api/ai/conversations/not-a-uuid`, { method: 'DELETE' })).status).toBe(400)
  })
})

describe('POST /api/ai/chat — explain a file diff (rc9.6)', () => {
  it('attaches the file diff to the system message (not the transcript)', async () => {
    let captured = null
    const ctx = {
      repoPath: '/repo/active',
      diffProvider: {
        getDiff: async (p) => ({ patch: `diff --git a/${p} b/${p}\n+added line\n-removed line`, html: '', truncated: false }),
      },
    }
    const deps = baseDeps({
      getRepoContext: () => ctx,
      aiClient: {
        listModels: async () => ({ available: true, models: [{ name: 'llama3' }] }),
        chat: async (req) => { captured = req; return { role: 'assistant', content: 'It renames X to Y because…' } },
      },
    })
    const { server, base } = await listen(appWith(deps))
    try {
      const res = await fetch(`${base}/api/ai/chat`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'llama3', explainPath: 'src/a.js', messages: [{ role: 'user', content: 'Explain what changed in `src/a.js`.' }] }),
      })
      expect(res.status).toBe(200)
      const sys = captured.messages[0]
      expect(sys.role).toBe('system')
      expect(sys.content).toContain('src/a.js')
      expect(sys.content).toContain('+added line') // the diff is in the system context
      expect(sys.content).toMatch(/```diff/)
      // The user turn stays clean — the diff is NOT injected into it.
      const user = captured.messages.find((m) => m.role === 'user')
      expect(user.content).not.toContain('+added line')
    } finally { await new Promise((r) => server.close(r)) }
  })

  it('falls through gracefully when the file has no diff', async () => {
    let captured = null
    const ctx = {
      repoPath: '/repo/active',
      diffProvider: { getDiff: async () => ({ patch: '', html: '', empty: true }) },
    }
    const deps = baseDeps({
      getRepoContext: () => ctx,
      aiClient: {
        listModels: async () => ({ available: true, models: [{ name: 'llama3' }] }),
        chat: async (req) => { captured = req; return { role: 'assistant', content: 'No changes to explain.' } },
      },
    })
    const { server, base } = await listen(appWith(deps))
    try {
      const res = await fetch(`${base}/api/ai/chat`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'llama3', explainPath: 'src/unchanged.js', messages: [{ role: 'user', content: 'Explain.' }] }),
      })
      expect(res.status).toBe(200)
      expect(captured.messages[0].content).toMatch(/no current diff|unchanged or unavailable/i)
    } finally { await new Promise((r) => server.close(r)) }
  })
})

describe('POST /api/ai/chat — rate limiting (rc9.4 H1-sec)', () => {
  it('429s once the token bucket is drained, protecting the local model', async () => {
    const aiClient = {
      listModels: async () => ({ available: true, models: [{ name: 'llama3' }] }),
      chat: async () => ({ role: 'assistant', content: 'ok' }),
    }
    // Tiny bucket: 2 tokens, no practical refill within the test window.
    const deps = baseDeps({ aiClient, aiChatRateLimitOptions: { maxTokens: 2, refillTokens: 1, refillIntervalMs: 60_000 } })
    const { server, base } = await listen(appWith(deps))
    try {
      const fire = () => fetch(`${base}/api/ai/chat`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'llama3', messages: [{ role: 'user', content: 'x' }] }),
      })
      expect((await fire()).status).toBe(200) // token 1
      expect((await fire()).status).toBe(200) // token 2
      const limited = await fire()            // bucket empty → throttled
      expect(limited.status).toBe(429)
      const body = await limited.json()
      expect(body.error).toBeTruthy()
    } finally { await new Promise((r) => server.close(r)) }
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
