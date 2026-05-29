/**
 * Report export "Print / PDF" E2E (rc8.6).
 *
 * The desktop Tauri WebView2 shell blocks window.open('_blank') AND
 * cross-frame contentWindow access, and the server CSP blocks inline
 * iframe scripts — so every iframe/popup print path failed silently in
 * the .exe. The robust fix renders the report as REAL DOM inside an
 * in-app modal and prints via the main window's own window.print() (an
 * @media print rule isolates the report).
 *
 * What this asserts (headless-safe — window.print() is a no-op in
 * headless Chromium):
 *   1. "Print / PDF" opens the in-app #report-modal and injects the
 *      report fragment (the .br-report panel) — no iframe, no popup.
 *   2. window.open is never used.
 *   3. The modal's "Print / Save as PDF" button calls window.print().
 *
 * The export controls live in the iteration panel, so we open it first.
 */

import { test, expect } from '@playwright/test'

test.describe('rc8.6 report export — in-app modal + print', () => {
  test('opens the report modal with the report content (no popup/iframe)', async ({ page }) => {
    await page.addInitScript(() => {
      window.__openCalls = 0
      window.open = function () { window.__openCalls += 1; return null }
    })

    await page.goto('/')
    await page.locator('#toggle-iter-panel').click()
    await expect(page.locator('main.layout')).toHaveAttribute('data-iter-open', 'true')

    const printBtn = page.locator('#export-html')
    await expect(printBtn).toBeVisible()
    await printBtn.click()

    // The in-app modal opens and the report fragment is injected as DOM.
    const modal = page.locator('#report-modal')
    await expect(modal).toBeVisible()
    await expect(page.locator('#report-modal-body .br-report')).toBeVisible({ timeout: 5000 })
    await expect(page.locator('#report-modal-body')).toContainText('BlastRadius Report')

    // No iframe was used and window.open was never called.
    await expect(page.locator('#report-modal-body iframe')).toHaveCount(0)
    expect(await page.evaluate(() => window.__openCalls)).toBe(0)
  })

  test('the modal Print button calls window.print()', async ({ page }) => {
    await page.addInitScript(() => {
      window.__printCalls = 0
      window.print = function () { window.__printCalls += 1 }
    })

    await page.goto('/')
    await page.locator('#toggle-iter-panel').click()
    await page.locator('#export-html').click()
    await expect(page.locator('#report-modal-body .br-report')).toBeVisible({ timeout: 5000 })

    await page.locator('#report-print').click()
    expect(await page.evaluate(() => window.__printCalls)).toBeGreaterThan(0)
  })

  test('the report modal honors the active filters', async ({ page }) => {
    await page.goto('/')
    await page.locator('#toggle-iter-panel').click()
    // Narrow to a single agent, then export.
    await page.locator('.platform-toggle button[data-platform="claude"]').click()
    await page.locator('#export-html').click()

    await expect(page.locator('#report-modal-body .br-report')).toBeVisible({ timeout: 5000 })
    // rc9.4 canonicalizes the agent filter to its display label, so the
    // report header reads "Claude", not the lowercase button value.
    await expect(page.locator('#report-modal-body')).toContainText('Agent: Claude')
  })
})
