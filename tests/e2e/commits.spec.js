/**
 * Commit investigation modal E2E (rc9.11).
 *
 * Routes are mocked so the test is deterministic. We assert the UI contract:
 * the toggle opens the modal, commits render, selecting one shows its files,
 * and clicking a file opens the diff modal pinned to that commit's sha.
 */

import { test, expect } from '@playwright/test'

const SHA = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678'

test.describe('rc9.11 commit investigation modal', () => {
  test('lists commits, shows a commit\'s files, and opens a pinned diff', async ({ page }) => {
    await page.route('**/api/commits?*', (route) =>
      route.fulfill({ json: { commits: [
        { sha: SHA, shortSha: 'a1b2c3d', subject: 'feat: add the thing', author: 'Nur', date: '2026-05-29T10:00:00Z' },
      ] } }),
    )
    await page.route(`**/api/commits/${SHA}/files`, (route) =>
      route.fulfill({ json: { sha: SHA, files: [
        { path: 'src/server/routes.js', status: 'M' },
        { path: 'src/new-thing.js', status: 'A' },
      ] } }),
    )
    // The diff fetch for the clicked file, pinned to the commit.
    let diffUrl = null
    await page.route('**/api/diff?*', (route) => {
      diffUrl = route.request().url()
      route.fulfill({ json: { html: '<div class="d2h">pinned diff</div>', patch: '', stats: { added: 3, deleted: 1 }, empty: false, truncated: false, source: 'commit', shortSha: 'a1b2c3d' } })
    })

    await page.goto('/')
    await page.locator('#toggle-commits').click()
    await expect(page.locator('#commits-modal')).toBeVisible()

    // Commit renders; click it → its files appear.
    await expect(page.locator('.commit-item')).toHaveCount(1)
    await page.locator('.commit-item').first().click()
    await expect(page.locator('.commit-file')).toHaveCount(2)
    await expect(page.locator('.commit-file-path').first()).toHaveText('src/server/routes.js')

    // Click a file → the diff modal opens, scoped to this commit's sha.
    await page.locator('.commit-file').first().click()
    await expect(page.locator('#diff-modal')).toBeVisible()
    await expect(page.locator('#diff-modal-body')).toContainText('pinned diff', { timeout: 5000 })
    // rc9.11: the diff is requested as commit=<sha> (what that commit changed,
    // sha^..sha), not against=<sha> (sha..working-tree).
    expect(diffUrl).toContain(`commit=${SHA}`)
  })

  test('reports no active repo gracefully', async ({ page }) => {
    await page.route('**/api/commits?*', (route) =>
      route.fulfill({ status: 503, json: { error: 'no_active_repo', needsSetup: true } }),
    )
    await page.goto('/')
    await page.locator('#toggle-commits').click()
    await expect(page.locator('#commits-list')).toContainText(/no active repo/i)
  })
})
