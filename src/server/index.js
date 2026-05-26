#!/usr/bin/env node
/**
 * BlastRadius dashboard server (Phase 5: multi-repo aware).
 *
 *   - HTTP/JSON API for the SPA: /api/tree, /api/heat, /api/events,
 *     /api/diff, /api/iteration*, /api/repos*, /api/preferences
 *   - Static frontend served from src/public
 *   - SSE broadcasts heat/tree/iteration/repo updates in real time
 *
 * Strictly read-only on every target repo. The server walks the tree,
 * reads the JSONL log, and pushes derived state to connected clients.
 * It never opens a write handle on any observed repo. The ONLY thing
 * it ever writes to disk is `~/.blastradius/preferences.json`.
 *
 * Boot order (Phase 5)
 * ────────────────────
 *   1. Load preferences. If missing, try to migrate from the legacy
 *      BLASTRADIUS_TARGET_REPO env var (deprecation warning), or
 *      bootstrap from BLASTRADIUS_PARENT_DIR. If neither, the server
 *      starts in WIZARD MODE: it answers /api/preferences with
 *      `needsSetup:true` and otherwise responds 503 for repo-bound
 *      endpoints. The frontend renders the first-run modal.
 *   2. Construct singletons: eventStore, SSE broadcaster, repoDetector,
 *      iterationMarker, watcher.
 *   3. If a currentRepo is set, lazily create its RepoContext and
 *      point the watcher at it.
 *   4. Mount router + static, start listening.
 *   5. Wire SIGINT/SIGTERM to a graceful shutdown.
 */

