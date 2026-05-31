/**
 * BlastRadius MCP — assisted-onboarding setup tools (rc9.19).
 *
 * Tests get_setup_status (read-only) and install_hook (consent-gated) end to
 * end through an InMemoryTransport pair — same harness as knowledge-graph.test.
 *
 * Goals:
 *   1. get_setup_status reports needsInstall before, and not after, install.
 *   2. install_hook actually writes .claude/settings.json with our hook entry,
 *      and is idempotent on a second call.
 *   3. install_hook carries the requiresConsent annotation (mutation gate).
 *   4. SECURITY: install_hook refuses a repo outside preferences.parentDir.
 *   5. No active repo → a clean NO-DATA reason, never a throw.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { promises as fs, mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createMcpServer } from '../../src/mcp/server.js'

const BLAST_ROOT = '/opt/blastradius'

let parentDir, repo, outsideRepo, logDir

beforeEach(() => {
  parentDir = mkdtempSync(join(tmpdir(), 'br-mcp-setup-'))
  logDir = join(parentDir, '.logs')
  repo = join(parentDir, 'myrepo')
  mkdirSync(join(repo, '.git'), { recursive: true }) // getHookStatus requires a .git marker
  outsideRepo = mkdtempSync(join(tmpdir(), 'br-mcp-outside-'))
  mkdirSync(join(outsideRepo, '.git'), { recursive: true })
})
afterEach(() => {
  for (const d of [parentDir, outsideRepo]) { try { rmSync(d, { recursive: true, force: true }) } catch {} }
})

function deps({ repoPath = repo, currentRepo = repo, parent = parentDir } = {}) {
  return {
    getRepoContext: () => (repoPath ? { repoPath } : null),
    eventStore: { getEvents: () => [], getEventsForRepo: () => [], listDaysWithActivity: async () => [] },
    iterationMarker: { get: () => null, getIso: () => null },
    preferences: { get: () => ({ currentRepo, parentDir: parent, needsSetup: false }) },
    repoDetector: () => null,
    depth: 2,
    appVersion: '1.0.0-test',
    knowledgeStore: { setNodeSummary: async () => ({}) },
    logDir,
    blastRadiusRoot: BLAST_ROOT,
  }
}

async function connect(d) {
  const server = createMcpServer(d)
  const [ct, st] = InMemoryTransport.createLinkedPair()
  await server.connect(st)
  const client = new Client({ name: 'test', version: '1.0.0' })
  await client.connect(ct)
  return client
}

const payload = (res) => res.structuredContent ?? JSON.parse(res.content[0].text)

describe('MCP setup tools (rc9.19)', () => {
  it('install_hook is a non-destructive mutation (consent hints); get_setup_status is read-only', async () => {
    // The MCP SDK strips non-standard annotation fields, so `requiresConsent`
    // does not survive the wire — it stays as documentation in tools.js. What
    // MCP clients actually gate on is readOnlyHint:false + destructiveHint:false
    // (same pattern as set_node_summary).
    const client = await connect(deps())
    const { tools } = await client.listTools()
    const install = tools.find((t) => t.name === 'install_hook')
    const status = tools.find((t) => t.name === 'get_setup_status')
    expect(install).toBeTruthy()
    expect(install.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    })
    expect(status.annotations?.readOnlyHint).toBe(true)
  })

  it('get_setup_status reports needsInstall=true before install', async () => {
    const client = await connect(deps())
    const res = payload(await client.callTool({ name: 'get_setup_status', arguments: {} }))
    expect(res.ok).toBe(true)
    expect(res.activeRepo).toBe(repo)
    expect(res.hookInstalled).toBe(false)
    expect(res.needsInstall).toBe(true)
    expect(res.serverLogDir).toBe(logDir)
  })

  it('install_hook writes the hook, is idempotent, and flips status to installed', async () => {
    const client = await connect(deps())

    const first = payload(await client.callTool({ name: 'install_hook', arguments: {} }))
    expect(first.ok).toBe(true)
    expect(first.action).toBe('created')

    // Disk check: settings.json now has our PostToolUse hook.
    const raw = await fs.readFile(join(repo, '.claude', 'settings.json'), 'utf8')
    const settings = JSON.parse(raw)
    expect(settings.hooks.PostToolUse[0].matcher).toBe('Edit|Write|Read')
    expect(settings.hooks.PostToolUse[0].hooks[0].command).toMatch(/log-touch\.js/)

    // Idempotent: a second install is a no-op.
    const second = payload(await client.callTool({ name: 'install_hook', arguments: {} }))
    expect(second.ok).toBe(true)
    expect(second.action).toBe('noop')

    // Status now reports installed.
    const status = payload(await client.callTool({ name: 'get_setup_status', arguments: {} }))
    expect(status.hookInstalled).toBe(true)
    expect(status.needsInstall).toBe(false)
  })

  it('SECURITY: install_hook refuses a repo outside parentDir (and writes nothing)', async () => {
    const client = await connect(deps({ repoPath: outsideRepo, currentRepo: outsideRepo }))
    const res = payload(await client.callTool({ name: 'install_hook', arguments: {} }))
    expect(res.ok).toBe(false)
    expect(res.reason).toBe('repo_outside_parent_dir')
    const exists = await fs.access(join(outsideRepo, '.claude', 'settings.json')).then(() => true).catch(() => false)
    expect(exists).toBe(false)
  })

  it('no active repo → clean NO-DATA reasons, never a throw', async () => {
    const client = await connect(deps({ repoPath: null, currentRepo: null }))
    const status = payload(await client.callTool({ name: 'get_setup_status', arguments: {} }))
    expect(status.activeRepo).toBeNull()
    expect(status.reason).toBe('no_active_repo')
    const install = payload(await client.callTool({ name: 'install_hook', arguments: {} }))
    expect(install.ok).toBe(false)
    expect(install.reason).toBe('no_active_repo')
  })
})
