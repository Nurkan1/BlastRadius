/**
 * Resizable panels E2E (rc8.6).
 *
 * The dashboard's right rail (file-detail "side panel" + iteration panel)
 * used to be a fixed 320px / 280px. rc8.6 makes the boundaries draggable
 * via thin gutters anchored to the grid; the chosen width lives in a CSS
 * custom property on .layout and is persisted to localStorage so it
 * survives a reload.
 *
 * What this suite asserts:
 *   1. Dragging the side gutter left widens the side panel and the new
 *      width is written to localStorage.
 *   2. The width is restored after a full page reload.
 *   3. Keyboard arrows nudge the width (accessibility — the gutter is a
 *      focusable role=separator).
 *
 * Default Playwright viewport is 1280×720, comfortably above the 800px
 * responsive breakpoint, so the gutters are active (they're hidden in the
 * stacked narrow layout).
 */

import { test, expect } from '@playwright/test'

test.describe('rc8.6 resizable panels', () => {
  test('dragging the side gutter widens the panel and persists across reload', async ({ page }) => {
    const consoleErrors = []
    page.on('pageerror', (err) => consoleErrors.push(`pageerror: ${err.message}`))

    await page.goto('/')

    const side = page.locator('.side-panel')
    await expect(side).toBeVisible()
    const before = (await side.boundingBox()).width

    const gutter = page.locator('.panel-resizer[data-resizes="side"]')
    await expect(gutter).toBeVisible()
    const box = await gutter.boundingBox()
    const cx = box.x + box.width / 2
    const cy = box.y + box.height / 2

    // Drag the gutter LEFT by 100px → the side panel (to its right) grows.
    await page.mouse.move(cx, cy)
    await page.mouse.down()
    await page.mouse.move(cx - 100, cy, { steps: 10 })
    await page.mouse.up()

    const after = (await side.boundingBox()).width
    // Grew meaningfully (allow slack for pointer-capture rounding).
    expect(after).toBeGreaterThan(before + 50)

    // Persisted to localStorage.
    const stored = await page.evaluate(() => localStorage.getItem('blastradius:sideWidth'))
    expect(Number(stored)).toBeGreaterThan(before + 50)

    // Restored on reload (within a pixel or two).
    await page.reload()
    const restored = (await page.locator('.side-panel').boundingBox()).width
    expect(Math.abs(restored - after)).toBeLessThan(8)

    expect(consoleErrors, `unexpected JS errors: ${consoleErrors.join('; ')}`).toEqual([])
  })

  test('gutters align with the panel boundaries when the iteration panel is open', async ({ page }) => {
    // Regression guard: with the iter panel OPEN (3-column layout) the
    // side gutter must sit on the main|side boundary and the iter gutter
    // on the side|iter boundary. An earlier rc8.6 build had the two
    // `right:` offsets swapped, so a gutter floated mid-panel as a stray
    // cyan line. Each gutter's centre must coincide with the left edge of
    // the panel it resizes.
    await page.goto('/')
    await page.locator('#toggle-iter-panel').click()
    await expect(page.locator('main.layout')).toHaveAttribute('data-iter-open', 'true')

    const iterPanel = page.locator('#iter-panel')
    await expect(iterPanel).toBeVisible()

    const sideBox = await page.locator('.side-panel').boundingBox()
    const iterBox = await iterPanel.boundingBox()
    const sideGutter = await page.locator('.panel-resizer[data-resizes="side"]').boundingBox()
    const iterGutter = await page.locator('.panel-resizer[data-resizes="iter"]').boundingBox()

    const centre = (b) => b.x + b.width / 2
    // Side gutter centred on the side panel's left edge (main|side).
    expect(Math.abs(centre(sideGutter) - sideBox.x)).toBeLessThan(6)
    // Iter gutter centred on the iter panel's left edge (side|iter).
    expect(Math.abs(centre(iterGutter) - iterBox.x)).toBeLessThan(6)
  })

  test('keyboard arrows nudge the side panel width (a11y)', async ({ page }) => {
    await page.goto('/')
    const side = page.locator('.side-panel')
    await expect(side).toBeVisible()
    const start = (await side.boundingBox()).width

    const gutter = page.locator('.panel-resizer[data-resizes="side"]')
    await gutter.focus()
    // ArrowLeft = wider (matches the drag direction). Two presses ≈ +32px.
    await gutter.press('ArrowLeft')
    await gutter.press('ArrowLeft')
    const wider = (await side.boundingBox()).width
    expect(wider).toBeGreaterThan(start)

    // End jumps to the minimum width.
    await gutter.press('End')
    const min = (await side.boundingBox()).width
    expect(min).toBeLessThan(wider)
  })
})
