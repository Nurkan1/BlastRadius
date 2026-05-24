#!/usr/bin/env node
/**
 * BlastRadius dashboard server.
 *
 *   - HTTP/JSON API for the SPA: /api/tree, /api/heat, /api/events
 *   - Static frontend served from src/public
 *   - SSE broadcasts heat-update / tree-update in real time
 *
 * Strictly read-only on BLASTRADIUS_TARGET_REPO. The server walks the
 * tree, reads the JSONL log, and pushes derived state to connected
 * clients — it never opens a write handle on the target repo.
 *
 * Boot order:
 *   1. Validate env (target repo + log dir; port has a default).
 *   2. Construct treeScanner, eventStore, SSE broadcaster.
 *   3. Load initial events (await — we want /api/heat to be useful
 *      from the first request).
 *   4. Start chokidar watchers.
 *   5. Mount router + static, start listening.
 *   6. Wire SIGINT/SIGTERM to a graceful shutdown.
 */

import express from 'express'
import { dirname, resolve } from 'node:path'
import { existsSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import pino from 'pino'
import 'dotenv/config'

import { TreeScanner } from './treeScanner.js'
import { EventStore } from './eventStore.js'
import { Watcher } from './watcher.js'
import { SSEBroadcaster } from './sse.js'
import { GraphResolver } from './graphResolver.js'
import { makeRouter } from './routes.js'

const logger = pino({
  level: process.env.BLASTRADIUS_LOG_LEVEL || 'info',
  base: { name: 'blastradius' },
})

// ─── Env validation ─────────────────────────────────────────────────────────

const PORT = Number(process.env.BLASTRADIUS_PORT) || 7842
const TARGET_REPO = process.env.BLASTRADIUS_TARGET_REPO
const LOG_DIR = process.env.BLASTRADIUS_LOG_DIR
// BFS depth for yellow propagation. Clamped to [1, 3] per the brief —
// anything bigger blows up the consumer set on real repos.
const PROP_DEPTH = (() => {
  const raw = Number(process.env.BLASTRADIUS_DEPTH)
  if (!Number.isInteger(raw)) return 2
  return Math.min(3, Math.max(1, raw))
})()

function fail(msg) {
  logger.error(msg)
  process.exit(1)
}

if (!TARGET_REPO) fail('BLASTRADIUS_TARGET_REPO is required (absolute path to repo to observe)')
if (!LOG_DIR) fail('BLASTRADIUS_LOG_DIR is required (where the hook writes daily JSONL logs)')
if (!existsSync(TARGET_REPO) || !statSync(TARGET_REPO).isDirectory()) {
  fail(`BLASTRADIUS_TARGET_REPO does not exist or is not a directory: ${TARGET_REPO}`)
}
// LOG_DIR may not exist yet (first run) — chokidar handles that by watching
// the parent dir's adds. We don't fail on missing log dir.

const __dirname = dirname(fileURLToPath(import.meta.url))
const PUBLIC_DIR = resolve(__dirname, '..', 'public')

// ─── Wire up the pipeline ───────────────────────────────────────────────────

const treeScanner = new TreeScanner(TARGET_REPO)
const eventStore = new EventStore(LOG_DIR)
const sse = new SSEBroadcaster()
const graphResolver = new GraphResolver({ repoPath: TARGET_REPO, logger })

await eventStore.loadInitial().catch((err) => {
  logger.warn({ err: String(err) }, 'initial event load failed; starting with empty store')
})
logger.info({ initialEvents: eventStore.getEvents().length }, 'event store initialized')

// Build the import graph at boot. We don't block startup if it fails
// (the resolver keeps the empty graph and the dashboard works without
// yellow propagation until the next rebuild lands).
graphResolver.rebuild().then(() => {
  const stats = graphResolver.getGraph().stats
  logger.info({ stats }, 'import graph ready')
  // Tell SSE listeners that yellow data may now be available.
  sse.broadcast('heat-update', { at: new Date().toISOString(), reason: 'graph-built' })
}).catch(() => { /* already logged inside rebuild */ })

const watcher = new Watcher({
  logDir: LOG_DIR,
  targetRepo: TARGET_REPO,
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
    treeScanner.invalidate()
    sse.broadcast('tree-update', { at: new Date().toISOString() })
  },
  onSourceChange: () => {
    // Debounced inside the resolver. Bursts of saves (e.g. format-on-save
    // across many files) coalesce into a single rebuild.
    graphResolver.scheduleRebuild()
    // We also fire a heat-update after the rebuild completes via the
    // resolver's own logger — but to keep latency low for the next /api/heat
    // request, we don't preemptively broadcast here.
  },
})
watcher.start()
logger.info('watchers started')

// ─── Express ────────────────────────────────────────────────────────────────

const app = express()
app.disable('x-powered-by')
app.use(makeRouter({ treeScanner, eventStore, sse, graphResolver, depth: PROP_DEPTH, logger }))
app.use(express.static(PUBLIC_DIR, { etag: true, maxAge: 0 }))

// Fallback for SPA-style routes — the dashboard is a single page, so any
// non-API GET that doesn't match a static file returns index.html.
app.get(/^\/(?!api\/).*/, (req, res, next) => {
  res.sendFile(resolve(PUBLIC_DIR, 'index.html'), (err) => {
    if (err) next(err)
  })
})

const server = app.listen(PORT, () => {
  logger.info(
    { port: PORT, targetRepo: TARGET_REPO, logDir: LOG_DIR, publicDir: PUBLIC_DIR },
    'BlastRadius server listening',
  )
  logger.info(`open http://localhost:${PORT}`)
})

// ─── Graceful shutdown ──────────────────────────────────────────────────────

let shuttingDown = false
async function shutdown(signal) {
  if (shuttingDown) return
  shuttingDown = true
  logger.info({ signal }, 'shutting down')
  // Force-exit fallback in case server.close hangs on stuck connections.
  const killTimer = setTimeout(() => {
    logger.warn('forced exit (shutdown timeout)')
    process.exit(1)
  }, 5_000)
  killTimer.unref()

  sse.closeAll()
  graphResolver.stop()
  await watcher.stop()
  server.close(() => {
    clearTimeout(killTimer)
    process.exit(0)
  })
}
process.on('SIGINT', () => shutdown('SIGINT'))
process.on('SIGTERM', () => shutdown('SIGTERM'))
