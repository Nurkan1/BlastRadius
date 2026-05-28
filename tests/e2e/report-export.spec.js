/**
 * Report export "Print / PDF" E2E (rc8.6).
 *
 * Regression guard for the desktop-app bug: in the Tauri WebView2 shell,
 * window.open('_blank') is blocked, so the old "Print / PDF" button was a
 * silent no-op — nothing opened and the report couldn't be printed from
 * the .exe. The fix renders the printable report into a hidden,
 * same-origin <iframe> and calls its native print dialog, which works in
 * both the browser and the desktop app.
 *
 * What this asserts (headless-safe — window.print() is a no-op in
 * headless Chromium, so it neither hangs nor opens a real dialog):
 *   1. Clicking "Print / PDF" creates a same-origin #print-frame iframe
 *      pointing at /api/report.html (carrying the active filters).
 *   2. window.open is NOT used (it's the thing that fails in WebView2).
 *
 * The export controls live in the iteration panel, so we open it first.
 */

import { test, expect } from '@playwright/test'

test.describe('rc8.6 report export — Print / PDF', () => {
  test('renders into a same-origin print iframe instead of window.open', async ({ page }) => {
    // Count window.open calls; must run before the page scripts load.
    await page.addInitScript(() => {
      window.__openCalls = 0
      window.open = function () { window.__openCalls += 1; return null }
    })

    await page.goto('/')

    // Export controls live in the iteration panel.
    await page.locator('#toggle-iter-panel').click()
    await expect(page.locator('main.layout')).toHaveAttribute('data-iter-open', 'true')

    const printBtn = page.locator('#export-html')
    await expect(printBtn).toBeVisible()
    await printBtn.click()

    // A hidden same-origin iframe pointing at the self-printing report is
    // created (print=1 makes the page invoke window.print() itself).
    const frame = page.locator('#print-frame')
    await expect(frame).toHaveCount(1)
    const src = await frame.getAttribute('src')
    expect(src).toContain('/api/report.html')
    expect(src).toContain('print=1')

    // window.open (the WebView2-incompatible path) was never used.
    expect(await page.evaluate(() => window.__openCalls)).toBe(0)
  })

  test('the print iframe carries the active filters', async ({ page }) => {
    await page.goto('/')
    await page.locator('#toggle-iter-panel').click()
    await expect(page.locator('main.layout')).toHaveAttribute('data-iter-open', 'true')

    // Narrow to a single agent, then export.
    await page.locator('.platform-toggle button[data-platform="claude"]').click()
    await page.locator('#export-html').click()

    const src = await page.locator('#print-frame').getAttribute('src')
    expect(src).toContain('platform=claude')
  })
})
