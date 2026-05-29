/**
 * AI assistant modal E2E (rc9.0).
 *
 * The chat talks to a local Ollama via our server proxy. To keep the test
 * deterministic (CI may not have Ollama running), we intercept /api/ai/*
 * with Playwright route mocks. We assert the UI contract:
 *   1. The header button opens the modal and the model selector populates.
 *   2. Sending a message renders the user bubble + the assistant reply.
 *   3. When Ollama is down (available:false), the panel says so and
 *      disables sending.
 */

import { test, expect } from '@playwright/test'

test.describe('rc9.0 AI assistant modal', () => {
  test('opens, lists models, and renders a chat round-trip', async ({ page }) => {
    await page.route('**/api/ai/models', (route) =>
      route.fulfill({ json: { available: true, models: [{ name: 'llama3' }, { name: 'qwen2.5' }] } }),
    )
    await page.route('**/api/ai/chat', (route) =>
      route.fulfill({ json: { message: { role: 'assistant', content: 'Claro, puedo ayudarte con eso.' } } }),
    )

    await page.goto('/')
    await page.locator('#toggle-ai').click()

    const modal = page.locator('#ai-modal')
    await expect(modal).toBeVisible()

    // Model selector populated from /api/ai/models.
    const select = page.locator('#ai-model')
    await expect(select.locator('option')).toHaveCount(2)
    await expect(select).toBeEnabled()

    // Send a message → user bubble + assistant reply appear.
    await page.locator('#ai-input').fill('¿Qué hago primero?')
    await page.locator('#ai-send').click()

    await expect(page.locator('.ai-msg-user .ai-msg-body')).toContainText('¿Qué hago primero?')
    await expect(page.locator('.ai-msg-assistant .ai-msg-body').last())
      .toContainText('Claro, puedo ayudarte con eso.', { timeout: 5000 })
  })

  test('reports Ollama not running and disables sending', async ({ page }) => {
    await page.route('**/api/ai/models', (route) =>
      route.fulfill({ json: { available: false, models: [], error: 'Ollama is not reachable on 127.0.0.1:11434' } }),
    )

    await page.goto('/')
    await page.locator('#toggle-ai').click()
    await expect(page.locator('#ai-modal')).toBeVisible()

    await expect(page.locator('.ai-notice')).toContainText(/not reachable|not running/i)
    await expect(page.locator('#ai-send')).toBeDisabled()
  })
})
