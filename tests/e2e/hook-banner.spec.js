/**
 * Hook-banner E2E — rc8.4.
 *
 * Goal: when the dashboard switches to a repo that does NOT have
 * .claude/settings.json with the BlastRadius PostToolUse hook,
 * a banner appears under the topbar offering one-click activation.
 *
 * Both scenarios use a fixture repo created inside a tmpdir, with
 * `.git/` to satisfy the repo detector but WITHOUT `.claude/` so
 * the hook is missing.
 *
 * State management — the playwright webServer is shared across all
 * spec files. We mutate parentDir + currentRepo via the REST API
 * for the duration of these tests, and restore them in afterAll so
 * subsequent runs of graph-view.spec / help-modal.spec see the
 * sandbox they expect.
 */

import { test, expect } from '@playwright/test'
import { promises as fs, mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve as resolvePath } from 'node:path'

const PORT = process.env.PLAYWRIGHT_BR_PORT || '43020'
const API = `http://localhost:${PORT}`

let originalPrefs = null
let fixtureParent = null
let fixtureRepo = null

test.beforeAll(async () => {
  // Snapshot whatever the playwright.config.js seeded so we can
  // restore it at the end.
  const res = await fetch(`${API}/api/preferences`)
  originalPrefs = await res.json()

  // Fresh fixture repo in a brand-new tmpdir (cross-platform).
  fixtureParent = mkdtempSync(resolvePath(tmpdir(), 'blastradius-hookbanner-'))
  fixtureRepo = join(fixtureParent, 'fakerepo').replace(/\\/g, '/')
  mkdirSync(join(fixtureRepo, '.git'), { recursive: true })

  // Point the running server at the new parent + active repo.
  const r1 = await fetch(`${API}/api/preferences`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      parentDir: fixtureParent.replace(/\\/g, '/'),
      ignoredHookRepos: [],
    }),
  })
  if (!r1.ok) throw new Error(`failed to set parentDir: ${r1.status}`)

  const r2 = await fetch(`${API}/api/repos/select`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: fixtureRepo }),
  })
  if (!r2.ok) throw new Error(`failed to select fixture repo: ${r2.status}`)
})

test.afterAll(async () => {
  // Restore the original sandbox state for the next spec run.
  if (originalPrefs) {
    await fetch(`${API}/api/preferences`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        parentDir: originalPrefs.parentDir,
        ignoredHookRepos: [],
      }),
    }).catch(() => {})
    if (originalPrefs.currentRepo) {
      await fetch(`${API}/api/repos/select`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: originalPrefs.currentRepo }),
      }).catch(() => {})
    }
  }
  if (fixtureParent) {
    try { rmSync(fixtureParent, { recursive: true, force: true }) } catch {}
  }
})

test.describe('rc8.4 — hook auto-install banner', () => {
  test('banner appears for a hook-less repo and "Install now" activates it', async ({ page }) => {
    // Pre-test: clear ignoredHookRepos so the banner is allowed to show.
    await fetch(`${API}/api/preferences`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ignoredHookRepos: [] }),
    })

    await page.goto('/')

    // Banner visible with the repo name.
    const banner = page.locator('#hook-banner')
    await expect(banner).toBeVisible({ timeout: 8000 })
    await expect(page.locator('#hook-banner-repo')).toContainText('fakerepo')

    // Click "Activate" → modal opens.
    await page.locator('#hook-banner-activate').click()
    const modal = page.locator('#hook-modal')
    await expect(modal).toBeVisible()

    // Click "Install now" → POST runs, modal closes, banner disappears.
    await page.locator('#hook-modal-install').click()
    await expect(modal).toBeHidden({ timeout: 5000 })
    await expect(banner).toBeHidden({ timeout: 5000 })

    // Disk check: .claude/settings.json now exists with the BlastRadius hook.
    const raw = await fs.readFile(join(fixtureRepo, '.claude', 'settings.json'), 'utf8')
    const settings = JSON.parse(raw)
    expect(settings.hooks.PostToolUse).toHaveLength(1)
    expect(settings.hooks.PostToolUse[0].matcher).toBe('Edit|Write|Read')
    expect(settings.hooks.PostToolUse[0].hooks[0].command).toMatch(/log-touch\.js/)
  })

  test('"Don\'t show again" persists across reload', async ({ page }) => {
    // Reset disk + prefs so the banner has a reason to appear again.
    try {
      await fs.rm(join(fixtureRepo, '.claude'), { recursive: true, force: true })
    } catch {}
    await fetch(`${API}/api/preferences`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ignoredHookRepos: [] }),
    })

    await page.goto('/')

    const banner = page.locator('#hook-banner')
    await expect(banner).toBeVisible({ timeout: 8000 })

    // Click "Don't show again" → banner hides, preference persists.
    await page.locator('#hook-banner-ignore').click()
    await expect(banner).toBeHidden({ timeout: 5000 })

    // Reload — banner stays hidden (read from preferences.ignoredHookRepos).
    await page.reload()
    await expect(banner).toBeHidden({ timeout: 5000 })

    // Confirm prefs persisted by hitting the API.
    const res = await fetch(`${API}/api/preferences`)
    const prefs = await res.json()
    expect(Array.isArray(prefs.ignoredHookRepos)).toBe(true)
    expect(prefs.ignoredHookRepos.some((p) => p.includes('fakerepo'))).toBe(true)
  })
})