import express from 'express'
import { dirname, resolve } from 'node:path'
import { existsSync, statSync, mkdirSync, writeFileSync, unlinkSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import pino from 'pino'
import 'dotenv/config'

import { TreeScanner } from './treeScanner.js'
import { EventStore } from './eventStore.js'
import { Watcher } from './watcher.js'
import { SSEBroadcaster } from './sse.js'
import { GraphResolver } from './graphResolver.js'
import { DiffProvider } from './diffProvider.js'
import { IterationMarker } from './iterationMarker.js'
import { RepoDetector, computeActiveRepo, normalizePath as normRepo } from './repoDetector.js'
import { PreferencesStore } from './preferences.js'
import { readHeadSha } from './gitSha.js'
import { securityHeaders } from './security.js'
import { makeRouter } from './routes.js'
import { makeMcpRouter } from '../mcp/transport-http.js'
import { onStatsUpdate as onMcpStatsUpdate } from '../mcp/stats.js'
import { KnowledgeStore } from './knowledgeStore.js'
import { KnowledgeGraph } from './knowledgeGraph.js'

const logger = pino({
  level: process.env.BLASTRADIUS_LOG_LEVEL || 'info',
  base: { name: 'blastradius' },
})

// ─── Env wiring ─────────────────────────────────────────────────────────────

const PORT = Number(process.env.BLASTRADIUS_PORT) || 7842
/**
 * HTTP bind host. Defaults to 127.0.0.1 so the dashboard is reachable
 * only from the same machine — matches the "local-only" threat model
 * documented in SECURITY.md.
 *
 * History: rc5 and earlier called `app.listen(PORT, …)` without a host
 * argument. Node's default for a missing host is the dual-stack
 * unspecified address `::` (i.e. EVERY interface, IPv4 and IPv6). On a
 * shared LAN (office, café, coworking, WSL2 with bridged networking)
 * that exposed `/api/diff`, `/api/tree`, `/api/repos`, and `/mcp` to
 * any device that could reach the host. SECURITY.md, which is read by
 * every public-repo visitor, asserted the opposite — so the bug was
 * also a documentation contradiction. Caught by a pre-public OWASP
 * audit; fixed here.
 *
 * Power users who deliberately want the previous behaviour (e.g. to
 * run the dashboard inside a VM and hit it from the host) can set
 * `BLASTRADIUS_HOST=0.0.0.0`. They are then responsible for whatever
 * comes through that bind — auth, firewall, reverse proxy.
 */
const HOST = process.env.BLASTRADIUS_HOST || '127.0.0.1'
const LOG_DIR = process.env.BLASTRADIUS_LOG_DIR
const PROP_DEPTH = (() => {
  const raw = Number(process.env.BLASTRADIUS_DEPTH)
  if (!Number.isInteger(raw)) return 2
  return Math.min(3, Math.max(1, raw))
})()

if (!LOG_DIR) {
  logger.error('BLASTRADIUS_LOG_DIR is required (where the hook writes daily JSONL logs)')
  process.exit(1)
}

const __dirname = dirname(fileURLToPath(import.meta.url))
const PUBLIC_DIR = resolve(__dirname, '..', 'public')
/** Repo root of this BlastRadius checkout. Used to read the commit SHA
 *  the server started on, so /api/health can warn the frontend when it
 *  is running stale code relative to the on-disk HEAD. */
const BLASTRADIUS_ROOT = resolve(__dirname, '..', '..')
const SERVER_START_SHA = readHeadSha(BLASTRADIUS_ROOT)
/** App version read once at boot — surfaced via the MCP server's
 *  initialize handshake and the `blastradius://health` resource. */
const APP_VERSION = (() => {
  try {
    const pkg = JSON.parse(readFileSync(resolve(BLASTRADIUS_ROOT, 'package.json'), 'utf8'))
    return String(pkg.version || '0.0.0')
  } catch {
    return '0.0.0'
  }
})()

// ─── Preferences + legacy env migration ─────────────────────────────────────
//
// rc8.1+: BLASTRADIUS_HOME_DIR lets E2E / integration tests pin the
// preferences + knowledge stores to a sandbox directory instead of
// the real ~/.blastradius/. Production never sets this. Production
// reads default homedir() (the existing behavior). No-op when unset.
const HOME_DIR_OVERRIDE = process.env.BLASTRADIUS_HOME_DIR || undefined

const preferences = new PreferencesStore({ logger, homeDir: HOME_DIR_OVERRIDE })
await preferences.load()

// Migration: only runs when no preferences file exists yet (load returns
// `needsSetup: true` AND no parentDir). We never overwrite an existing
// prefs file from env vars — the file is the source of truth once
// it's been created.
if (preferences.needsSetup()) {
  const legacyTarget = process.env.BLASTRADIUS_TARGET_REPO
  const parentEnv = process.env.BLASTRADIUS_PARENT_DIR
  if (parentEnv && existsSync(parentEnv) && statSync(parentEnv).isDirectory()) {
    await preferences.save({ parentDir: parentEnv, autoSwitch: true, currentRepo: null })
    logger.info({ parentDir: parentEnv }, 'bootstrapped preferences from BLASTRADIUS_PARENT_DIR')
  } else if (legacyTarget && existsSync(legacyTarget) && statSync(legacyTarget).isDirectory()) {
    const derivedParent = dirname(resolve(legacyTarget))
    await preferences.save({
      parentDir: derivedParent,
      autoSwitch: false, // user explicitly picked that one repo; don't surprise them
      currentRepo: legacyTarget,
    })
    logger.warn(
      { legacy: legacyTarget, derivedParentDir: derivedParent },
      'BLASTRADIUS_TARGET_REPO is deprecated; migrated to preferences. ' +
      'Rename to BLASTRADIUS_PARENT_DIR in your .env to silence this.',
    )
  } else {
    logger.warn('no preferences and no env hints — starting in wizard mode (open the dashboard to configure)')
  }
}

// ─── Core singletons ────────────────────────────────────────────────────────

const eventStore = new EventStore(LOG_DIR)
const sse = new SSEBroadcaster()
const iterationMarker = new IterationMarker()

// Multi-repo singleton: the knowledge store is a single
// ~/.blastradius/knowledge.json keyed by absolute repo path. Loaded
// once at boot; each RepoContext gets the SAME instance.
const knowledgeStore = new KnowledgeStore({ logger, homeDir: HOME_DIR_OVERRIDE })
await knowledgeStore.load().catch((err) => {
  logger.warn({ err: String(err) }, 'knowledge store load failed; starting with empty store')
})

await eventStore.loadInitial().catch((err) => {
  logger.warn({ err: String(err) }, 'initial event load failed; starting with empty store')
})
logger.info({ initialEvents: eventStore.getEvents().length }, 'event store initialized')

// ─── Per-repo contexts ──────────────────────────────────────────────────────
//
// Lazy creation. Each repo we ever activate gets a RepoContext that owns
// its own TreeScanner / GraphResolver / DiffProvider. Memory grows ~50-500
// KB per repo (mostly the graph). LRU eviction could be added in F6 but
// for typical workspaces (3-10 repos) this is fine.

/** @type {Map<string, RepoContext>} */
const repoContexts = new Map()

class RepoContext {
  constructor(repoPath) {
    this.repoPath = repoPath
    this.treeScanner = new TreeScanner(repoPath)
    this.graphResolver = new GraphResolver({ repoPath, logger })
    this.diffProvider = new DiffProvider({ repoPath, logger })
    // rc8+: knowledgeGraph composes graphResolver + the multi-repo
    // knowledgeStore singleton + eventStore for cross-walks. Its
    // rebuild is awaited AFTER graphResolver finishes so the
    // structural Maps are populated when knowledgeGraph reads them.
    this.knowledgeGraph = new KnowledgeGraph({
      repoPath,
      graphResolver: this.graphResolver,
      knowledgeStore,
      logger,
    })
  }
  stop() {
    this.graphResolver.stop()
    this.knowledgeGraph.stop()
  }
}

function getOrCreateContext(repoPath) {
  if (!repoPath) return null
  const key = normRepo(repoPath)
  let ctx = repoContexts.get(key)
  if (!ctx) {
    ctx = new RepoContext(key)
    repoContexts.set(key, ctx)
    // Kick off the graph build asynchronously so the first /api/heat
    // for this repo can return a basic answer while propagation lights
    // up in the background. rc8+: chain a knowledgeGraph rebuild
    // after graphResolver succeeds. Failures of either layer keep
    // the previous snapshot (see KnowledgeGraph.rebuild) and never
    // block Express handlers.
    ctx.graphResolver.rebuild().then(async () => {
      sse.broadcast('heat-update', { at: new Date().toISOString(), reason: 'graph-built', repo: key })
      await ctx.knowledgeGraph.rebuild()
      sse.broadcast('knowledge-graph-update', { at: new Date().toISOString(), repo: key })
    }).catch(() => { /* already logged */ })
    logger.info({ repo: key }, 'repo context created')
  }
  return ctx
}

// Repo detector: scans parentDir, ranks by activity.
let repoDetector = null
function rebuildRepoDetector() {
  const prefs = preferences.get()
  if (prefs.parentDir && existsSync(prefs.parentDir) && statSync(prefs.parentDir).isDirectory()) {
    repoDetector = new RepoDetector({ parentDir: prefs.parentDir, eventStore, logger })
  } else {
    repoDetector = null
  }
}
rebuildRepoDetector()

// ─── Watcher (JSONL + active repo's tree) ──────────────────────────────────

const watcher = new Watcher({
  logDir: LOG_DIR,
  targetRepo: preferences.get().currentRepo,
  logger,
  onJsonlChange: async () => {
    try {
      const fresh = await eventStore.tail()
      if (fresh.length > 0) {
        sse.broadcast('heat-update', {
          at: new Date().toISOString(),
          newEvents: fresh.length,
        })
      }
    } catch (err) {
      logger.warn({ err: String(err) }, 'tail failed')
    }
  },
  onTreeChange: () => {
    const repo = preferences.get().currentRepo
    if (!repo) return
    const ctx = repoContexts.get(normRepo(repo))
    if (ctx) ctx.treeScanner.invalidate()
    sse.broadcast('tree-update', { at: new Date().toISOString() })
  },
  onSourceChange: () => {
    const repo = preferences.get().currentRepo
    if (!repo) return
    const ctx = repoContexts.get(normRepo(repo))
    if (ctx) {
      ctx.graphResolver.scheduleRebuild()
      // rc8+: knowledgeGraph debounces independently. The structural
      // Maps it reads from graphResolver may be one tick stale on
      // the first run, but the next file change brings it current.
      ctx.knowledgeGraph.scheduleRebuild()
    }
  },
})
watcher.start()
logger.info({ targetRepo: preferences.get().currentRepo || '(wizard)' }, 'watchers started')

// Build initial repo context if we have an active repo
const initialCurrent = preferences.get().currentRepo
if (initialCurrent) getOrCreateContext(initialCurrent)

// ─── Repo switching ────────────────────────────────────────────────────────

/**
 * Atomically switch the active repo: save prefs, repoint watcher,
 * reset iteration marker (each repo gets a clean iteration), warm up
 * the context, broadcast SSE. Used by both manual selection and
 * auto-switch.
 *
 * Manual selections automatically pause the auto-switch loop for
 * AUTO_SWITCH_SNOOZE_MS so the user's choice can't be silently
 * overwritten by sustained activity in another repo. The snooze is
 * in-memory only — server restart clears it. To pin a repo
 * permanently the user must toggle off `autoSwitch` in preferences.
 */
const AUTO_SWITCH_SNOOZE_MS = 5 * 60 * 1000 // 5 minutes
/** Wall-clock ms when auto-switch resumes. 0 means "not snoozed". */
let autoSwitchSnoozedUntil = 0

async function switchRepo(newRepoPath, { reason } = { reason: 'manual' }) {
  const before = preferences.get().currentRepo
  if (normRepo(before) === normRepo(newRepoPath)) return
  await preferences.save({ currentRepo: newRepoPath })
  iterationMarker.reset()
  await watcher.repointTarget(newRepoPath || null)
  if (newRepoPath) getOrCreateContext(newRepoPath)
  // Any manual or parent-dir-driven switch arms the snooze so the
  // 10-s auto loop doesn't immediately undo the user's intent. An
  // auto-driven switch (reason==='auto') deliberately does NOT arm
  // it — otherwise auto-switch would snooze itself forever.
  if (reason !== 'auto') {
    autoSwitchSnoozedUntil = Date.now() + AUTO_SWITCH_SNOOZE_MS
  }
  sse.broadcast('repo-changed', {
    from: before,
    to: newRepoPath,
    reason,
    at: new Date().toISOString(),
    autoSwitchSnoozedUntil: autoSwitchSnoozedUntil || null,
  })
  logger.info({ from: before, to: newRepoPath, reason }, 'active repo switched')
}

// ─── Auto-switch loop (every 10s) ──────────────────────────────────────────

const AUTO_SWITCH_INTERVAL_MS = 10_000
const autoSwitchTimer = setInterval(() => {
  const prefs = preferences.get()
  if (!prefs.autoSwitch) return
  if (!prefs.parentDir) return
  // Honor the post-manual-switch snooze window. We let the timestamp
  // run down naturally (no cleanup needed) — once Date.now() catches
  // up the comparison fails and auto-switch resumes.
  if (autoSwitchSnoozedUntil && Date.now() < autoSwitchSnoozedUntil) return
  const candidate = computeActiveRepo(
    eventStore.getEvents(),
    prefs.currentRepo,
    true,
  )
  if (candidate && normRepo(candidate) !== normRepo(prefs.currentRepo)) {
    switchRepo(candidate, { reason: 'auto' }).catch((err) => {
      logger.warn({ err: String(err) }, 'auto-switch failed')
    })
  }
}, AUTO_SWITCH_INTERVAL_MS)
autoSwitchTimer.unref?.()

// ─── Express ────────────────────────────────────────────────────────────────

const app = express()
app.disable('x-powered-by')
// Stamp baseline security headers (CSP + frame-ancestors + COOP/CORP
// + permissions-policy) on every response BEFORE the router so the
// headers also cover static asset responses. See security.js for the
// per-directive reasoning.
app.use(securityHeaders())
app.use(express.json({ limit: '64kb' })) // small bodies only — prefs + repo selects
app.use(makeRouter({
  // Per-repo context resolver. Routes call this each request so we
  // pick up changes in `preferences.currentRepo` between requests
  // without holding stale references.
  getRepoContext: () => {
    const repo = preferences.get().currentRepo
    return repo ? getOrCreateContext(repo) : null
  },
  eventStore,
  sse,
  iterationMarker,
  preferences,
  repoDetector: () => repoDetector,
  rebuildRepoDetector: () => { rebuildRepoDetector() },
  switchRepo,
  depth: PROP_DEPTH,
  logger,
  blastRadiusRoot: BLASTRADIUS_ROOT,
  serverStartSha: SERVER_START_SHA,
  // The auto-switch snooze is in-memory module state. Expose it as a
  // getter so the route handler reads the live value on each call
  // (the snooze timestamp ticks down naturally).
  getAutoSwitchSnoozedUntil: () => autoSwitchSnoozedUntil || null,
  // rc8+: multi-repo KnowledgeStore singleton. The router uses this
  // for POST /api/graph/node persistence; reads stay against the
  // per-repo knowledgeGraph snapshot reached via getRepoContext().
  knowledgeStore,
}))
// MCP read-only transport at /mcp. Mounted AFTER the /api router and
// BEFORE static + SPA fallback so requests to /mcp are handled by the
// MCP transport and never fall through to index.html. The MCP router
// only declares /mcp routes (POST/GET/DELETE), so any other URL passes
// through via next() to static + SPA fallback unchanged.
app.use(makeMcpRouter({
  getRepoContext: () => {
    const repo = preferences.get().currentRepo
    return repo ? getOrCreateContext(repo) : null
  },
  eventStore,
  iterationMarker,
  preferences,
  repoDetector: () => repoDetector,
  depth: PROP_DEPTH,
  logger,
  appVersion: APP_VERSION,
  // rc8+: set_node_summary needs to persist to ~/.blastradius/knowledge.json.
  knowledgeStore,
  serverInfo: {
    name: 'blastradius',
    version: APP_VERSION,
    sha: SERVER_START_SHA,
  },
}))
app.use(express.static(PUBLIC_DIR, { etag: true, maxAge: 0 }))

// SPA fallback: any non-API, non-MCP path serves index.html so the
// frontend router can handle deep links. Both /api/* (legacy HTTP API)
// and /mcp (MCP transport) are excluded so a misrouted request to
// either surface returns the expected error from the router rather
// than a page of HTML.
app.get(/^\/(?!api\/|mcp(\/|$)).*/, (req, res, next) => {
  res.sendFile(resolve(PUBLIC_DIR, 'index.html'), (err) => {
    if (err) next(err)
  })
})

// MCP usage stats → SSE bridge. The stats module debounces bursts
// to ~2 events/sec so this never floods the channel even during
// heavy agent polling. Dashboards subscribed to 'mcp-stats-update'
// receive the full snapshot — no incremental deltas, no client-side
// reduction needed.
onMcpStatsUpdate((snapshot) => {
  try { sse.broadcast('mcp-stats-update', snapshot) } catch { /* never crash on broadcast */ }
})

const server = app.listen(PORT, HOST, () => {
  logger.info(
    { host: HOST, port: PORT, parentDir: preferences.get().parentDir, currentRepo: preferences.get().currentRepo, logDir: LOG_DIR },
    'BlastRadius server listening',
  )
  logger.info(`open http://${HOST === '0.0.0.0' || HOST === '::' ? 'localhost' : HOST}:${PORT}`)
  if (HOST !== '127.0.0.1' && HOST !== '::1' && HOST !== 'localhost') {
    // Loud warning when the operator opts in to a public-facing bind.
    // Matches the policy documented in SECURITY.md: BlastRadius has no
    // auth layer, so any non-loopback bind requires the operator to
    // own the auth surface themselves (firewall, reverse proxy, …).
    logger.warn(
      { host: HOST },
      'BLASTRADIUS_HOST is set to a non-loopback address. The dashboard has no built-in authentication; '
      + 'put a reverse proxy with auth in front of it before exposing it to a network.',
    )
  }
})

// ─── PID file ───────────────────────────────────────────────────────────────
//
// Windows doesn't propagate the "X" button on a cmd window to the
// child node process, so closing the launcher window leaves the
// server orphaned. A PID file lets the next `run.bat` invocation find
// and kill the previous instance — including zombies that aren't
// listening anymore.
//
// Cross-platform note: on POSIX the same file is harmless; SIGINT/
// SIGTERM normally clean it up, and a stale file from a `kill -9` is
// detected by checking whether the PID is still alive before we kill
// it ourselves.

const PID_FILE = resolve(homedir(), '.blastradius', 'server.pid')

function writePidFile() {
  try {
    mkdirSync(dirname(PID_FILE), { recursive: true })
    writeFileSync(PID_FILE, String(process.pid), { encoding: 'utf8' })
    logger.debug({ pid: process.pid, path: PID_FILE }, 'wrote PID file')
  } catch (err) {
    logger.warn({ err: String(err?.message ?? err) }, 'failed to write PID file')
  }
}

function clearPidFile() {
  try {
    if (existsSync(PID_FILE)) {
      const stored = readFileSync(PID_FILE, 'utf8').trim()
      // Only delete the file if it belongs to us. Defends against the
      // race where a fresh server wrote its PID right before our
      // shutdown handler fired.
      if (stored === String(process.pid)) unlinkSync(PID_FILE)
    }
  } catch {
    // PID file ops are best-effort; don't break shutdown if cleanup fails.
  }
}

writePidFile()

// ─── Graceful shutdown ──────────────────────────────────────────────────────

let shuttingDown = false
async function shutdown(signal) {
  if (shuttingDown) return
  shuttingDown = true
  logger.info({ signal }, 'shutting down')
  const killTimer = setTimeout(() => {
    logger.warn('forced exit (shutdown timeout)')
    clearPidFile()
    process.exit(1)
  }, 5_000)
  killTimer.unref()

  clearInterval(autoSwitchTimer)
  sse.closeAll()
  for (const ctx of repoContexts.values()) ctx.stop()
  await watcher.stop()
  server.close(() => {
    clearTimeout(killTimer)
    clearPidFile()
    process.exit(0)
  })
}
process.on('SIGINT', () => shutdown('SIGINT'))
process.on('SIGTERM', () => shutdown('SIGTERM'))
// SIGBREAK is Windows-only (Ctrl+Break in the cmd window). Treat it
// the same as SIGINT so the user can stop the server with either
// keystroke.
process.on('SIGBREAK', () => shutdown('SIGBREAK'))
// Last-ditch cleanup if something goes wrong elsewhere. exit() can
// fire without our signal handlers (e.g. uncaught exception),
// so we wipe the PID file synchronously here too.
process.on('exit', () => { clearPidFile() })
