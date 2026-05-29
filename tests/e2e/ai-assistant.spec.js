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

  test('restores history, shows the advice counter, and "New" resets (rc9.1)', async ({ page }) => {
    const CONV = {
      id: '11111111-1111-4111-8111-111111111111',
      title: 'prev chat',
      updatedAt: 2,
      messageCount: 2,
      messages: [{ role: 'user', content: 'old question' }, { role: 'assistant', content: 'old answer' }],
    }
    await page.route('**/api/ai/models', (r) => r.fulfill({ json: { available: true, models: [{ name: 'llama3' }] } }))
    await page.route('**/api/ai/conversations', (r) => r.fulfill({
      json: { project: 'demo', adviceCount: 2, conversations: [{ id: CONV.id, title: CONV.title, updatedAt: CONV.updatedAt, messageCount: CONV.messageCount }] },
    }))
    await page.route('**/api/ai/conversations/*', (r) => r.fulfill({ json: { conversation: CONV } }))
    await page.route('**/api/ai/chat', (r) => r.fulfill({ json: { message: { role: 'assistant', content: 'new reply' }, conversationId: CONV.id, adviceCount: 3 } }))

    await page.goto('/')
    await page.locator('#toggle-ai').click()
    await expect(page.locator('#ai-modal')).toBeVisible()

    // Most-recent conversation auto-restores into the transcript.
    await expect(page.locator('.ai-msg-assistant .ai-msg-body').last()).toContainText('old answer', { timeout: 5000 })
    // Advice counter shows the per-project total.
    await expect(page.locator('#ai-advice-counter')).toContainText('2 advices')
    // History dropdown carries the saved conversation.
    await expect(page.locator('#ai-history option')).toContainText(['History…', 'prev chat'])

    // "New" clears the transcript back to the hint.
    await page.locator('#ai-new-chat').click()
    await expect(page.locator('.ai-hint')).toBeVisible()
    await expect(page.locator('.ai-msg')).toHaveCount(0)

    // Sending updates the counter from the response.
    await page.locator('#ai-input').fill('hi')
    await page.locator('#ai-send').click()
    await expect(page.locator('.ai-msg-assistant .ai-msg-body').last()).toContainText('new reply', { timeout: 5000 })
    await expect(page.locator('#ai-advice-counter')).toContainText('3 advices')
  })

  test('attaches an image and sends it as base64 (rc9.2 vision)', async ({ page }) => {
    let postedImages = null
    await page.route('**/api/ai/models', (r) => r.fulfill({ json: { available: true, models: [{ name: 'gemma3' }] } }))
    await page.route('**/api/ai/conversations', (r) => r.fulfill({ json: { project: 'demo', adviceCount: 0, conversations: [] } }))
    await page.route('**/api/ai/chat', (route) => {
      const body = route.request().postDataJSON()
      const user = (body.messages || []).filter((m) => m.role === 'user').pop()
      postedImages = user && user.images
      route.fulfill({ json: { message: { role: 'assistant', content: 'a tiny picture' }, conversationId: null, adviceCount: 1 } })
    })

    await page.goto('/')
    await page.locator('#toggle-ai').click()
    await expect(page.locator('#ai-modal')).toBeVisible()

    // A 1×1 PNG, attached through the hidden file input.
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
      'base64',
    )
    await page.locator('#ai-file').setInputFiles({ name: 'red.png', mimeType: 'image/png', buffer: png })
    await expect(page.locator('#ai-thumbs .ai-thumb')).toHaveCount(1)

    await page.locator('#ai-input').fill('what is this?')
    await page.locator('#ai-send').click()

    await expect(page.locator('.ai-msg-assistant .ai-msg-body').last()).toContainText('a tiny picture', { timeout: 5000 })
    // The POST carried the image as base64, and the thumbnails cleared after send.
    expect(Array.isArray(postedImages) && postedImages.length).toBeTruthy()
    await expect(page.locator('#ai-thumbs')).toBeHidden()
    await expect(page.locator('.ai-msg-user .ai-msg-img')).toHaveCount(1)
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
