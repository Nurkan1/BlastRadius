/**
 * Playwright config — BlastRadius E2E suite.
 *
 * Scope: validate the dashboard's user-facing surfaces end-to-end
 * (Graph view click → editor) without mocking. The Node server is
 * spawned by Playwright on a non-default port (43020) with a sandbox
 * BLASTRADIUS_HOME_DIR so the test never touches the user's real
 * ~/.blastradius/ preferences or knowledge store.
 *
 * Sandbox layout, recreated per test run:
 *   <tmp>/blastradius-e2e-<pid>/
 *     ├── .blastradius/preferences.json   ← parentDir = repoRoot, viewMode = graph
 *     └── .blastradius-logs/              ← BLASTRADIUS_LOG_DIR target
 *
 * The active repo is the BlastRadius checkout itself: it has 27 source
 * nodes / 39 edges / 0 cycles after dependency-cruiser builds the
 * graph, which is enough surface for click-target assertions.
 */

import { defineConfig } from '@playwright/test'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, resolve as resolvePath } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = __dirname.replace(/\\/g, '/')

// Allocate a fresh sandbox home so the test never collides with the
// user's real prefs. Cleanup happens in the globalTeardown via env
// roundtrip (Playwright doesn't have a cheap "after all suites" hook
// for FS cleanup without writing one — we trade leaked tmp dirs for
// config simplicity here; the OS reaps tmpdir() on reboot anyway).
const SANDBOX_HOME = mkdtempSync(resolvePath(tmpdir(), 'blastradius-e2e-'))
mkdirSync(resolvePath(SANDBOX_HOME, '.blastradius'), { recursive: true })
const SANDBOX_LOG_DIR = resolvePath(SANDBOX_HOME, '.blastradius-logs')
mkdirSync(SANDBOX_LOG_DIR, { recursive: true })

// Seed preferences with the BlastRadius checkout as parent dir + the
// repo itself as currentRepo + viewMode = 'graph' so the dashboard
// opens directly in graph mode and we don't have to toggle in the test.
writeFileSync(
  resolvePath(SANDBOX_HOME, '.blastradius', 'preferences.json'),
  JSON.stringify({
    parentDir: dirname(REPO_ROOT),
    autoSwitch: false,
    currentRepo: REPO_ROOT,
    iterationWindowMs: 180000,
    viewMode: 'graph',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }, null, 2),
)

const PORT = process.env.PLAYWRIGHT_BR_PORT || '43020'

export default defineConfig({
  testDir: './tests/e2e',
  // E2E runs sequentially — the dev server is a singleton.
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: `http://localhost:${PORT}`,
    // 5 s per action is generous for the local server; failures here
    // mean the dashboard actually hung, not a slow CI runner.
    actionTimeout: 5000,
    navigationTimeout: 10000,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  webServer: {
    command: `node src/server/index.js`,
    url: `http://localhost:${PORT}/api/preferences`,
    timeout: 20000,
    reuseExistingServer: false,
    stdout: 'pipe',
    stderr: 'pipe',
    env: {
      BLASTRADIUS_PORT: PORT,
      BLASTRADIUS_HOME_DIR: SANDBOX_HOME,
      BLASTRADIUS_LOG_DIR: SANDBOX_LOG_DIR,
      BLASTRADIUS_LOG_LEVEL: 'warn',
    },
  },
})
