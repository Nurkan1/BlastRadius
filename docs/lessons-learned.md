# Lessons learned — specifications based on community-sourced information about recently-launched products

> Written 2026-05-25 after losing roughly four hours and eight commits
> to a refactor (`f62f657..b0f0223`) targeting an API that didn't exist.
> Companion to `docs/antigravity-audit.md` — read that one for the
> what; this one is the why and the how-not-to-repeat-it.

## What happened

Google's Antigravity 2.0 launched in May 2026. The official
documentation at the time was incomplete: it described the Python SDK
extensively but glossed over the GUI runtime's actual extension
mechanism. Filling the gap, several community sources (forum threads,
medium tutorials, a couple of YouTube walk-throughs) described a
"hooks.json" plugin contract with PreToolUse / PostToolUse events,
JSON stdin/stdout protocol, and matcher regexes. That description
turned out to be either invented, transferred from Claude Code's
PostToolUse spec, or accurate for an earlier prototype that did not
ship in the public release.

A 16-question audit against those community sources produced a "verified
official hook contract". The refactor that followed was clean,
test-covered, idempotent, properly versioned, and shipped two installers
(MSI + NSIS) bundling a node sidecar. **Every line of code was correct
for a system that doesn't exist.**

The single empirical test that broke the illusion was: install the
plugin, open Antigravity, edit a file, look at the BlastRadius
dashboard. Zero events. Eight commits, four hours, fictional API.

## Why the executor LLM didn't catch it

The LLM (me) followed the spec faithfully. The 16 verified facts
looked like documentation: they cited paths, schema shapes, header
names, defaults. The audit doc anchored every claim to a file path —
which made it feel grounded — but those file paths pointed at
*templates we were about to create*, not at evidence of what
Antigravity already does. We confused "the spec says X" with
"the system does X". A spec is only useful when it is testable.
A spec we copied from a forum is not testable until something is
actually plugged into the real system.

## What should have happened before commit 1

Three steps, twenty minutes total, that would have caught this:

1. **Smoke test the integration with 5-10 lines of throwaway code.**
   Write a one-file Node script that the real Antigravity is supposed
   to invoke according to the spec. Make it write its argv, env, and
   stdin to a log file. Install the bare-minimum config the spec
   demands. Open the real product. Edit a file. Look at the log.
   If nothing was written, the spec is wrong. Stop.

2. **Inspect the actual configuration directory of the target tool
   on a real install.** For Antigravity:
   `ls ~/.gemini/config/` would have revealed `skills/` and
   `plugins/` immediately. Five minutes of `find` would have shown
   that the only file format inside `plugins/<name>/` is `*.md`. No
   `hooks.json` anywhere. That alone falsifies the entire
   refactor's premise.

3. **Find one working example of the integration in the wild.** Not
   a tutorial, not a blog post — an actual plugin published by
   someone else, running against the real product, with a public
   issue tracker showing it works. A *Hello World*-grade existence
   proof. If no such example exists, treat every claim about the
   integration surface as a hypothesis until you've validated it.

## Triggers — when to enforce these steps

This isn't a universal rule. For mature integrations (the Claude Code
hook itself is well-documented and stable; we wired it up without
empirical validation, and it worked) the cost of these gates is wasted
time. The triggers that *should* require empirical pre-validation are:

- The target product is **less than a year old** (Antigravity 2.0:
  weeks old at the time of the refactor).
- The specification comes from **non-official sources** — community
  posts, transcribed tutorials, forum answers. Anything not on the
  vendor's own docs site or in an SDK source repository.
- The integration is **critical to the user experience** — meaning,
  if the spec is wrong, the user sees nothing, and nothing in the
  test suite would catch the failure because the tests assert
  behaviour against our code, not against the real downstream.

When all three triggers fire, do the three pre-validation steps above
before writing the audit. Eight commits are cheap to write but
expensive to delete.

## What we kept

The refactor wasn't pure waste. The pieces that survive contact with
reality:

- `src/server/agentInference.js` — the `inferAgent()` cascade. The
  back-compat logic for the `agent` field on the JSONL schema works
  regardless of how the events get into the log. Still useful.
- `src/hook/log-touch-shared.js` — extracting pure helpers out of
  `log-touch.js` shaved ~30 ms off cold-start. Still useful for the
  CLI-mode invocation the skill protocol uses.
- The audit doc as a historical record. Future contributors will see
  the deprecation banner first and know not to repeat the path.
- This file.

The pieces that need to go (tracked in `BACKLOG.md` under
*Antigravity v1.0 — pending refactor*):

- `templates/antigravity/plugin.json`, `templates/antigravity/hooks/hooks.json`
  — fictional artifacts.
- The plugin-tree branch of `install-hook.ps1 -Agent antigravity` —
  installs a non-functional directory layout.
- The stdin-only entry of `log-touch-antigravity.js` — needs the CLI
  mode added before the bug it caused (Node process leaks) is
  resolvable.

## The one-line takeaway

**Before writing a spec against a new product, verify that the
integration surface in the spec exists on a real install. The cost
of skipping that step scales with the size of the refactor it
unblocks; in our case, eight commits of perfectly written code
targeting a fictional API.**
