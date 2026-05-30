/**
 * repairPrompt — assisted onboarding (rc9.14).
 *
 * Why this exists
 * ───────────────
 * A non-technical Claude Code user doesn't know what a "hook" is or where
 * `.claude/settings.json` lives — but they DO have Claude Code open right
 * next to BlastRadius. So instead of asking them to run a PowerShell script,
 * BlastRadius generates a precise, self-contained prompt they can paste into
 * Claude Code, and Claude Code does the install/repair for them: it handles
 * path quirks, execution policy, and the settings.json merge that the in-app
 * installer can't always perform (locked-down PowerShell, permissions).
 *
 * This module is PURE (no IO). It turns the data the server already knows
 * (the repo path, the settings.json path, the canonical hook entry, the log
 * dir) into a human/agent-readable instruction. The dashboard fetches the
 * resolved-for-this-machine prompt and copies it to the clipboard on click.
 *
 * Security / privacy invariants
 * ─────────────────────────────
 *   - The prompt carries ONLY paths and the hook entry we would write
 *     ourselves — never the contents of any user file (zero-data-retention).
 *   - It instructs Claude Code to run only the bundled installer or to make a
 *     declarative settings.json edit — never "download and run" anything.
 *   - It is copied to the clipboard on an explicit user click; nothing here
 *     executes. The user reviews the text before pasting it.
 */

/** Pretty-print the canonical hook entry, indented for readability inside
 *  the prompt. Falls back to an empty object literal if something is off. */
function formatEntry(hookEntry) {
  try {
    return JSON.stringify(hookEntry, null, 2)
  } catch {
    return '{}'
  }
}

/**
 * Build the Claude-Code-pasteable prompt.
 *
 * @param {{
 *   scenario?: 'install' | 'reinstall' | 'repair_corrupt',
 *   repoPath: string,
 *   settingsPath: string,
 *   hookEntry: object,
 *   logDir: string,
 * }} input
 * @returns {string}
 */
export function buildClaudePrompt({ scenario = 'install', repoPath, settingsPath, hookEntry, logDir }) {
  const settings = settingsPath || '.claude/settings.json'
  const entryJson = formatEntry(hookEntry)
  const dir = logDir || '~/.blastradius/logs'
  // The PowerShell installer is the documented, equivalent fallback. We hand
  // it over so the agent can prefer it on Windows if it wishes.
  const psFallback = repoPath ? `.\\scripts\\install-hook.ps1 -ProjectPath "${repoPath}"` : null

  const intro =
    scenario === 'repair_corrupt'
      ? "I use BlastRadius, a local-first code-observability tool. Its Claude Code settings file in this repo is corrupt and can't be parsed, so BlastRadius can't capture my activity. Please repair it for me — carefully, without losing my other settings:"
      : scenario === 'reinstall'
        ? "I use BlastRadius, a local-first code-observability tool. Its Claude Code hook in this repo is out of date (it points at the wrong log folder, so the dashboard shows no activity). Please fix it for me:"
        : "I use BlastRadius, a local-first code-observability tool, and I want it to capture my file activity in this repo so its dashboard works. Please install its Claude Code hook for me:"

  const mergeVerb =
    scenario === 'repair_corrupt'
      ? 'Recreate the file as valid JSON. If the old file is readable at all, preserve any settings you can recover; if not, start from an empty object. Then ensure it has a "hooks" object with a "PostToolUse" array containing this entry'
      : scenario === 'reinstall'
        ? 'Find any existing BlastRadius entry in the "PostToolUse" array (its command contains "log-touch.js") and REPLACE it with this entry. Leave every other hook untouched'
        : 'Ensure it has a "hooks" object with a "PostToolUse" array, and MERGE this entry into that array. Do NOT remove or modify any other existing hooks'

  const lines = [
    intro,
    '',
    `1. Open (or create) the settings file at:\n   ${settings}`,
    `2. ${mergeVerb}:\n\n${indent(entryJson, '   ')}`,
    `3. Make sure the log directory exists (create it if missing):\n   ${dir}`,
    '4. Save the file as valid JSON (2-space indentation is fine).',
    '5. Confirm to me that the BlastRadius PostToolUse entry is present and the JSON is valid.',
    '',
    'After this, I should restart any Claude Code session open in this repo so the hook takes effect (Claude Code reads settings.json only at session start).',
    '',
    'For context: this hook only records which files are touched (the file path, the tool name, a timestamp, and a content hash) into the local log folder above. It never sends anything over the network — BlastRadius is 100% local.',
  ]

  if (psFallback) {
    lines.push('', `If you prefer, the equivalent one-step installer is:\n   ${psFallback}`)
  }

  return lines.join('\n')
}

/** Indent every line of a block by `pad`. */
function indent(text, pad) {
  return String(text)
    .split('\n')
    .map((l) => (l.length ? pad + l : l))
    .join('\n')
}

/** Map a diagnostics check code (or hook-status reason) to a prompt scenario. */
export function scenarioForReason(reasonOrCode) {
  switch (reasonOrCode) {
    case 'settings_corrupt':
      return 'repair_corrupt'
    case 'outdated_command':
    case 'log_dir_mismatch':
    case 'hook_outdated':
      return 'reinstall'
    default:
      return 'install'
  }
}
