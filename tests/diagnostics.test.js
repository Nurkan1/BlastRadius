/**
 * Self-diagnostics (rc9.13) — turn silent misconfigurations into visible
 * warnings. Pure function over a hookStatus object; no IO.
 */

import { describe, it, expect } from 'vitest'
import { buildDiagnostics, parseLogDir } from '../src/server/diagnostics.js'

const cmd = (logDir) => `node "C:/x/src/hook/log-touch.js" --log-dir "${logDir}"`

describe('parseLogDir', () => {
  it('extracts the --log-dir argument', () => {
    expect(parseLogDir(cmd('C:/Users/n/.blastradius/logs'))).toBe('C:/Users/n/.blastradius/logs')
  })
  it('returns null when absent', () => {
    expect(parseLogDir('node "x.js"')).toBeNull()
    expect(parseLogDir(null)).toBeNull()
  })
})

describe('buildDiagnostics', () => {
  const SERVER_LOG = 'C:/Users/n/.blastradius/logs'

  it('flags a log-dir mismatch as a warning (the rc9.12 bug)', () => {
    const hookStatus = {
      installed: false,
      reason: 'outdated_command',
      currentCommand: cmd('C:/Users/n/Documents/BlastRadius/logs'), // wrong folder
      expectedCommand: cmd(SERVER_LOG),
    }
    const checks = buildDiagnostics({ hookStatus, serverLogDir: SERVER_LOG })
    expect(checks).toHaveLength(1)
    expect(checks[0]).toMatchObject({ level: 'warn', code: 'log_dir_mismatch', fix: 'reinstall_hook' })
    expect(checks[0].detail).toContain('BlastRadius/logs')
    expect(checks[0].detail).toContain('.blastradius/logs')
  })

  it('treats case/slash differences in the SAME folder as not a mismatch', () => {
    const hookStatus = {
      reason: 'outdated_command',
      currentCommand: cmd('C:\\Users\\n\\.blastradius\\logs\\'), // backslashes + trailing slash
      expectedCommand: cmd(SERVER_LOG),
    }
    const checks = buildDiagnostics({ hookStatus, serverLogDir: SERVER_LOG })
    // Same dir → not a mismatch; the command drifted otherwise → info, not warn.
    expect(checks.find((c) => c.code === 'log_dir_mismatch')).toBeUndefined()
    expect(checks[0]).toMatchObject({ level: 'info', code: 'hook_outdated' })
  })

  it('flags a corrupt settings file', () => {
    const checks = buildDiagnostics({ hookStatus: { reason: 'settings_corrupt', settingsPath: '/r/.claude/settings.json' }, serverLogDir: SERVER_LOG })
    expect(checks[0]).toMatchObject({ level: 'warn', code: 'settings_corrupt' })
  })

  it('is silent when the hook is correctly installed', () => {
    expect(buildDiagnostics({ hookStatus: { installed: true, reason: null }, serverLogDir: SERVER_LOG })).toEqual([])
  })

  it('is silent when there is no hook status', () => {
    expect(buildDiagnostics({ hookStatus: null, serverLogDir: SERVER_LOG })).toEqual([])
  })
})
