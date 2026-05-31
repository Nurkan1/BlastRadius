/**
 * System dashboard E2E (rc9.20). Routes mocked. Asserts the meta-observability
 * panel renders its three panes (health, console, MCP stats), colours lines by
 * level, streams a live SSE `system-log` entry, and filters by level + text.
 */

import { test, expect } from '@playwright/test'

const HEALTH = {
  ok: true,
  pid: 4242,
  nodeVersion: 'v20.11.0',
  platform: 'win32',
  uptimeSec: 3725, // 1h 2m 5s
  startedAtMs: 1000,
  memory: { rss: 120 * 1024 * 1024, heapUsed: 40 * 1024 * 1024, heapTotal: 60 * 1024 * 1024, external: 0, arrayBuffers: 0 },
  mcp: { byName: [{ key: 'get_iteration_summary', count: 9 }, { key: 'install_hook', count: 1 }], totals: {} },
  mcpRateLimiter: { maxTokens: 100, refillTokens: 30, refillIntervalMs: 1000, activeBuckets: 1, minTokens: 97 },
}

const LOGS = {
  source: 'file',
  entries: [
    { level: 30, time: 1780000000000, component: 'graphResolver', msg: 'graph rebuilt' },
    { level: 40, time: 1780000001000, component: 'mcpServer', msg: 'mcp rate-limited' },
    { level: 50, time: 1780000002000, component: 'watcher', msg: 'tree watcher error', err: 'Error: EPERM: operation not permitted, watch' },
  ],
}

async function openPanel(page) {
  await page.route('**/api/system/health', (r) => r.fulfill({ json: HEALTH }))
  await page.route('**/api/system/logs**', (r) => r.fulfill({ json: LOGS }))
  await page.goto('/')
  await page.locator('#toggle-system').click()
  await expect(page.locator('#system-modal')).toBeVisible({ timeout: 6000 })
}

test.describe('rc9.20 System dashboard', () => {
  test('renders health, MCP rate-limiter and per-tool stats', async ({ page }) => {
    await openPanel(page)
    await expect(page.locator('[data-sysmetric="uptime"]')).toContainText('1h 2m 5s')
    await expect(page.locator('[data-sysmetric="rss"]')).toContainText('120')
    await expect(page.locator('[data-sysmetric="node"]')).toContainText('v20.11.0')
    await expect(page.locator('[data-sysrl="tokens"]')).toContainText('97 / 100')
    // MCP per-tool stats (right pane).
    const mcp = page.locator('#system-mcp-list')
    await expect(mcp).toContainText('get_iteration_summary')
    await expect(mcp).toContainText('install_hook')
  })

  test('console shows initial lines coloured by level', async ({ page }) => {
    await openPanel(page)
    const lines = page.locator('#system-console .system-log-line')
    await expect(lines).toHaveCount(3)
    await expect(page.locator('.system-log-line[data-level="info"]')).toContainText('graph rebuilt')
    await expect(page.locator('.system-log-line[data-level="warn"]')).toContainText('mcp rate-limited')
    // The error line shows BOTH the message and the err detail (rc9.20 polish).
    const errLine = page.locator('.system-log-line[data-level="error"]')
    await expect(errLine).toContainText('tree watcher error')
    await expect(errLine).toContainText('EPERM: operation not permitted')
  })

  test('streams a live system-log entry over SSE', async ({ page }) => {
    await openPanel(page)
    // Dispatch a synthetic SSE event on the shared EventSource.
    await page.evaluate(() => {
      const sse = window.__blastradiusSse
      sse.dispatchEvent(new MessageEvent('system-log', {
        data: JSON.stringify({ level: 50, time: Date.now(), component: 'liveTest', msg: 'streamed live' }),
      }))
    })
    await expect(page.locator('#system-console')).toContainText('streamed live')
    await expect(page.locator('.system-log-line[data-level="error"]', { hasText: 'streamed live' })).toBeVisible()
  })

  test('filters by level and by text', async ({ page }) => {
    await openPanel(page)
    // Level filter: only error.
    await page.locator('.system-level-btn[data-level="error"]').click()
    await expect(page.locator('#system-console .system-log-line')).toHaveCount(1)
    await expect(page.locator('#system-console')).toContainText('tree watcher error')
    // Back to all, then text filter by component.
    await page.locator('.system-level-btn[data-level="all"]').click()
    await page.locator('#system-console-filter').fill('graphResolver')
    await expect(page.locator('#system-console .system-log-line')).toHaveCount(1)
    await expect(page.locator('#system-console')).toContainText('graph rebuilt')
  })

  test('full-screen toggle expands the card and persists across reopen', async ({ page }) => {
    await openPanel(page)
    const card = page.locator('#system-modal')
    await expect(card).not.toHaveClass(/is-fullscreen/)
    await page.locator('#system-fullscreen').click()
    await expect(card).toHaveClass(/is-fullscreen/)
    // Close + reopen → preference persisted (localStorage).
    await page.locator('#system-modal-close').click()
    await expect(page.locator('#system-modal')).toBeHidden()
    await page.locator('#toggle-system').click()
    await expect(page.locator('#system-modal')).toHaveClass(/is-fullscreen/)
  })

  test('Alt+S toggles the panel; Escape closes it', async ({ page }) => {
    await page.route('**/api/system/health', (r) => r.fulfill({ json: HEALTH }))
    await page.route('**/api/system/logs**', (r) => r.fulfill({ json: LOGS }))
    await page.goto('/')
    await page.keyboard.press('Alt+s')
    await expect(page.locator('#system-modal')).toBeVisible({ timeout: 6000 })
    await page.keyboard.press('Escape')
    await expect(page.locator('#system-modal')).toBeHidden()
  })
})
