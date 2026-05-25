# BlastRadius backlog

Living list of work that is scoped and waiting on time, not on
decisions. Items here have a concrete acceptance test; items that
need more thinking belong in a design doc, not on this list.

When an item is taken on, move it under a "In-flight" heading with the
branch name. When done, remove it (the merge commit is the receipt).

---

## Antigravity v1.0 — pending refactor

Status: skill-based approach **validated empirically** on
2026-05-25 (see `docs/antigravity-audit.md`, section *"What we learned
the hard way"*). Refactor scoped, blocked on time only. **Tag
`v1.0.0-rc2` cannot ship until the must-do list below is green** —
the current `1.0.0-rc2` bundles ship with the stdin-hang bug that
leaks a Node process per Antigravity tool call.

### MUST-DO before tag v1.0.0-rc2

- [ ] **Add CLI argument mode to `src/hook/log-touch-antigravity.js`.**
      Detect the presence of any of `--tool / --path / --session /
      --workspace` in `process.argv` **before** any `readStdin()` call.
      In CLI mode, build the event from argv only, never touch stdin,
      never block. Stdin-mode behaviour stays as-is for the SDK
      integration path (still useful for users running Antigravity
      via the Python SDK).
- [ ] **Add a stdin timeout safeguard** (≤ 500 ms) so even the
      stdin-mode entry never hangs forever if the engine fails to
      close the pipe. On timeout, emit `decision:allow` (already
      emitted at line 1 of `main()`), log `malformed_stdin` with
      detail=`"stdin_timeout"`, exit 0.
- [ ] **Refactor `scripts/install-hook.ps1 -Agent antigravity`** to
      drop the four-file plugin layout
      (`.agents/plugins/blastradius/{plugin.json, hooks/hooks.json,
      log-touch-antigravity.js, log-touch.js}`) and instead install a
      single `SKILL.md` to
      `$HOME/.gemini/config/skills/blastradius-observer/SKILL.md`,
      per-user not per-workspace.
- [ ] **Delete** `templates/antigravity/plugin.json` and
      `templates/antigravity/hooks/hooks.json` (the
      hooks-contract-was-fictional artifacts). Keep
      `templates/antigravity/README.md` only after rewriting it to
      describe the skill approach honestly.
- [ ] **Create `templates/antigravity-skill/SKILL.md`** — the actual
      Markdown + YAML frontmatter the installer copies. Placeholder
      `${BLASTRADIUS_PATH}` substituted at install time so the
      command in the skill body points at the user's checkout.
- [ ] **Add ≥ 6 tests** to `tests/log-touch-antigravity.test.js`
      covering CLI mode and the hang-prevention contract. Minimum
      cases:
      1. `--tool Read --path /x --session U --workspace /w` → event
         written, exit 0, **no stdin read attempted**.
      2. CLI args with `--path` outside `--workspace` → warn +
         event still logged (mirrors stdin-mode behaviour).
      3. CLI args with unknown `--tool` value → warn
         `tool_unsupported`, 0 events.
      4. CLI mode + stdin pipe also present → CLI wins, stdin
         ignored, no hang.
      5. Stdin-mode invocation with no data, no FD close → process
         exits within 700 ms (proves the timeout works).
      6. Process audit: spawn N=20 invocations sequentially in
         CLI mode, after 2 s assert 0 zombie children.
- [ ] **Update README** with an honest agent support matrix —
      Claude Code: deterministic via PostToolUse; Antigravity:
      best-effort 85-95% via skill instruction. The current README
      implies symmetric support.

### Validation criteria for marking complete

- [ ] Running `install-hook.ps1 -Agent antigravity` against a fresh
      workspace creates `$HOME/.gemini/config/skills/blastradius-observer/SKILL.md`
      and nothing else (no `.agents/` tree).
- [ ] A live Antigravity conversation in that workspace, after the
      trigger phrase, produces JSONL events with `agent:"antigravity"`
      and a **real UUID** session id (not the literal
      `"antigravity-session"`).
- [ ] After a 10-minute Antigravity session that touches ≥ 10 files,
      `tasklist /fi "imagename eq node.exe"` shows **zero** orphan
      processes attributable to the hook.
- [ ] All 287 existing tests stay green.
- [ ] All new tests for the CLI mode pass.

---

## Performance backlog post-v1.0

The three optimisation paths considered before tagging v1.0.0-rc2 are
documented inline in `docs/antigravity-audit.md` under
*"Performance backlog post-v1.0"*. None blocks v1.0; the cold-start
ceiling of ~100 ms is well under the 5 s timeout configured in
`hooks.json` (which won't even be present after the refactor above,
but the latency budget still matters for the CLI invocation path —
the agent still waits on it before responding to the user).
