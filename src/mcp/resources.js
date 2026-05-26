/**
 * BlastRadius MCP resources — Phase 1, read-only.
 *
 * Resources are URI-addressable read-only data. They mirror the
 * existing /api/* endpoints but expose them under stable
 * `blastradius://` URIs so MCP clients can subscribe / cache them
 * by URI instead of having to call tools repeatedly.
 *
 * Static resources:
 *   - blastradius://health             dashboard health
 *   - blastradius://iteration/current  current iteration marker + summary
 *   - blastradius://repo/active        currently active repo (or null)
 *   - blastradius://repos              all detected repos under parentDir
 *   - blastradius://events/recent      last 100 events on the active repo
 *
 * Templated resource:
 *   - blastradius://heat/{window}      heat map for window in {session, iteration, hour, day}
 *
 * Every resource response is JSON-encoded text under
 * `contents[0].text` with `mimeType: 'application/json'`. The NO-DATA
 * contract (see noData.js) applies the same way as for tools.
 */

import { ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js'
import { computeHeat, resolveWindow } from '../server/heatEngine.js'
import * as noData from './noData.js'

/** Wrap a JSON payload as the MCP resource read response. */
function asResource(uri, payload) {
  return {
    contents: [
      {
        uri,
        mimeType: 'application/json',
        text: JSON.stringify(payload, null, 2),
      },
    ],
  }
}

export function registerResources({
  mcpServer,
  getRepoContext,
  eventStore,
  iterationMarker,
  preferences,
  repoDetector,
  depth = 2,
  serverInfo,
}) {
  // ── blastradius://health ──────────────────────────────────────────────
  mcpServer.registerResource(
    'health',
    'blastradius://health',
    {
      title: 'BlastRadius dashboard health',
      description: 'Server uptime, event count, currently active repo, and whether the dashboard is in wizard mode.',
      mimeType: 'application/json',
    },
    async (uri) => {
      const prefs = preferences.get()
      return asResource(uri.toString(), {
        status: 'ok',
        uptime: process.uptime(),
        events: eventStore.getEvents().length,
        currentRepo: prefs.currentRepo,
        parentDir: prefs.parentDir,
        autoSwitch: prefs.autoSwitch,
        needsSetup: !!prefs.needsSetup,
        iterationStartedAt: iterationMarker?.getIso() ?? null,
        server: serverInfo ?? null,
      })
    },
  )

  // ── blastradius://iteration/current ───────────────────────────────────
  mcpServer.registerResource(
    'iteration-current',
    'blastradius://iteration/current',
    {
      title: 'Current iteration (marker + summary fused)',
      description: 'Combines /api/iteration and /api/iteration/summary into a single payload for AI agents.',
      mimeType: 'application/json',
    },
    async (uri) => {
      const ctx = getRepoContext?.()
      if (!ctx) {
        const prefs = preferences.get()
        return asResource(
          uri.toString(),
          noData.iteration(prefs.needsSetup ? 'needs_setup' : 'no_active_repo'),
        )
      }
      const totalFiles = await ctx.treeScanner.countFiles()
      const treeFiles = await ctx.treeScanner.getFileSet()
      const graph = ctx.graphResolver.getGraph()
      const events = eventStore.getEventsForRepo(ctx.repoPath)
      const result = computeHeat({
        events,
        window: 'iteration',
        now: new Date(),
        totalFiles,
        graph,
        depth,
        iterationStartedAt: iterationMarker?.get() ?? null,
        treeFiles,
        platform: 'all',
      })

      const ITERATION_WINDOW_MS = 3 * 60 * 1000
      const explicitStart = iterationMarker?.get?.() ?? null
      const effectiveStartMs = explicitStart instanceof Date && !Number.isNaN(explicitStart.getTime())
        ? explicitStart.getTime()
        : Date.now() - ITERATION_WINDOW_MS

      let lastEventTs = null
      for (const ev of events) {
        if (!ev?.ts) continue
        const ms = Date.parse(ev.ts)
        if (!Number.isFinite(ms)) continue
        if (ms < effectiveStartMs) continue
        if (lastEventTs === null || ms > lastEventTs) lastEventTs = ms
      }

      const redFiles = Object.keys(result.files).filter((p) => result.files[p] === 'red')
      const greenFiles = Object.keys(result.files).filter((p) => result.files[p] === 'green')
      const yellowFiles = Object.keys(result.files).filter((p) => result.files[p] === 'yellow')
      const empty = redFiles.length === 0 && greenFiles.length === 0 && yellowFiles.length === 0

      return asResource(uri.toString(), empty
        ? noData.iteration('no_events_in_window', {
          iterationStartedAt: iterationMarker?.getIso() ?? null,
          effectiveStart: new Date(effectiveStartMs).toISOString(),
          isExplicit: explicitStart instanceof Date,
          lastEventTs: lastEventTs ? new Date(lastEventTs).toISOString() : null,
        })
        : {
          iterationStartedAt: iterationMarker?.getIso() ?? null,
          effectiveStart: new Date(effectiveStartMs).toISOString(),
          isExplicit: explicitStart instanceof Date,
          lastEventTs: lastEventTs ? new Date(lastEventTs).toISOString() : null,
          metrics: result.metrics,
          activities: {
            edited: redFiles.map((p) => ({ path: p, lastAgent: result.attributions[p] || 'Unknown' })),
            read: greenFiles.map((p) => ({ path: p, lastAgent: result.attributions[p] || 'Unknown' })),
            affected: yellowFiles.map((p) => ({
              path: p,
              impactedBy: (result.propagation[p] || []).map(
                (origin) => `${origin.path} (depth ${origin.depth})`,
              ),
            })),
          },
          reason: null,
        })
    },
  )

  // ── blastradius://repo/active ─────────────────────────────────────────
  mcpServer.registerResource(
    'repo-active',
    'blastradius://repo/active',
    {
      title: 'Currently active repo',
      description: 'Returns the active repo path and short name, or NO-DATA when in wizard mode.',
      mimeType: 'application/json',
    },
    async (uri) => {
      const prefs = preferences.get()
      if (!prefs.currentRepo) {
        return asResource(
          uri.toString(),
          noData.repo(prefs.needsSetup ? 'needs_setup' : 'no_active_repo'),
        )
      }
      return asResource(uri.toString(), {
        repo: {
          path: prefs.currentRepo,
          name: prefs.currentRepo.split('/').filter(Boolean).pop() || prefs.currentRepo,
        },
        autoSwitch: prefs.autoSwitch,
        reason: null,
      })
    },
  )

  // ── blastradius://repos ───────────────────────────────────────────────
  mcpServer.registerResource(
    'repos',
    'blastradius://repos',
    {
      title: 'All detected repos under parentDir',
      description: 'Lists every git repo under the configured parentDir with activity ranking. NO-DATA when parentDir is unset.',
      mimeType: 'application/json',
    },
    async (uri) => {
      const det = repoDetector?.()
      if (!det) {
        const prefs = preferences.get()
        return asResource(uri.toString(), {
          repos: null,
          reason: prefs.needsSetup ? 'needs_setup' : 'no_parent_dir',
        })
      }
      const repos = await det.getRepos({ force: false })
      const prefs = preferences.get()
      const activePath = prefs.currentRepo
        ? prefs.currentRepo.replace(/\\/g, '/')
        : null
      return asResource(uri.toString(), {
        repos: repos.map((r) => ({
          ...r,
          isActive: r.path.replace(/\\/g, '/') === activePath,
        })),
        parentDir: prefs.parentDir,
        reason: repos.length === 0 ? 'no_repos_under_parent_dir' : null,
      })
    },
  )

  // ── blastradius://events/recent ───────────────────────────────────────
  mcpServer.registerResource(
    'events-recent',
    'blastradius://events/recent',
    {
      title: 'Recent touch events on the active repo',
      description: 'Last 100 events on the active repo in reverse-chronological order. NO-DATA when no repo is active.',
      mimeType: 'application/json',
    },
    async (uri) => {
      const ctx = getRepoContext?.()
      if (!ctx) {
        const prefs = preferences.get()
        return asResource(uri.toString(), {
          events: null,
          reason: prefs.needsSetup ? 'needs_setup' : 'no_active_repo',
        })
      }
      const all = eventStore.getEventsForRepo(ctx.repoPath)
      if (all.length === 0) {
        return asResource(uri.toString(), {
          events: [],
          repo: ctx.repoPath,
          reason: 'no_events_recorded',
        })
      }
      const recent = all
        .slice(-100)
        .reverse()
        .map((ev) => ({
          ts: ev.ts,
          pathNorm: ev.pathNorm,
          tool: ev.tool,
          agent: ev.agent ?? null,
          sessionId: ev.sessionId ?? null,
        }))
      return asResource(uri.toString(), {
        events: recent,
        repo: ctx.repoPath,
        total: all.length,
        reason: null,
      })
    },
  )

  // ── blastradius://heat/{window} ───────────────────────────────────────
  mcpServer.registerResource(
    'heat',
    new ResourceTemplate('blastradius://heat/{window}', {
      list: undefined,
      // Help MCP clients auto-complete the window variable.
      complete: {
        window: (value) =>
          ['session', 'iteration', 'hour', 'day']
            .filter((w) => w.startsWith(value || '')),
      },
    }),
    {
      title: 'Heat map for a given time window',
      description: 'Per-file color map (red/green/yellow) and metrics for the given window. Valid windows: session, iteration, hour, day.',
      mimeType: 'application/json',
    },
    async (uri, variables) => {
      const ctx = getRepoContext?.()
      const windowName = String(variables?.window ?? 'session')
      if (!ctx) {
        const prefs = preferences.get()
        return asResource(
          uri.toString(),
          noData.heat(prefs.needsSetup ? 'needs_setup' : 'no_active_repo', { window: windowName }),
        )
      }
      // resolveWindow returns the same value for unknown names as for
      // 'session' (the default). To preserve the NO-DATA contract for
      // explicitly unknown windows, validate against a whitelist first.
      const ALLOWED = new Set(['session', 'iteration', 'hour', 'day'])
      if (!ALLOWED.has(windowName)) {
        return asResource(
          uri.toString(),
          noData.heat('unknown_window', { window: windowName, allowed: [...ALLOWED] }),
        )
      }
      // 'day' is a convenience alias for 'session' (all of today's events).
      const effectiveWindow = windowName === 'day' ? 'session' : windowName
      // Reference resolveWindow so future windowName additions stay in
      // sync with heatEngine; the value isn't otherwise needed here
      // because computeHeat re-resolves internally.
      void resolveWindow(effectiveWindow)
      const totalFiles = await ctx.treeScanner.countFiles()
      const treeFiles = await ctx.treeScanner.getFileSet()
      const graph = ctx.graphResolver.getGraph()
      const events = eventStore.getEventsForRepo(ctx.repoPath)
      const result = computeHeat({
        events,
        window: effectiveWindow,
        now: new Date(),
        totalFiles,
        graph,
        depth,
        iterationStartedAt: iterationMarker?.get() ?? null,
        treeFiles,
        platform: 'all',
      })
      const isEmpty = Object.keys(result.files).length === 0
      return asResource(uri.toString(), isEmpty
        ? noData.heat('no_events_in_window', { window: windowName })
        : { ...result, window: windowName, reason: null })
    },
  )
}
