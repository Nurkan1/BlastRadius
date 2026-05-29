/**
 * Ollama client — local-only LLM access for the rc9 planning assistant.
 *
 * Why server-side (and not a direct browser fetch):
 *   The dashboard's CSP is `connect-src 'self'`, so the webview CANNOT
 *   fetch http://localhost:11434 directly — the browser blocks it. The
 *   server proxies instead: the webview talks to our own origin, and we
 *   talk to Ollama. This also keeps BlastRadius's local-first / zero-data
 *   identity intact — nothing leaves the machine.
 *
 * The host/port are FIXED to the loopback Ollama default. They are NOT
 * user-controllable, so there is no SSRF surface: a request can only ever
 * reach the local Ollama daemon.
 *
 * No new dependencies — Node 20's global `fetch` + `AbortController`.
 */

// Heuristic: does this model name look like an embedding-only model?
// Embedding models reject /api/chat ("does not support chat"), so we
// demote them in the picker. Conservative — only well-known embedding
// families; a false negative just leaves it un-demoted (harmless).
const EMBEDDING_RE = /(?:^|[-_/])(?:bge|e5|gte|embed|nomic-embed|mxbai|all-minilm|snowflake-arctic-embed|paraphrase)/i
export function looksLikeEmbedding(name) {
  return EMBEDDING_RE.test(String(name || ''))
}

/** Merge a timeout signal with an optional caller signal so EITHER can
 *  abort the fetch. Uses AbortSignal.any when available (Node 20.3+),
 *  with a manual fallback. */
function combineSignals(a, b) {
  if (!b) return a
  if (!a) return b
  if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.any === 'function') {
    return AbortSignal.any([a, b])
  }
  const ac = new AbortController()
  if (a.aborted || b.aborted) { ac.abort(); return ac.signal }
  // When either fires, abort AND detach both listeners so the still-live
  // (long-lived) caller signal doesn't accumulate a leaked listener.
  const onAbort = () => {
    ac.abort()
    a.removeEventListener('abort', onAbort)
    b.removeEventListener('abort', onAbort)
  }
  a.addEventListener('abort', onAbort, { once: true })
  b.addEventListener('abort', onAbort, { once: true })
  return ac.signal
}

const DEFAULT_HOST = '127.0.0.1'
const DEFAULT_PORT = 11434
// Local models can be slow on the first token (cold load); be generous.
const DEFAULT_TIMEOUT_MS = 120_000
// Tags lookup is cheap and the UI waits on it — fail fast so a stopped
// Ollama surfaces as "not running" quickly instead of hanging the panel.
const TAGS_TIMEOUT_MS = 4_000

/**
 * @param {object} [opts]
 * @param {string} [opts.host=127.0.0.1]
 * @param {number} [opts.port=11434]
 * @param {typeof fetch} [opts.fetchImpl] injectable for tests
 * @param {number} [opts.timeoutMs]
 * @param {{ debug?:Function, info?:Function, warn?:Function }} [opts.logger]
 */
export function makeOllamaClient({
  host = DEFAULT_HOST,
  port = DEFAULT_PORT,
  fetchImpl,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  logger,
} = {}) {
  const base = `http://${host}:${port}`
  const doFetch = fetchImpl || globalThis.fetch
  const log = logger ?? { debug() {}, info() {}, warn() {} }

  async function withTimeout(ms, run) {
    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(), ms)
    try {
      return await run(ac.signal)
    } finally {
      clearTimeout(timer)
    }
  }

  /**
   * List installed models. Never throws — a stopped Ollama is a normal
   * state the UI must render ("Ollama not running"), not a 500.
   * @returns {Promise<{ available: boolean, models: Array<{name:string}>, error?: string }>}
   */
  async function listModels() {
    try {
      const res = await withTimeout(TAGS_TIMEOUT_MS, (signal) =>
        doFetch(`${base}/api/tags`, { signal }),
      )
      if (!res.ok) {
        return { available: false, models: [], error: `Ollama responded ${res.status}` }
      }
      const body = await res.json()
      const models = Array.isArray(body?.models)
        ? body.models
            .map((m) => ({ name: String(m?.name ?? ''), size: m?.size }))
            .filter((m) => m.name)
        : []
      // Demote embedding-only models (bge, nomic-embed, mxbai, etc.) to
      // the bottom so the UI's default selection is a chat model — an
      // embedding model returns "does not support chat". Stable sort keeps
      // the original order within each group. We DON'T drop them: the user
      // can still pick one, they just shouldn't be the default.
      models.sort((a, b) => Number(looksLikeEmbedding(a.name)) - Number(looksLikeEmbedding(b.name)))
      return { available: true, models }
    } catch (err) {
      // Connection refused / abort / DNS → Ollama is simply not up.
      return { available: false, models: [], error: 'Ollama is not reachable on 127.0.0.1:11434' }
    }
  }

  /**
   * Run a non-streaming chat completion.
   * @param {{ model: string, messages: Array<{role:string, content:string}>, signal?: AbortSignal }} req
   *   `signal` lets a caller cancel the request (e.g. the user pressed
   *   Stop, or the client disconnected) — we then abort the Ollama call
   *   too so the local model stops generating.
   * @returns {Promise<{ role: string, content: string }>}
   * @throws {OllamaError} on transport / non-2xx / malformed response
   */
  async function chat({ model, messages, signal }) {
    let res
    try {
      res = await withTimeout(timeoutMs, (timeoutSignal) =>
        doFetch(`${base}/api/chat`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ model, messages, stream: false }),
          signal: combineSignals(timeoutSignal, signal),
        }),
      )
    } catch (err) {
      // Don't log message contents (privacy) — only metadata.
      log.warn({ model, count: messages?.length }, 'ollama chat transport error')
      throw new OllamaError(
        'Ollama is not reachable (is it running on 127.0.0.1:11434?).',
        'unreachable',
      )
    }
    if (!res.ok) {
      const detail = await res.text().catch(() => '')
      // 404 → model not pulled. 400 → could be the wrong KIND of model
      // (an embedding model "does not support" chat/vision) OR any other
      // bad request (bad params, context overflow). Only classify it as
      // model_unsupported when the daemon actually says so; otherwise a
      // generic bad_request so we don't mis-blame the model choice.
      const code = res.status === 404
        ? 'model_not_found'
        : res.status === 400
          ? (/does not support|embedding|vision/i.test(detail) ? 'model_unsupported' : 'bad_request')
          : 'bad_status'
      throw new OllamaError(
        `Ollama responded ${res.status}${detail ? `: ${detail.slice(0, 200)}` : ''}`,
        code,
      )
    }
    const body = await res.json().catch(() => null)
    const content = body?.message?.content
    if (typeof content !== 'string') {
      throw new OllamaError('Ollama returned no message content.', 'malformed')
    }
    return { role: body.message.role || 'assistant', content }
  }

  return { listModels, chat, base }
}

/** Transport / protocol error from the Ollama daemon. `code` is stable
 *  for the route to map to an HTTP status + machine-readable error. */
export class OllamaError extends Error {
  constructor(message, code = 'ollama_error') {
    super(message)
    this.name = 'OllamaError'
    this.code = code
  }
}
