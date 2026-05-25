# Antigravity plugin templates

These two files are the canonical configuration the BlastRadius
installer (`scripts/install-hook.ps1`, landing in commit 5) copies into
the user's workspace at:

```
<workspace>/.agents/plugins/blastradius/
  ├── plugin.json
  └── hooks/
      └── hooks.json
```

They are kept here as static templates (option A1 in
`docs/antigravity-audit.md`) for three reasons:

1. **Reproducible installs.** A future invocation of
   `install-hook.ps1 -Agent antigravity -Update` can compare the
   workspace's `plugin.json.version` against the version in this
   template and reinstall only when they differ.
2. **Reviewability.** Any change to the hook contract surface ships
   as a diff against these files, not as a string buried in PowerShell
   logic — easier to review and to bisect.
3. **Reuse by other installers.** A bash equivalent of
   `install-hook.ps1` (Linux / macOS) can read the same templates
   without re-encoding them.

## plugin.json

Minimal plugin v2.0 manifest. `name` is the only field the Antigravity
loader requires; `version` and `description` are conventional and let
us reason about updates and explain the plugin in the agent UI.

## hooks/hooks.json

Wires the BlastRadius hook to the **PostToolUse** lifecycle event with
the matcher `edit_file|patch_file|write_file|view_file|grep_search`.
The `run_command` tool is deliberately absent — see
`docs/antigravity-audit.md` §Design decision 3 for the rationale
(file-touch heat map has no clean signal from run_command and the
~30-50 ms cold start per invocation would visibly degrade agent UX).

`timeout: 5` is defensive: well below the engine's default 30 s, well
above our own < 50 ms target. If we ever exceed 5 s something has gone
catastrophically wrong inside the hook.

The `${PLUGIN_ROOT}` placeholder is resolved by Antigravity at runtime
to the directory containing `plugin.json`, so the hook script lives
alongside the manifest after install:

```
<workspace>/.agents/plugins/blastradius/
  ├── plugin.json
  ├── log-touch-antigravity.js     ← copied by the installer
  └── hooks/hooks.json
```

The installer also copies `log-touch.js` next to the Antigravity hook
because the latter imports pure helpers from it (`hashFile`,
`appendJsonl`, `MAX_HASH_BYTES`, `HOOK_WARN_REASONS`). Node's module
resolver walks up from the importing file, finds the sibling, and
loads it directly — no `node_modules` needed for the shared pure
helpers. The installer is responsible for ensuring any external deps
the hooks may need (currently none on the Antigravity hot path) are
available at the workspace level.
