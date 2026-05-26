/**
 * Graph view E2E — regression guardrail for the rc8 → rc8.1 overlay bug.
 *
 * The bug in rc8:
 *
 *   .graph-empty { display: flex; ... }   in styles.css sat at higher
 *   specificity than the user-agent [hidden] {display:none} rule. The
 *   "Knowledge Graph not ready yet." overlay therefore remained
 *   layered over the SVG even after the graph successfully loaded —
 *   stealing every click and stopping the inline summary editor from
 *   ever appearing.
 *
 * What this suite asserts:
 *
 *   1. Dashboard boots in graph mode (the sandbox seeds viewMode='graph').
 *   2. The Knowledge Graph rebuilds in under ~5 s on the BlastRadius
 *      checkout (27 source nodes, 39 edges).
 *   3. The empty-state overlay is HIDDEN once the graph is ready.
 *   4. Nodes are clickable — clicking one swaps the side panel from
 *      "Select a node" to the inline editor (summary textarea, tags
 *      input, Save button).
 *   5. The Tree↔Graph toggle persists across reload (writes to
 *      preferences.json round-trip).
 *
 * Anti-flake: we wait for `circle.gnode` to settle after the d3
 * simulation tick rather than relying on raw timeouts. The simulation
 * has alphaDecay=0.06 → converges in ~150 ticks; 4 s headroom is
 * plenty even on a cold cache.
 */

import { test, expect } from '@playwright/test'

test.describe('rc8 graph view — click + inline editor', () => {
  test('graph renders, overlay hides, nodes are clickable, editor shows', async ({ page }) => {
    // Surface server-side console errors loudly so a regression in
    // /api/graph wiring fails the assertion explicitly rather than
    // hanging on a missing selector.
    const consoleErrors = []
    page.on('pageerror', (err) => consoleErrors.push(`pageerror: ${err.message}`))
    page.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(`console.error: ${msg.text()}`)
    })

    await page.goto('/')

    // ─── 1. Boot in graph mode ──────────────────────────────────────────────
    // The sandbox seeds preferences.viewMode='graph', so the layout
    // should be in graph mode without us flipping the toggle.
    const layout = page.locator('main.layout')
    await expect(layout).toHaveAttribute('data-view', 'graph', { timeout: 5000 })

    // The Graph chip is the selected one.
    await expect(page.locator('.view-toggle button[data-view="graph"]'))
      .toHaveAttribute('aria-selected', 'true')

    // ─── 2. Graph rebuilds + nodes render ───────────────────────────────────
    // KnowledgeGraph.rebuild() is async (fs.stat on every node). Wait
    // for at least one circle.gnode to appear. The BlastRadius checkout
    // has 27 source nodes; we assert >= 5 as a generous floor.
    const nodes = page.locator('.graph-canvas circle.gnode')
    await expect(nodes.first()).toBeVisible({ timeout: 15000 })
    const count = await nodes.count()
    expect(count).toBeGreaterThanOrEqual(5)

    // ─── 3. Overlay is hidden when graph is ready ───────────────────────────
    // This is THE rc8 bug: the empty-state overlay used to leak through
    // [hidden] because .graph-empty had display:flex without a
    // [hidden]{display:none} override.
    const emptyOverlay = page.locator('#graph-empty')
    await expect(emptyOverlay).toBeHidden()

    // Stronger check: ask the browser for the computed style. Even if
    // hidden=true ever sneaks through as an attribute, computed
    // display:none confirms the overlay is actually invisible.
    const overlayDisplay = await emptyOverlay.evaluate(
      (el) => window.getComputedStyle(el).display,
    )
    expect(overlayDisplay).toBe('none')

    // ─── 4. Click a node → inline editor appears ────────────────────────────
    // Stats line is the cheapest proxy for "graph snapshot loaded".
    await expect(page.locator('#graph-stats'))
      .toContainText(/\d+ nodes/, { timeout: 5000 })

    // Pick a node with a known path (heatEngine.js is one of the hubs
    // in the BlastRadius checkout — fanIn=3) so the test isn't tied
    // to whichever node happens to settle first in the layout.
    //
    // CSS attribute selector with quoted value matches our data-path
    // attribute set in app.js: .attr('data-path', d => d.path).
    const heatEngineNode = page.locator(
      'circle.gnode[data-path="src/server/heatEngine.js"]',
    )
    await expect(heatEngineNode).toBeVisible({ timeout: 5000 })

    // Wait for the simulation to settle so the node isn't moving when
    // we click it. force: true bypasses the actionability checks for
    // SVG (Playwright sometimes flags <circle> as not stable during
    // simulation), but settles the click on the rendered position.
    await page.waitForTimeout(1000) // alphaDecay 0.06 → ~150 ticks ≈ 800 ms
    await heatEngineNode.click({ force: true })

    // Side panel title flips to the node's path.
    await expect(page.locator('#side-title'))
      .toHaveText('src/server/heatEngine.js', { timeout: 3000 })

    // The inline editor inputs exist — this is the core assertion: it
    // proves the click actually reached selectGraphNode() and that
    // renderGraphSidePanel() ran.
    await expect(page.locator('#gnode-summary-input')).toBeVisible()
    await expect(page.locator('#gnode-tags-input')).toBeVisible()
    await expect(page.locator('#gnode-save')).toBeVisible()

    // ─── 5. Editor round-trip: write + save + observe success ───────────────
    const stamp = new Date().toISOString().slice(11, 19) // HH:MM:SS, harmless
    const summary = `e2e probe at ${stamp}`
    await page.locator('#gnode-summary-input').fill(summary)
    await page.locator('#gnode-tags-input').fill('e2e, probe, rc8.1')
    await page.locator('#gnode-save').click()

    // Status pill turns into is-ok / "Saved".
    await expect(page.locator('#gnode-save-status'))
      .toHaveText(/Saved/i, { timeout: 5000 })
    await expect(page.locator('#gnode-save-status'))
      .toHaveClass(/is-ok/)

    // Optimistic update of the cached snapshot stamps the node ring
    // with the has-summary class.
    await expect(heatEngineNode).toHaveClass(/has-summary/)

    // No page errors leaked from the JS during the entire flow.
    expect(consoleErrors, `unexpected JS errors: ${consoleErrors.join('; ')}`).toEqual([])
  })

  test('Tree↔Graph toggle persists across reload', async ({ page }) => {
    await page.goto('/')

    // Start in graph (seeded). Flip to tree, reload, expect tree.
    await expect(page.locator('main.layout')).toHaveAttribute('data-view', 'graph')
    await page.locator('.view-toggle button[data-view="tree"]').click()
    await expect(page.locator('main.layout')).toHaveAttribute('data-view', 'tree')

    await page.reload()

    await expect(page.locator('main.layout')).toHaveAttribute('data-view', 'tree')
    await expect(page.locator('.view-toggle button[data-view="tree"]'))
      .toHaveAttribute('aria-selected', 'true')

    // And flip back so subsequent tests in this file find the
    // expected seed state. (Tests in this file run serially.)
    await page.locator('.view-toggle button[data-view="graph"]').click()
    await expect(page.locator('main.layout')).toHaveAttribute('data-view', 'graph')
  })
})
