/**
 * ConversationStore — persists AI chat conversations + a per-project
 * advice counter (rc9.1).
 *
 * Location: a GLOBAL folder, NOT inside the repo —
 *   ~/.blastradius/conversations/<project>/<conversationId>.json
 *   ~/.blastradius/conversations/<project>/_counter.json
 * Keeping it out of the repo avoids polluting the user's git tree, and
 * keeps it consistent with the rest of BlastRadius's local-first state
 * (preferences.json, knowledge.json live under ~/.blastradius too).
 *
 * Security:
 *   - The project name is sanitized to a safe folder segment.
 *   - Conversation ids are UUIDs and validated against a strict pattern
 *     before any path is built, so a crafted id can't traverse out.
 *   - Writes are atomic (tmp + rename) so a crash can't leave a torn
 *     half-written JSON file.
 *
 * No new dependencies — node:fs/promises + node:crypto.
 */

import { homedir } from 'node:os'
import { join } from 'node:path'
import { mkdir, readFile, writeFile, readdir, rename, unlink } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'

const DIR_NAME = '.blastradius'
const SUB = 'conversations'
const MAX_LIST = 50          // most-recent conversations surfaced in the picker
const MAX_MESSAGES = 200     // per-conversation cap (bounds file size)
const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export class ConversationStore {
  /** @param {{ homeDir?: string, logger?: object }} [opts] */
  constructor({ homeDir, logger } = {}) {
    this.base = join(homeDir || homedir(), DIR_NAME, SUB)
    this.logger = logger ?? { debug() {}, info() {}, warn() {} }
  }

  /** Turn a repo/project name into a safe single folder segment. */
  static safeProject(name) {
    const s = String(name || 'default')
      .replace(/[^a-zA-Z0-9._-]/g, '-')
      .replace(/^[-.]+|[-.]+$/g, '')
      .slice(0, 80)
    return s || 'default'
  }

  static isValidId(id) {
    return typeof id === 'string' && ID_RE.test(id)
  }

  #projectDir(project) {
    return join(this.base, ConversationStore.safeProject(project))
  }

  async #ensure(project) {
    const dir = this.#projectDir(project)
    await mkdir(dir, { recursive: true })
    return dir
  }

  async #writeAtomic(path, data) {
    const tmp = `${path}.tmp`
    await writeFile(tmp, data, 'utf8')
    await rename(tmp, path)
  }

  /** Recent conversations (metadata only), newest first. Never throws. */
  async list(project) {
    let names
    try {
      names = await readdir(this.#projectDir(project))
    } catch {
      return [] // no folder yet → no conversations
    }
    const out = []
    for (const name of names) {
      if (!name.endsWith('.json') || name.startsWith('_') || name.endsWith('.tmp')) continue
      try {
        const c = JSON.parse(await readFile(join(this.#projectDir(project), name), 'utf8'))
        out.push({
          id: c.id,
          title: c.title || 'Untitled',
          updatedAt: c.updatedAt || c.createdAt || 0,
          messageCount: Array.isArray(c.messages) ? c.messages.length : 0,
        })
      } catch { /* skip unreadable / partial file */ }
    }
    out.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
    return out.slice(0, MAX_LIST)
  }

  /** Load one conversation, or null (also null on an invalid id). */
  async load(project, id) {
    if (!ConversationStore.isValidId(id)) return null
    try {
      return JSON.parse(await readFile(join(this.#projectDir(project), `${id}.json`), 'utf8'))
    } catch {
      return null
    }
  }

  /**
   * Save the full conversation for a turn. Creates a new conversation
   * (fresh UUID) when `id` is missing/invalid; otherwise overwrites it.
   * `messages` is the authoritative transcript (client history + the new
   * assistant reply). Title is derived from the first user message.
   * Bumps the per-project advice counter. Returns the stored conversation.
   *
   * @param {string} project
   * @param {string|null} id
   * @param {Array<{role:string, content:string}>} messages
   */
  async save(project, id, messages) {
    const dir = await this.#ensure(project)
    const list = Array.isArray(messages) ? messages : []
    const capped = list.slice(-MAX_MESSAGES).map((m) => ({
      role: m.role === 'assistant' ? 'assistant' : 'user',
      content: String(m.content ?? ''),
    }))
    const firstUser = capped.find((m) => m.role === 'user')
    const now = Date.now()
    const existing = ConversationStore.isValidId(id) ? await this.load(project, id) : null
    const conv = {
      id: existing?.id || randomUUID(),
      project: ConversationStore.safeProject(project),
      // Pin the title ONCE at creation: deriving it every save means that
      // after the message cap slices off the first user turn, the title
      // would silently mutate to a mid-thread follow-up. Image-only first
      // turns have empty content → a neutral fallback.
      title: existing?.title || (firstUser?.content ? firstUser.content.slice(0, 60) : 'New conversation'),
      createdAt: existing?.createdAt || now,
      updatedAt: now,
      messages: capped,
    }
    await this.#writeAtomic(join(dir, `${conv.id}.json`), JSON.stringify(conv))
    await this.#bumpCounter(project, dir)
    return conv
  }

  /** Delete a conversation. Returns true if a file was removed. The
   *  advice counter is intentionally left untouched (it's a cumulative
   *  tally of help given, not a live conversation count). */
  async delete(project, id) {
    if (!ConversationStore.isValidId(id)) return false
    try {
      await unlink(join(this.#projectDir(project), `${id}.json`))
      return true
    } catch {
      return false
    }
  }

  /** Per-project advice counter (number of assistant turns). */
  async counter(project) {
    try {
      const c = JSON.parse(await readFile(join(this.#projectDir(project), '_counter.json'), 'utf8'))
      return Number(c.adviceCount) || 0
    } catch {
      return 0
    }
  }

  async #bumpCounter(project, dir) {
    const next = (await this.counter(project)) + 1
    try {
      await this.#writeAtomic(join(dir, '_counter.json'), JSON.stringify({ adviceCount: next, updatedAt: Date.now() }))
    } catch (err) {
      this.logger.warn({ err: String(err?.message ?? err) }, 'advice counter write failed')
    }
    return next
  }
}
