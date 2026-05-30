/**
 * GET /api/diagnostics (rc9.13) — full stack: a real repo whose
 * .claude/settings.json points the hook at the WRONG log dir → the endpoint
 * surfaces a `log_dir_mismatch` warning (the rc9.12 silent bug, now visible).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import express from 'express'
import { makeRouter } from '../src/server/routes.js'
import { buildHookEntry } from '../src/server/hookInstaller.js'

function appWith(getRepoContext, logDir, blastRadiusRoot) {
  const app = express()
  app.use(express.json({ limit: '64kb' }))
  app.use(makeRouter({
    getRepoContext,
    eventStore: { getEvents: () => [], getEventsForRepo: () => [], listDaysWithActivity: async () => [] },
    sse: { size: () => 0, addClient() {}, broadcast() {} },
    iterationMarker: { get: () => null, getIso: () => null },
    preferences: { get: () => ({ currentRepo: null }) },
    repoDetector: () => null,
    depth: 2,
    logger: { debug() {}, info() {}, warn() {} },
    blastRadiusRoot,
    logDir,
    serverStartSha: 'test',
    getAutoSwitchSnoozedUntil: () => null,
  }))
  return app
}
async function listen(app) {
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)) })
  return { server, base: `http://127.0.0.1:${server.address().port}` }
}

describe('GET /api/diagnostics (rc9.13)', () => {
  let repo, home, server, base
  const BLAST_ROOT = '/opt/blastradius'
  let RIGHT_LOG, WRONG_LOG

  beforeAll(async () => {
    repo = mkdtempSync(join(tmpdir(), 'br-diag-'))
    home = mkdtempSync(join(tmpdir(), 'br-diag-home-'))
    RIGHT_LOG = join(home, '.blastradius', 'logs')
    WRONG_LOG = join(repo, 'logs') // the old <repo>/logs default — the bug
    // getHookStatus only inspects a real repo (requires a .git marker).
    mkdirSync(join(repo, '.git'), { recursive: true })
    // Install the hook pointing at the WRONG folder.
    const wrongEntry = buildHookEntry({ logDir: WRONG_LOG, blastRadiusRoot: BLAST_ROOT })
    mkdirSync(join(repo, '.claude'), { recursive: true })
    writeFileSync(join(repo, '.claude', 'settings.json'), JSON.stringify({ hooks: { PostToolUse: [wrongEntry] } }))
    ;({ server, base } = await listen(appWith(() => ({ repoPath: repo }), RIGHT_LOG, BLAST_ROOT)))
  })
  afterAll(async () => {
    await new Promise((r) => server.close(r))
    for (const d of [repo, home]) { try { rmSync(d, { recursive: true, force: true }) } catch {} }
  })

  it('surfaces a log_dir_mismatch warning when the hook writes elsewhere', async () => {
    const res = await fetch(`${base}/api/diagnostics`)
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data.repoPath).toBe(repo)
    const mismatch = data.checks.find((c) => c.code === 'log_dir_mismatch')
    expect(mismatch).toBeTruthy()
    expect(mismatch.level).toBe('warn')
    expect(mismatch.fix).toBe('reinstall_hook')
  })

  it('is silent when the hook points at the server log dir', async () => {
    const rightEntry = buildHookEntry({ logDir: RIGHT_LOG, blastRadiusRoot: BLAST_ROOT })
    writeFileSync(join(repo, '.claude', 'settings.json'), JSON.stringify({ hooks: { PostToolUse: [rightEntry] } }))
    const data = await (await fetch(`${base}/api/diagnostics`)).json()
    expect(data.checks.find((c) => c.code === 'log_dir_mismatch')).toBeUndefined()
  })

  it('returns no checks when there is no active repo', async () => {
    const { server: s2, base: b2 } = await listen(appWith(() => null, RIGHT_LOG, BLAST_ROOT))
    try {
      const data = await (await fetch(`${b2}/api/diagnostics`)).json()
      expect(data.checks).toEqual([])
    } finally { await new Promise((r) => s2.close(r)) }
  })
})
