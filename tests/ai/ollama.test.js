/**
 * makeOllamaClient — local Ollama proxy client (rc9.0).
 *
 * No network: a fake `fetchImpl` is injected so these are pure unit
 * tests. We cover the contract the routes rely on:
 *   - listModels never throws (a stopped Ollama is `available:false`)
 *   - chat returns the assistant message on 2xx
 *   - chat throws OllamaError with a STABLE `code` for each failure mode
 *     (the route maps code → HTTP status)
 */

import { describe, it, expect } from 'vitest'
import { makeOllamaClient, OllamaError, looksLikeEmbedding } from '../../src/server/ai/ollama.js'

function okJson(body) {
  return { ok: true, status: 200, json: async () => body, text: async () => '' }
}
function errStatus(status, text = '') {
  return { ok: false, status, json: async () => ({}), text: async () => text }
}

describe('makeOllamaClient.listModels', () => {
  it('returns available + models on success, filtering empty names', async () => {
    const client = makeOllamaClient({
      fetchImpl: async () => okJson({ models: [{ name: 'llama3' }, { name: '' }, { name: 'qwen2.5' }] }),
    })
    const out = await client.listModels()
    expect(out.available).toBe(true)
    expect(out.models.map((m) => m.name)).toEqual(['llama3', 'qwen2.5'])
  })

  it('reports available:false (never throws) when Ollama is down', async () => {
    const client = makeOllamaClient({
      fetchImpl: async () => { throw new Error('ECONNREFUSED') },
    })
    const out = await client.listModels()
    expect(out.available).toBe(false)
    expect(out.models).toEqual([])
    expect(out.error).toMatch(/not reachable/i)
  })

  it('reports available:false on a non-2xx tags response', async () => {
    const client = makeOllamaClient({ fetchImpl: async () => errStatus(500) })
    const out = await client.listModels()
    expect(out.available).toBe(false)
    expect(out.error).toMatch(/500/)
  })

  it('demotes embedding-only models below chat models', async () => {
    const client = makeOllamaClient({
      fetchImpl: async () => okJson({ models: [{ name: 'bge-m3:latest' }, { name: 'gemma3:4b' }, { name: 'nomic-embed-text' }] }),
    })
    const out = await client.listModels()
    // Chat model first; embedding models pushed to the bottom.
    expect(out.models[0].name).toBe('gemma3:4b')
    expect(out.models.map((m) => m.name).slice(1).sort()).toEqual(['bge-m3:latest', 'nomic-embed-text'])
  })
})

describe('looksLikeEmbedding', () => {
  it('flags known embedding families, not chat models', () => {
    expect(looksLikeEmbedding('bge-m3:latest')).toBe(true)
    expect(looksLikeEmbedding('nomic-embed-text')).toBe(true)
    expect(looksLikeEmbedding('mxbai-embed-large')).toBe(true)
    expect(looksLikeEmbedding('gemma3:4b')).toBe(false)
    expect(looksLikeEmbedding('llama3.1:8b')).toBe(false)
    expect(looksLikeEmbedding('qwen2.5-coder')).toBe(false)
  })
})

describe('makeOllamaClient.chat', () => {
  it('returns the assistant message and sends stream:false', async () => {
    let sent = null
    const client = makeOllamaClient({
      fetchImpl: async (url, init) => {
        sent = { url, body: JSON.parse(init.body) }
        return okJson({ message: { role: 'assistant', content: 'hello' } })
      },
    })
    const reply = await client.chat({ model: 'llama3', messages: [{ role: 'user', content: 'hi' }] })
    expect(reply).toEqual({ role: 'assistant', content: 'hello' })
    expect(sent.url).toMatch(/\/api\/chat$/)
    expect(sent.body.stream).toBe(false)
    expect(sent.body.model).toBe('llama3')
  })

  it('forwards per-message images to Ollama (vision attachments)', async () => {
    let sent = null
    const client = makeOllamaClient({
      fetchImpl: async (url, init) => {
        sent = JSON.parse(init.body)
        return okJson({ message: { role: 'assistant', content: 'a red square' } })
      },
    })
    await client.chat({ model: 'gemma3', messages: [{ role: 'user', content: 'color?', images: ['QUJD'] }] })
    expect(sent.messages[0].images).toEqual(['QUJD'])
  })

  it('throws OllamaError(unreachable) on a transport error', async () => {
    const client = makeOllamaClient({ fetchImpl: async () => { throw new Error('ECONNREFUSED') } })
    await expect(client.chat({ model: 'm', messages: [{ role: 'user', content: 'x' }] }))
      .rejects.toMatchObject({ name: 'OllamaError', code: 'unreachable' })
  })

  it('throws OllamaError(model_not_found) on 404', async () => {
    const client = makeOllamaClient({ fetchImpl: async () => errStatus(404, 'model not found') })
    await expect(client.chat({ model: 'ghost', messages: [{ role: 'user', content: 'x' }] }))
      .rejects.toMatchObject({ code: 'model_not_found' })
  })

  it('throws OllamaError(model_unsupported) on 400 (e.g. embedding model)', async () => {
    const client = makeOllamaClient({
      fetchImpl: async () => errStatus(400, '{"error":"\\"bge-m3:latest\\" does not support chat"}'),
    })
    await expect(client.chat({ model: 'bge-m3:latest', messages: [{ role: 'user', content: 'x' }] }))
      .rejects.toMatchObject({ code: 'model_unsupported' })
  })

  it('throws OllamaError(bad_status) on other non-2xx', async () => {
    const client = makeOllamaClient({ fetchImpl: async () => errStatus(500) })
    await expect(client.chat({ model: 'm', messages: [{ role: 'user', content: 'x' }] }))
      .rejects.toMatchObject({ code: 'bad_status' })
  })

  it('throws OllamaError(malformed) when the body has no message content', async () => {
    const client = makeOllamaClient({ fetchImpl: async () => okJson({ message: {} }) })
    await expect(client.chat({ model: 'm', messages: [{ role: 'user', content: 'x' }] }))
      .rejects.toMatchObject({ code: 'malformed' })
  })

  it('OllamaError is the exported class', () => {
    expect(new OllamaError('x', 'unreachable')).toBeInstanceOf(Error)
  })
})
