# Security Policy

## Threat model

BlastRadius is a **local-only developer observability tool**. By design:

- All HTTP endpoints (`/api/*`, `/mcp`) bind to `localhost` only — there is
  no public surface, no authentication, and no remote access path.
- The dashboard reads the user's repositories **read-only** — the only
  file it ever writes outside `node_modules/` and the configured log
  directory is `~/.blastradius/preferences.json`.
- The MCP server (Phase 1+) is strictly read-only on the observed
  repositories. No tool or resource can mutate repository state.

Reports outside this threat model (e.g. attacks that require the user
to deliberately expose port 7842 to the internet) are out of scope.

## Reporting a vulnerability

Please **do not** open a public GitHub issue for security-sensitive
findings.

Instead, open a [private security advisory](https://github.com/Nurkan1/BlastRadius/security/advisories/new)
on this repository. Include:

- Affected version (`curl http://localhost:7842/api/health` returns it
  in the `server.version` field when the dashboard is running).
- A clear description of the issue and how to reproduce it.
- Where applicable, a suggested fix or mitigation.

Acknowledgement target: within 5 business days. Fix target: depends on
severity (best effort — this is a personal project, not a vendored
product).

## Supported versions

Only the latest release on the `main` branch receives security fixes.
Pre-release tags (`v1.0.0-rc*`) are not supported once a newer one
ships. See [Releases](https://github.com/Nurkan1/BlastRadius/releases)
for the current latest version.

## Out of scope

- Dependency CVEs that are not directly exploitable through BlastRadius
  surfaces (use `npm audit` for those).
- Self-inflicted misconfigurations (e.g. running the dashboard behind a
  public reverse proxy without adding your own authentication layer).
- Bugs in third-party MCP clients that connect to BlastRadius.
