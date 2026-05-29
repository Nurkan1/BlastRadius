/**
 * GET /api/commits + GET /api/commits/:sha/files — commit investigation
 * endpoints (rc9.11).
 *
 * Full stack: a real temp git repo → DiffProvider → the Express route.
 * Verifies the response shape, a bad ref → 400, and no-repo → 503.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import express from 'express'
import { simpleGit } from 'simple-git'
import { makeRouter } from '../src/server/routes.js'
import { DiffProvider } from '../src/server/diffProvider.js'

function appWith(getRepoContext) {
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
    blastRadiusRoot: '/repo',
    logDir: '/tmp/logs',
    serverStartSha: 'test',
    getAutoSwitchSnoozedUntil: () => null,
  }))
  return app
}
async function listen(app) {
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)) })
  return { server, base: `http://127.0.0.1:${server.address().port}` }
}

describe('commit endpoints (rc9.11)', () => {
  let repo, ctx, server, base

  beforeAll(async () => {
    repo = mkdtempSync(join(tmpdir(), 'br-commits-'))
    const git = simpleGit({ baseDir: repo })
    await git.init()
    await git.addConfig('user.email', 'test@local')
    await git.addConfig('user.name', 'Test')
    writeFileSync(join(repo, 'a.js'), 'export const one = 1\n')
    await git.add('.'); await git.commit('first: add a.js')
    writeFileSync(join(repo, 'a.js'), 'export const one = 1\nexport const two = 2\n')
    writeFileSync(join(repo, 'b.js'), 'export const b = true\n')
    await git.add('.'); await git.commit('second: edit a.js, add b.js')

    ctx = { repoPath: repo, diffProvider: new DiffProvider({ repoPath: repo, logger: { warn() {} } }) }
    ;({ server, base } = await listen(appWith(() => ctx)))
  })
  afterAll(async () => {
    await new Promise((r) => server.close(r))
    if (repo) rmSync(repo, { recursive: true, force: true })
  })

  it('GET /api/commits lists recent commits newest-first', async () => {
    const res = await fetch(`${base}/api/commits`)
    expect(res.status).toBe(200)
    const { commits } = await res.json()
    expect(commits.length).toBe(2)
    expect(commits[0].subject).toMatch(/^second:/)   // newest first
    expect(commits[1].subject).toMatch(/^first:/)
    expect(commits[0].sha).toMatch(/^[0-9a-f]{40}$/)
    expect(typeof commits[0].shortSha).toBe('string')
  })

  it('GET /api/commits/:sha/files lists the files that commit touched', async () => {
    const { commits } = await (await fetch(`${base}/api/commits`)).json()
    const head = commits[0].sha
    const res = await fetch(`${base}/api/commits/${head}/files`)
    expect(res.status).toBe(200)
    const { sha, files } = await res.json()
    expect(sha).toBe(head)
    const byPath = Object.fromEntries(files.map((f) => [f.path, f.status]))
    expect(byPath['a.js']).toBe('M') // modified in the 2nd commit
    expect(byPath['b.js']).toBe('A') // added in the 2nd commit
  })

  it('reports the root commit files via --root', async () => {
    const { commits } = await (await fetch(`${base}/api/commits`)).json()
    const root = commits[1].sha
    const { files } = await (await fetch(`${base}/api/commits/${root}/files`)).json()
    expect(files.map((f) => f.path)).toContain('a.js')
  })

  it('GET /api/diff?commit=<sha> shows what THAT commit changed (sha^..sha)', async () => {
    const { commits } = await (await fetch(`${base}/api/commits`)).json()
    const second = commits[0].sha // the commit that added "two" to a.js
    const res = await fetch(`${base}/api/diff?path=a.js&commit=${second}`)
    expect(res.status).toBe(200)
    const out = await res.json()
    // sha^..sha — NOT sha..working-tree (which would be EMPTY here, since the
    // working tree equals the latest commit). So this proves the fix.
    expect(out.empty).toBe(false)
    expect(out.source).toBe('commit')
    expect(out.html).toContain('two')
  })

  it('GET /api/diff?commit=<root-sha> renders the root commit as an added file', async () => {
    const { commits } = await (await fetch(`${base}/api/commits`)).json()
    const root = commits[1].sha
    const out = await (await fetch(`${base}/api/diff?path=a.js&commit=${root}`)).json()
    expect(out.empty).toBe(false)
    expect(out.html).toContain('one') // the initial content
  })

  it('rejects a malformed ref with 400', async () => {
    const res = await fetch(`${base}/api/commits/${encodeURIComponent('not a ref!!')}/files`)
    expect(res.status).toBe(400)
  })

  it('returns 503 when there is no active repo', async () => {
    const { server: s2, base: b2 } = await listen(appWith(() => null))
    try {
      expect((await fetch(`${b2}/api/commits`)).status).toBe(503)
      expect((await fetch(`${b2}/api/commits/HEAD/files`)).status).toBe(503)
    } finally { await new Promise((r) => s2.close(r)) }
  })
})
