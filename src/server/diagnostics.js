/**
 * Self-diagnostics (rc9.13) — turn SILENT misconfigurations into visible,
 * actionable warnings.
 *
 * The rc9.12 bug (hook logging to one folder, server reading another → the
 * dashboard sat at 0 events with no explanation) is the canonical case: the
 * data to detect it already existed (getHookStatus reports `outdated_command`
 * with the installed vs expected hook command), but nothing SURFACED it —
 * and the install-hook banner was suppressed for repos the user had
 * "ignored". A genuine misconfiguration is NOT an optional install nudge, so
 * these diagnostics are reported regardless of the ignore list.
 *
 * Pure (no IO): takes a hookStatus object (from hookInstaller.getHookStatus)
 * + the server's log dir, returns a list of checks. Unit-testable.
 */

/** Extract the `--log-dir "X"` argument from a baked hook command. */
export function parseLogDir(command) {
  const m = /--log-dir\s+"([^"]+)"/.exec(String(command || ''))
  return m ? m[1] : null
}

/** Normalise a path for comparison: forward slashes, no trailing slash,
 *  lower-cased (Windows paths are case-insensitive; the hook + server may
 *  differ only in case/separator and still point at the same folder). */
function normPath(p) {
  return String(p || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
}

/**
 * @param {{ hookStatus: object|null, serverLogDir: string }} input
 * @returns {Array<{ level:'warn'|'error'|'info', code:string, message:string, detail:string, fix?:string }>}
 */
export function buildDiagnostics({ hookStatus, serverLogDir }) {
  const checks = []
  if (!hookStatus) return checks

  // The hook IS installed but its command differs from what we'd write now.
  // The most damaging variant is a log-dir mismatch: events are captured but
  // land in a folder the dashboard never reads (the rc9.12 bug).
  if (hookStatus.reason === 'outdated_command' && hookStatus.currentCommand) {
    const hookLogDir = parseLogDir(hookStatus.currentCommand)
    const expectedLogDir = parseLogDir(hookStatus.expectedCommand) || serverLogDir
    if (hookLogDir && expectedLogDir && normPath(hookLogDir) !== normPath(expectedLogDir)) {
      checks.push({
        level: 'warn',
        code: 'log_dir_mismatch',
        message: "BlastRadius isn't seeing your activity in this repo.",
        detail:
          `The hook writes its logs to "${hookLogDir}", but the dashboard reads "${expectedLogDir}". ` +
          'Reinstall the hook so both use the same folder.',
        fix: 'reinstall_hook',
      })
    } else {
      // Same log dir, but the command otherwise drifted (e.g. the hook
      // script path moved). Lower-severity but still worth a heads-up.
      checks.push({
        level: 'info',
        code: 'hook_outdated',
        message: 'The BlastRadius hook in this repo is out of date.',
        detail: 'Reinstall the hook to refresh its command.',
        fix: 'reinstall_hook',
      })
    }
  }

  if (hookStatus.reason === 'settings_corrupt') {
    checks.push({
      level: 'warn',
      code: 'settings_corrupt',
      message: "This repo's Claude settings file is corrupt.",
      detail: `${hookStatus.settingsPath || '.claude/settings.json'} couldn't be parsed; reinstall the hook to rewrite it.`,
      fix: 'reinstall_hook',
    })
  }

  return checks
}
