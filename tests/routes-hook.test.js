/**
 * /api/repo/hook-status + /api/repo/install-hook — REST contract.
 *
 * Two new endpoints land in src/server/routes.js (rc8.4):
 *
 *   GET  /api/repo/hook-status?path=<absRepoPath>
 *   POST /api/repo/install-hook   body { path }
 *
 * Both reuse the hookInstaller module. The POST gates by
 * preferences.parentDir — a path outside parentDir is rejected at
 * the boundary, NEVER passed through to the installer. That's the
 * security invariant: the dashboard can only ever write a
 * settings.json under the user's declared parentDir.
 *
 * No new dependencies — boot Express + makeRouter() directly,
 * same pattern tests/routes-graph.test.js uses for /api/graph.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import express from 'express'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { makeRouter } from '../src/server/routes.js'

// ─── Shared deps fakes ─────────────────────────────────────────────────────

function buildPrefs(parentDir) {
  return {
    get: () => ({
      currentRepo: null,
      parentDir,
      autoSwitch: false,
      iterationWindowMs: 180000,
      viewMode: 'tree',
      ignoredHookRepos: [],
      needsSetup: false,
    }),
    save: async () => ({}),
  }
}

function buildDeps(parentDir, blastRadiusRoot) {
  return {
    getRepoContext: () => null,
    eventStore: {
      getEvents: () => [],
      getEventsForRepo: () => [],
      listDaysWithActivity: async () => [],
    },
    iterationMarker: { get: () => null, getIso: () => null },
    preferences: buildPrefs(parentDir),
    repoDetector: () => ({ getRepos: async () => [] }),
    rebuildRepoDetector: () => {},
    switchRepo: async () => {},
    depth: 2,
    logger: { debug() {}, info() {}, warn() {} },
    blastRadiusRoot,
    logDir: join(tempDir, 'logs'),
    serverStartSha: 'test',
    getAutoSwitchSnoozedUntil: () => null,
    knowledgeStore: { setNodeSummary: async () => ({}) },
    sse: { broadcast: () => {} },
  }
}

// ─── Lifecycle ─────────────────────────────────────────────────────────────

let tempDir
let parentDir
let fakeRepoPath
let outsideRepoPath
let server
let baseUrl

beforeAll(async () => {
  tempDir = await fs.mkdtemp(join(tmpdir(), 'blastradius-routes-hook-'))
  parentDir = join(tempDir, 'projects')
  await fs.mkdir(parentDir, { recursive: true })

  fakeRepoPath = join(parentDir, 'myrepo')
  await fs.mkdir(join(fakeRepoPath, '.git'), { recursive: true })

  outsideRepoPath = join(tempDir, 'outside')
  await fs.mkdir(join(outsideRepoPath, '.git'), { recursive: true })

  const app = express()
  app.use(express.json({ limit: '64kb' }))
  app.use(makeRouter(buildDeps(parentDir, tempDir)))
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve)
  })
  const { port } = server.address()
  baseUrl = `http://127.0.0.1:${port}`
})

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve))
  await fs.rm(tempDir, { recursive: true, force: true })
})

beforeEach(async () => {
  // Wipe any .claude/ that prior tests may have written so each test
  // sees a clean repo and the order of `it` blocks doesn't matter.
  for (const repo of [fakeRepoPath, outsideRepoPath]) {
    await fs.rm(join(repo, '.claude'), { recursive: true, force: true })
  }
})

// ─── Tests ─────────────────────────────────────────────────────────────────

describe('GET /api/repo/hook-status', () => {
  it('returns installed=false for a repo without .claude/settings.json', async () => {
    const res = await fetch(`${baseUrl}/api/repo/hook-status?path=${encodeURIComponent(fakeRepoPath)}`)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.installed).toBe(false)
    expect(body.settingsExists).toBe(false)
    expect(body.expectedCommand).toMatch(/log-touch\.js/)
    expect(body.currentCommand).toBeNull()
    // rc9.14: a not-installed status carries a Claude-Code-pasteable prompt so
    // the banner can offer "Copy prompt for Claude Code".
    expect(typeof body.claudePrompt).toBe('string')
    expect(body.claudePrompt).toContain('log-touch.js')
    expect(body.claudePrompt).toContain('PostToolUse')
    expect(body.claudePrompt).toContain(join(tempDir, 'logs').replace(/\\/g, '/'))
  })

  it('returns installed=true after a successful POST install', async () => {
    const install = await fetch(`${baseUrl}/api/repo/install-hook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: fakeRepoPath }),
    })
    expect(install.status).toBe(200)

    const status = await fetch(`${baseUrl}/api/repo/hook-status?path=${encodeURIComponent(fakeRepoPath)}`)
    const body = await status.json()
    expect(body.installed).toBe(true)
    expect(body.settingsExists).toBe(true)
    expect(body.currentCommand).toBe(body.expectedCommand)
    // No repair prompt once the hook is correctly installed.
    expect(body.claudePrompt).toBeUndefined()
  })

  it('rejects path traversal in the query', async () => {
    const res = await fetch(`${baseUrl}/api/repo/hook-status?path=${encodeURIComponent('../../etc')}`)
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(['escapes_root', 'invalid_path', 'absolute_path']).toContain(body.error)
  })
})

describe('POST /api/repo/install-hook', () => {
  it('installs into a repo under parentDir and returns the install result', async () => {
    const res = await fetch(`${baseUrl}/api/repo/install-hook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: fakeRepoPath }),
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.action).toBe('created')
    expect(body.settingsPath.replace(/\\/g, '/')).toContain('/myrepo/.claude/settings.json')

    // File actually exists on disk with the expected shape.
    const raw = await fs.readFile(body.settingsPath, 'utf8')
    const settings = JSON.parse(raw)
    expect(settings.hooks.PostToolUse[0].matcher).toBe('Edit|Write|Read')
  })

  it('rejects path OUTSIDE preferences.parentDir', async () => {
    const res = await fetch(`${baseUrl}/api/repo/install-hook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: outsideRepoPath }),
    })
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toBe('repo_outside_parent_dir')

    // File MUST NOT have been touched.
    const exists = await fs
      .access(join(outsideRepoPath, '.claude', 'settings.json'))
      .then(() => true)
      .catch(() => false)
    expect(exists).toBe(false)
  })

  it('rejects traversal in the body', async () => {
    const res = await fetch(`${baseUrl}/api/repo/install-hook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: '../../etc/passwd' }),
    })
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(['escapes_root', 'invalid_path', 'absolute_path']).toContain(body.error)
  })
})
