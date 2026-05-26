/**
 * Vitest config — explicit `tests/e2e/**` exclusion.
 *
 * rc8.1+: with Playwright in the tree, Vitest's default glob would
 * otherwise pick up `tests/e2e/graph-view.spec.js` and try to run
 * it through Vitest's runner, which fails because the imports
 * (@playwright/test) only resolve under the Playwright test process.
 *
 * Everything else stays on Vitest defaults so the existing 434-case
 * suite needs no migration. Use `npm test` for Vitest, `npm run
 * test:e2e` for Playwright.
 */
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    exclude: [
      // Vitest defaults — preserve them when overriding.
      '**/node_modules/**',
      '**/dist/**',
      '**/.{idea,git,cache,output,temp}/**',
      // BlastRadius additions:
      'tests/e2e/**',
      'src-tauri/**',
    ],
  },
})
