/**
 * Self-diagnostics banner E2E (rc9.13). Routes mocked. We assert the silent
 * misconfiguration becomes a visible, fixable banner.
 */

import { test, expect } from '@playwright/test'

test.describe('rc9.13 self-diagnostics banner', () => {
  test('surfaces a log-dir mismatch and the Reinstall hook fixes it', async ({ page }) => {
    let fixed = false
    await page.route('**/api/diagnostics', (route) =>
      route.fulfill({ json: fixed ? { repoPath: 'C:/x/repo', checks: [] } : {
        repoPath: 'C:/x/repo',
        checks: [{
          level: 'warn',
          code: 'log_dir_mismatch',
          message: "BlastRadius isn't seeing your activity in this repo.",
          detail: 'The hook writes its logs to "C:/x/repo/logs", but the dashboard reads "C:/x/.blastradius/logs". Reinstall the hook so both use the same folder.',
          fix: 'reinstall_hook',
        }],
      } }),
    )
    await page.route('**/api/repo/install-hook', (route) => { fixed = true; route.fulfill({ json: { ok: true } }) })

    await page.goto('/')
    const banner = page.locator('#diag-banner')
    await expect(banner).toBeVisible({ timeout: 6000 })
    await expect(page.locator('#diag-banner-msg')).toContainText("isn't seeing your activity")
    await expect(page.locator('#diag-banner-detail')).toContainText('.blastradius/logs')

    // One click reinstalls the hook and clears the banner.
    await page.locator('#diag-banner-fix').click()
    await expect(banner).toBeHidden({ timeout: 6000 })
  })

  test('offers "Copy prompt for Claude Code" and copies the repair prompt (rc9.14)', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write'])
    const PROMPT =
      'I use BlastRadius. Please fix its Claude Code hook: open .claude/settings.json ' +
      'and replace the BlastRadius PostToolUse entry whose command contains "log-touch.js" ' +
      'with: node "..." --log-dir "C:/x/.blastradius/logs".'
    await page.route('**/api/diagnostics', (route) =>
      route.fulfill({ json: {
        repoPath: 'C:/x/repo',
        checks: [{
          level: 'warn',
          code: 'log_dir_mismatch',
          message: "BlastRadius isn't seeing your activity in this repo.",
          detail: 'The hook writes to one folder, the dashboard reads another.',
          fix: 'reinstall_hook',
          claudePrompt: PROMPT,
        }],
      } }),
    )

    await page.goto('/')
    const btn = page.locator('#diag-banner-claude')
    await expect(btn).toBeVisible({ timeout: 6000 })

    await btn.click()
    await expect(btn).toContainText('Copied', { timeout: 4000 })

    const clip = await page.evaluate(() => navigator.clipboard.readText())
    expect(clip).toBe(PROMPT)
  })

  test('stays hidden when everything is healthy', async ({ page }) => {
    await page.route('**/api/diagnostics', (route) =>
      route.fulfill({ json: { repoPath: 'C:/x/repo', checks: [] } }),
    )
    await page.goto('/')
    // Give the on-load check time to run, then confirm the banner never shows.
    await page.waitForTimeout(2000)
    await expect(page.locator('#diag-banner')).toBeHidden()
  })
})
