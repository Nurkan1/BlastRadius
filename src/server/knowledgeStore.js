/**
 * Knowledge Graph — semantic-layer persistence (rc8+).
 *
 * Single JSON file at `~/.blastradius/knowledge.json` that survives
 * server restarts and holds agent-provided summaries + tags per
 * source file, scoped by absolute repo path.
 *
 * Source of truth model
 * ─────────────────────
 *   - At boot we load() once into memory.
 *   - setNodeSummary() atomically replaces the file (write to .tmp,
 *     then rename) and updates the in-memory copy. No re-read at
 *     runtime — single owner of the file is this process.
 *   - If the file is missing, corrupted, or unreadable, load()
 *     returns an empty store. A corrupted file is renamed to
 *     `.bak.corrupted-<TIMESTAMP>` so the user has a recovery
 *     breadcrumb without us losing the ability to write fresh data.
 *
 * Schema
 * ──────
 *   {
 *     version: 1,
 *     repos: {
 *       "<absolute repo path, forward-slashed>": {
 *         nodes: {
 *           "<repo-relative pathNorm>": {
 *             summary:   string,     // ≤ SUMMARY_MAX_CHARS
 *             tags:      string[],   // ≤ TAGS_MAX × TAG_MAX_CHARS
 *             updatedAt: ISO string
 *           }
 *         }
 *       }
 *     },
 *     createdAt: ISO string,
 *     updatedAt: ISO string
 *   }
 *
 * Caps and rationale
 * ──────────────────
 *   - SUMMARY_MAX_CHARS = 2000      — generous for a paragraph, bounds DoS via overlong writes
 *   - TAGS_MAX = 20                 — keeps the per-node payload small
 *   - TAG_MAX_CHARS = 32            — single word / short kebab phrase
 *   - NODES_PER_REPO_CAP = 5000     — file size budget < 5 MB even at full caps
 *
 * Cross-platform notes
 * ────────────────────
 *   - Mirrors preferences.js: chmod 0600 on POSIX, no-op on Windows.
 *   - All keys are forward-slashed so the file survives copy between OS.
 */

import { homedir } from 'node:os'
import { join } from 'node:path'
import { promises as fs } from 'node:fs'

export const SCHEMA_VERSION = 1
export const SUMMARY_MAX_CHARS = 2000
export const TAGS_MAX = 20
export const TAG_MAX_CHARS = 32
export const NODES_PER_REPO_CAP = 5000

/** Resolve the file paths used by the store. Exposed so tests can
 *  redirect to a sandbox directory without touching the real one. */
export function getDefaultPaths(home = homedir()) {
  const dir = join(home, '.blastradius')
  const file = join(dir, 'knowledge.json')
  return {
    dir,
    file,
    tmp: file + '.tmp',
    corruptedBackup: (ts) => `${file}.bak.corrupted-${ts}`,
  }
}

/** Build a brand-new empty store with the current schema version. */
export function emptyStore() {
  const now = new Date().toISOString()
  return {
    version: SCHEMA_VERSION,
    repos: {},
    createdAt: now,
    updatedAt: now,
  }
}

/** Stable forward-slash normalization for repo paths. */
function normRepoPath(p) {
  if (typeof p !== 'string' || !p) return ''
  return p.replace(/\\/g, '/').replace(/\/+$/, '')
}

