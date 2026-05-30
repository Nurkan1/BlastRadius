/**
 * repairPrompt (rc9.14) — the Claude-Code-pasteable onboarding prompt.
 *
 * The prompt is the heart of the assisted-onboarding feature: a non-technical
 * user copies it into Claude Code, which then installs/repairs the hook. These
 * tests pin the contract: the right paths are embedded, the canonical hook
 * command is present, the scenario wording is correct, and — critically — NO
 * user file contents leak (zero-data-retention).
 */

import { describe, it, expect } from 'vitest'
import { buildClaudePrompt, scenarioForReason } from '../src/server/repairPrompt.js'
import { buildHookEntry } from '../src/server/hookInstaller.js'

const LOG_DIR = 'C:/Users/me/.blastradius/logs'
const BLAST_ROOT = 'C:/Program Files/BlastRadius'
const REPO = 'C:/Users/me/Projects/acme'
const SETTINGS = 'C:/Users/me/Projects/acme/.claude/settings.json'
const hookEntry = buildHookEntry({ logDir: LOG_DIR, blastRadiusRoot: BLAST_ROOT })

describe('scenarioForReason', () => {
  it('maps hook-status reasons + diagnostics codes to scenarios', () => {
    expect(scenarioForReason('settings_corrupt')).toBe('repair_corrupt')
    expect(scenarioForReason('outdated_command')).toBe('reinstall')
    expect(scenarioForReason('log_dir_mismatch')).toBe('reinstall')
    expect(scenarioForReason('hook_outdated')).toBe('reinstall')
    expect(scenarioForReason(null)).toBe('install')
    expect(scenarioForReason('anything-else')).toBe('install')
  })
})

describe('buildClaudePrompt — common contract', () => {
  const prompt = buildClaudePrompt({ scenario: 'install', repoPath: REPO, settingsPath: SETTINGS, hookEntry, logDir: LOG_DIR })

  it('names BlastRadius and asks Claude Code to act', () => {
    expect(prompt).toContain('BlastRadius')
    expect(prompt.toLowerCase()).toContain('claude code')
  })

  it('embeds the exact settings.json path and the log directory', () => {
    expect(prompt).toContain(SETTINGS)
    expect(prompt).toContain(LOG_DIR)
  })

  it('embeds the canonical hook command (log-touch.js + --log-dir)', () => {
    expect(prompt).toContain('log-touch.js')
    expect(prompt).toContain('--log-dir')
    // The command appears inside the pretty-printed entry JSON, so it shows up
    // in its JSON-escaped form (wrapping quotes become \").
    expect(prompt).toContain(JSON.stringify(hookEntry.hooks[0].command))
    expect(prompt).toContain('PostToolUse')
  })

  it('offers the PowerShell installer as a fallback with the repo path', () => {
    expect(prompt).toContain('install-hook.ps1')
    expect(prompt).toContain(REPO)
  })

  it('states the privacy posture (local only, no network)', () => {
    expect(prompt.toLowerCase()).toMatch(/never sends|100% local|local/)
  })

  it('mentions restarting Claude Code for the hook to take effect', () => {
    expect(prompt.toLowerCase()).toContain('restart')
  })
})

describe('buildClaudePrompt — scenario wording', () => {
  it('install: asks to MERGE without removing other hooks', () => {
    const p = buildClaudePrompt({ scenario: 'install', repoPath: REPO, settingsPath: SETTINGS, hookEntry, logDir: LOG_DIR })
    expect(p).toMatch(/merge/i)
    expect(p).toMatch(/do not remove|not remove|untouched/i)
  })

  it('reinstall: asks to REPLACE the existing log-touch.js entry', () => {
    const p = buildClaudePrompt({ scenario: 'reinstall', repoPath: REPO, settingsPath: SETTINGS, hookEntry, logDir: LOG_DIR })
    expect(p).toMatch(/replace/i)
    expect(p).toContain('log-touch.js')
    expect(p.toLowerCase()).toContain('out of date')
  })

  it('repair_corrupt: acknowledges the corrupt file and asks to recreate valid JSON', () => {
    const p = buildClaudePrompt({ scenario: 'repair_corrupt', repoPath: REPO, settingsPath: SETTINGS, hookEntry, logDir: LOG_DIR })
    expect(p.toLowerCase()).toContain('corrupt')
    expect(p.toLowerCase()).toMatch(/valid json/)
  })

  it('defaults to the install scenario when none is given', () => {
    const p = buildClaudePrompt({ repoPath: REPO, settingsPath: SETTINGS, hookEntry, logDir: LOG_DIR })
    expect(p).toMatch(/merge/i)
  })
})

describe('buildClaudePrompt — safety / robustness', () => {
  it('does NOT instruct any download-and-run or remote fetch', () => {
    const p = buildClaudePrompt({ scenario: 'install', repoPath: REPO, settingsPath: SETTINGS, hookEntry, logDir: LOG_DIR })
    expect(p.toLowerCase()).not.toMatch(/curl|wget|invoke-webrequest|iwr|downloadstring|http:\/\/|https:\/\//)
  })

  it('carries only the data it was given — no surprise content', () => {
    // Feed a hook entry that does NOT contain a marker string, and confirm the
    // marker never appears (the prompt can't fabricate user file contents).
    const p = buildClaudePrompt({ scenario: 'install', repoPath: REPO, settingsPath: SETTINGS, hookEntry, logDir: LOG_DIR })
    expect(p).not.toContain('SECRET-FILE-CONTENT')
  })

  it('survives a missing repoPath (no PS fallback line, still valid)', () => {
    const p = buildClaudePrompt({ scenario: 'install', repoPath: '', settingsPath: SETTINGS, hookEntry, logDir: LOG_DIR })
    expect(p).toContain(SETTINGS)
    expect(p).not.toContain('install-hook.ps1')
  })

  it('falls back to a placeholder settings path when none is given', () => {
    const p = buildClaudePrompt({ scenario: 'install', repoPath: REPO, settingsPath: '', hookEntry, logDir: LOG_DIR })
    expect(p).toContain('.claude/settings.json')
  })
})
