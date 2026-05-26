/**
 * Help modal E2E — keep the in-app catalog in sync with the MCP surface.
 *
 * The motivating drift (rc8.2): the in-app Help modal had been
 * documenting only the 4 Phase-1 tools + 6 resources since rc4,
 * silently outdated as rc7 added `list_days_with_activity` and rc8
 * added 5 graph tools + 4 graph resources. The first user to open
 * Ctrl+/ saw a stale catalog and (correctly) called it out.
 *
 * Strategy: query the live MCP server for the authoritative set of
 * tools + resources, then assert each name appears verbatim under
 * the Help modal's "Tools & Resources" tab. Any future addition that
 * forgets to update the Help markup fails here BEFORE shipping.
 *
 * We deliberately use `listTools()` / `listResources()` shape, not
 * a hand-maintained whitelist in the test — that would just replace
 * one source of drift with another.
 */

import { test, expect } from '@playwright/test'

const PORT = process.env.PLAYWRIGHT_BR_PORT || '43020'
const MCP_URL = `http://localhost:${PORT}/mcp`

/** The BlastRadius MCP transport runs in **stateless mode**
 *  (`sessionIdGenerator: undefined` in src/mcp/transport-http.js),
 *  so each request stands alone — no session handshake, no
 *  initialized notification required. We still send a single
 *  initialize call to be polite and pick up the negotiated
 *  protocol version, then issue the list call independently. */
async function mcpCall(method, params = {}) {
  // Hit the server directly with the listing call. In stateless
  // mode the SDK accepts tools/list and resources/list without a
  // prior initialize handshake on the same connection.
  const res = await fetch(MCP_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/event-stream',
      'MCP-Protocol-Version': '2024-11-05',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  })
  const text = await res.text()
  // SSE-framed responses come as `event: message\ndata: {…}`.
  // Extract the JSON payload from the first `data:` line. (The SDK
  // currently emits one frame per response in stateless mode.)
  const m = text.match(/^data:\s*(\{.*\})\s*$/m)
  if (!m) {
    throw new Error(
      `unexpected MCP response shape (status ${res.status}): ${text.slice(0, 300)}`,
    )
  }
  const parsed = JSON.parse(m[1])
  if (parsed.error) throw new Error(`MCP error on ${method}: ${parsed.error.message}`)
  return parsed.result
}

test.describe('Help modal — catalog stays in sync with live MCP surface', () => {
  test('every registered tool appears in the Tools & Resources tab', async ({ page }) => {
    // 1. Get the authoritative tool list from the running server.
    const { tools } = await mcpCall('tools/list')
    const toolNames = tools.map((t) => t.name).sort()
    expect(toolNames.length).toBeGreaterThanOrEqual(5) // sanity

    // 2. Open the dashboard and the Help modal.
    await page.goto('/')
    await page.locator('#toggle-help').click()
    await expect(page.locator('#help-modal')).toBeVisible()

    // Switch to the "Tools & Resources" tab.
    await page.locator('.help-tab[data-help-tab="surface"]').click()
    await expect(page.locator('.help-tabpanel[data-help-panel="surface"]')).toBeVisible()

    // 3. Grab the rendered Tools-section text and assert every live
    //    tool name shows up. We scope to the surface panel so we
    //    don't accidentally pass on a tool name mentioned in Sample
    //    Prompts but missing from the actual table.
    const surfaceText = await page
      .locator('.help-tabpanel[data-help-panel="surface"]')
      .innerText()

    for (const name of toolNames) {
      expect(
        surfaceText,
        `Help modal "Tools & Resources" tab is missing the tool "${name}" — ` +
        `it's registered on the MCP server but not documented in src/public/index.html.`,
      ).toContain(name)
    }
  })

  test('every registered resource appears in the Tools & Resources tab', async ({ page }) => {
    const { resources } = await mcpCall('resources/list')
    const resourceUris = resources.map((r) => r.uri).sort()
    expect(resourceUris.length).toBeGreaterThanOrEqual(5)

    await page.goto('/')
    await page.locator('#toggle-help').click()
    await page.locator('.help-tab[data-help-tab="surface"]').click()

    const surfaceText = await page
      .locator('.help-tabpanel[data-help-panel="surface"]')
      .innerText()

    for (const uri of resourceUris) {
      expect(
        surfaceText,
        `Help modal "Tools & Resources" tab is missing the resource "${uri}" — ` +
        `it's exposed by the MCP server but not documented.`,
      ).toContain(uri)
    }

    // The templated heat resource lives under listResourceTemplates,
    // not listResources. Assert it explicitly since users still expect
    // it documented.
    expect(surfaceText).toContain('blastradius://heat/{window}')
  })

  test('Sample Prompts tab includes at least one Knowledge Graph prompt', async ({ page }) => {
    // Soft guard against forgetting to teach users about new tools
    // when a Knowledge-Graph-class surface ships. The check is
    // intentionally loose — any mention of a graph-specific tool
    // name counts — to keep this from breaking on prose tweaks.
    await page.goto('/')
    await page.locator('#toggle-help').click()
    await page.locator('.help-tab[data-help-tab="prompts"]').click()

    const promptsText = await page
      .locator('.help-tabpanel[data-help-panel="prompts"]')
      .innerText()

    const anyGraphPromptPresent = [
      'get_codebase_graph',
      'get_nearest_neighbors',
      'describe_node',
      'find_nodes',
      'set_node_summary',
      'blastradius://graph/',
    ].some((needle) => promptsText.includes(needle))

    expect(
      anyGraphPromptPresent,
      'Sample Prompts tab does not reference any Knowledge Graph tool or resource. ' +
      'When rc8+ tools ship, add at least one example prompt so users know to try them.',
    ).toBe(true)
  })
})