/** Stable forward-slash normalization for node paths (repo-relative). */
function normNodePath(p) {
  if (typeof p !== 'string' || !p) return ''
  return p.replace(/\\/g, '/').replace(/^\.\//, '').trim()
}

/** Filename-safe local timestamp for corruption backups. */
function tsForFilename() {
  return new Date().toISOString().replace(/[:.]/g, '-').replace('Z', '')
}

/**
 * KnowledgeStore — owns the on-disk persistence + the in-memory
 * mirror. The KnowledgeGraph engine queries this through a thin
 * read API and writes through validated set/delete calls.
 */
export class KnowledgeStore {
  /**
   * @param {{
   *   paths?: ReturnType<typeof getDefaultPaths>,
   *   homeDir?: string,  // rc8.1+: same override knob as PreferencesStore
   *   logger?: object,
   * }} opts
   */
  constructor(opts = {}) {
    this.paths = opts.paths ?? getDefaultPaths(opts.homeDir)
    this.logger = opts.logger ?? { debug() {}, info() {}, warn() {}, error() {} }
    /** Current in-memory snapshot. Always a valid store shape. */
    this._store = emptyStore()
    this._loaded = false
  }

  /** Load the file into memory. Idempotent — re-calling is a no-op. */
  async load() {
    if (this._loaded) return this._store
    let raw
    try {
      raw = await fs.readFile(this.paths.file, 'utf8')
    } catch (err) {
      if (err.code !== 'ENOENT') {
        this.logger.warn(
          { err: String(err?.message ?? err), file: this.paths.file },
          'knowledge.json unreadable; starting with empty store',
        )
      }
      this._loaded = true
      return this._store
    }
    let parsed
    try {
      parsed = JSON.parse(raw)
    } catch (err) {
      // Quarantine the corrupted file with a timestamp so the user
      // can inspect it later without us refusing to write fresh data.
      try {
        await fs.rename(this.paths.file, this.paths.corruptedBackup(tsForFilename()))
        this.logger.warn(
          { err: String(err?.message ?? err) },
          'knowledge.json was corrupted; quarantined to .bak.corrupted-<TS> and starting fresh',
        )
      } catch (renameErr) {
        this.logger.error(
          { err: String(renameErr?.message ?? renameErr) },
          'knowledge.json corrupted AND could not be quarantined; will overwrite on next write',
        )
      }
      this._loaded = true
      return this._store
    }
    // Shape validation — if anything looks off, fall back to empty
    // (the corrupted-but-parseable case is rarer than outright
    // syntax errors; we treat it the same way: warn + ignore).
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      typeof parsed.version !== 'number' ||
      typeof parsed.repos !== 'object'
    ) {
      this.logger.warn(
        { file: this.paths.file },
        'knowledge.json has unexpected shape; starting with empty store',
      )
      this._loaded = true
      return this._store
    }
    if (parsed.version !== SCHEMA_VERSION) {
      // Future-proofing: if we ever bump the schema, this branch
      // is where the migration goes. For now we accept v1 only.
      this.logger.warn(
        { found: parsed.version, expected: SCHEMA_VERSION },
        'knowledge.json schema version mismatch; starting with empty store',
      )
      this._loaded = true
      return this._store
    }
    this._store = parsed
    this._loaded = true
    return this._store
  }

  /** Get the array of nodes (with their persisted metadata) for a
   *  given repo. Returns [] when nothing has been written for that
   *  repo yet. Read-only — callers must not mutate the returned shape. */
  getRepoNodes(repoPath) {
    const key = normRepoPath(repoPath)
    return this._store.repos[key]?.nodes ?? {}
  }

  /** Look up the persisted entry for a single node. Returns null if
   *  the node has no summary recorded. */
  getNodeSummary(repoPath, pathNorm) {
    const repo = this._store.repos[normRepoPath(repoPath)]
    if (!repo) return null
    return repo.nodes?.[normNodePath(pathNorm)] ?? null
  }

  /**
   * Validate + persist a new node summary. Returns the entry that
   * was written, or throws a typed error with a `code` field that
   * the MCP / API surface uses verbatim as the NO-DATA `reason`.
   *
   * Errors raised here are part of the public contract:
   *   - 'summary_too_long'     summary > SUMMARY_MAX_CHARS
   *   - 'too_many_tags'        tags.length > TAGS_MAX
   *   - 'tag_too_long'         any tag > TAG_MAX_CHARS
   *   - 'tag_invalid_type'     a tag isn't a string
   *   - 'invalid_path'         pathNorm is empty after normalization
   *   - 'invalid_repo'         repoPath is empty after normalization
   *   - 'repo_node_cap_reached' would exceed NODES_PER_REPO_CAP
   */
  async setNodeSummary(repoPath, pathNorm, { summary = '', tags = [] } = {}) {
    const repoKey = normRepoPath(repoPath)
    if (!repoKey) throw withCode('invalid_repo', 'repoPath is required')

    const nodeKey = normNodePath(pathNorm)
    if (!nodeKey) throw withCode('invalid_path', 'pathNorm is required')

    if (typeof summary !== 'string') {
      throw withCode('summary_too_long', 'summary must be a string')
    }
    if (summary.length > SUMMARY_MAX_CHARS) {
      throw withCode('summary_too_long', `summary is ${summary.length} chars; cap is ${SUMMARY_MAX_CHARS}`)
    }

    if (!Array.isArray(tags)) throw withCode('too_many_tags', 'tags must be an array')
    if (tags.length > TAGS_MAX) {
      throw withCode('too_many_tags', `${tags.length} tags; cap is ${TAGS_MAX}`)
    }
    const cleanedTags = []
    for (const tag of tags) {
      if (typeof tag !== 'string') throw withCode('tag_invalid_type', 'every tag must be a string')
      if (tag.length > TAG_MAX_CHARS) {
        throw withCode('tag_too_long', `tag "${tag.slice(0, 16)}…" is ${tag.length} chars; cap is ${TAG_MAX_CHARS}`)
      }
      // Strip control characters — defense against accidental binary
      // pasted into a summary editor, and against terminal-escape
      // injection in any future CLI rendering of these values.
      const cleaned = tag.replace(/[\x00-\x1f\x7f]/g, '').trim()
      if (cleaned) cleanedTags.push(cleaned)
    }
    const cleanedSummary = summary.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '')

    let repo = this._store.repos[repoKey]
    if (!repo) {
      repo = { nodes: {} }
      this._store.repos[repoKey] = repo
    }
    // Cap check: only enforce on NEW node insertions. Updating an
    // existing summary never trips the cap.
    if (!repo.nodes[nodeKey] && Object.keys(repo.nodes).length >= NODES_PER_REPO_CAP) {
      throw withCode(
        'repo_node_cap_reached',
        `repo already has ${Object.keys(repo.nodes).length} stored summaries; cap is ${NODES_PER_REPO_CAP}`,
      )
    }
    const entry = {
      summary: cleanedSummary,
      tags: cleanedTags,
      updatedAt: new Date().toISOString(),
    }
    repo.nodes[nodeKey] = entry
    this._store.updatedAt = entry.updatedAt
    await this._flush()
    return entry
  }

  /** Delete a single node's stored metadata. Idempotent. */
  async deleteNode(repoPath, pathNorm) {
    const repoKey = normRepoPath(repoPath)
    const nodeKey = normNodePath(pathNorm)
    const repo = this._store.repos[repoKey]
    if (!repo || !repo.nodes?.[nodeKey]) return false
    delete repo.nodes[nodeKey]
    this._store.updatedAt = new Date().toISOString()
    await this._flush()
    return true
  }

  /** Test-only reset hook. Clears in-memory state and forgets the
   *  "loaded" flag so the next load() rebuilds from disk. */
  _resetForTests() {
    this._store = emptyStore()
    this._loaded = false
  }

  /** Atomic write: serialize, write to tmp, fsync-ish rename. */
  async _flush() {
    await fs.mkdir(this.paths.dir, { recursive: true })
    if (process.platform !== 'win32') {
      try { await fs.chmod(this.paths.dir, 0o700) } catch { /* best effort */ }
    }
    const json = JSON.stringify(this._store, null, 2)
    await fs.writeFile(this.paths.tmp, json, { encoding: 'utf8', flag: 'w' })
    if (process.platform !== 'win32') {
      try { await fs.chmod(this.paths.tmp, 0o600) } catch { /* best effort */ }
    }
    await fs.rename(this.paths.tmp, this.paths.file)
  }
}

/** Build a typed Error with a `code` field that downstream surfaces
 *  use as the canonical NO-DATA `reason`. */
function withCode(code, message) {
  const err = new Error(message)
  err.code = code
  return err
}
