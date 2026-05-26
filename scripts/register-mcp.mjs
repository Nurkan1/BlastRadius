#!/usr/bin/env node
/**
 * Idempotent MCP server registrar — used by scripts/install-hook.ps1
 * to merge the BlastRadius entry into a client's MCP config file
 * without disturbing any other top-level keys or other servers.
 *
 * Why Node and not pure PowerShell:
 *   Windows PowerShell 5.1's `ConvertTo-Json` indents using a
 *   vertical-alignment scheme that triples the file size and
 *   destroys the user's original 2-space-indented JSON formatting.
 *   Node's `JSON.stringify(obj, null, 2)` is predictable, stable,
 *   and matches the format Claude Code / Antigravity ship natively.
 *
 * Two equivalent CLI signatures (use stdin in PowerShell — Windows
 * arg quoting eats the inner `"` and corrupts the JSON payload):
 *
 *   node register-mcp.mjs <configPath> <serverName> <entryJson> [--dry-run]
 *
 *   node register-mcp.mjs <configPath> <serverName> --stdin [--dry-run]
 *     ← entry JSON read from stdin, one document, no trailing data
 *
 *   configPath: absolute path to the JSON config file (created if missing)
 *   serverName: top-level key under `mcpServers` (e.g. "blastradius")
 *   entryJson:  JSON string with the server entry, e.g.
 *               '{"type":"http","url":"http://localhost:7842/mcp"}'
 *   --dry-run:  print planned action without writing
 *   --stdin:    read entry JSON from stdin instead of from argv
 *
 * stdout one of:
 *   UNCHANGED         — entry already present with the same shape
 *   CREATED <path>    — config file did not exist; created it
 *   UPDATED <path>    — entry replaced; a .bak.<TIMESTAMP> was written
 *   WOULD-CREATE      — --dry-run, file would be created
 *   WOULD-UPDATE      — --dry-run, file would be modified
 *
 * Exit code 0 on success; 1 on usage error or write failure.
 * Errors go to stderr only.
 */

import { existsSync, readFileSync, writeFileSync, copyFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

function die(msg, code = 1) {
  process.stderr.write(`register-mcp: ${msg}\n`)
  process.exit(code)
}

function timestamp() {
  const d = new Date()
  const pad = (n) => String(n).padStart(2, '0')
  return (
    `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-` +
    `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
  )
}

const args = process.argv.slice(2)
const dryRun = args.includes('--dry-run')
const useStdin = args.includes('--stdin')
const positional = args.filter((a) => !a.startsWith('--'))

const expectedPositional = useStdin ? 2 : 3
if (positional.length !== expectedPositional) {
  die(
    useStdin
      ? 'usage: register-mcp.mjs <configPath> <serverName> --stdin [--dry-run]'
      : 'usage: register-mcp.mjs <configPath> <serverName> <entryJson> [--dry-run]',
  )
}
const [configPath, serverName] = positional
const entryJson = useStdin ? await readStdin() : positional[2]

async function readStdin() {
  // Synchronously drain stdin into a UTF-8 string. Used when the
  // caller can't reliably escape JSON quotes on the command line
  // (PowerShell on Windows is the canonical case). The entry JSON
  // is small (~100 bytes), so we don't bother streaming.
  return new Promise((resolve, reject) => {
    let buf = ''
    process.stdin.setEncoding('utf8')
    process.stdin.on('data', (chunk) => { buf += chunk })
    process.stdin.on('end', () => resolve(buf.trim()))
    process.stdin.on('error', reject)
  })
}

let entry
try {
  entry = JSON.parse(entryJson)
} catch (err) {
  die(`invalid entry JSON: ${err.message}`)
}
if (entry == null || typeof entry !== 'object' || Array.isArray(entry)) {
  die('entry JSON must be an object')
}
if (!serverName || typeof serverName !== 'string') {
  die('serverName must be a non-empty string')
}

// Load existing config or start fresh. A missing file = empty config;
// not a hard error. Malformed JSON IS an error — we won't silently
// overwrite the user's broken file.
let config = {}
const fileExists = existsSync(configPath)
if (fileExists) {
  let raw
  try {
    raw = readFileSync(configPath, 'utf8')
  } catch (err) {
    die(`could not read ${configPath}: ${err.message}`)
  }
  if (raw.trim().length === 0) {
    config = {}
  } else {
    try {
      config = JSON.parse(raw)
    } catch (err) {
      die(`existing config is not valid JSON: ${err.message}. ` +
          `Refusing to overwrite. Fix ${configPath} or remove it first.`)
    }
    if (config == null || typeof config !== 'object' || Array.isArray(config)) {
      die('existing config root must be an object')
    }
  }
}

if (!config.mcpServers || typeof config.mcpServers !== 'object' || Array.isArray(config.mcpServers)) {
  config.mcpServers = {}
}

// Semantic equality via canonical JSON. Keys may be in different
// order in the existing file vs. the requested entry — we sort to
// normalize before comparing so a no-op pass actually no-ops.
function canonical(obj) {
  if (obj === null || typeof obj !== 'object') return JSON.stringify(obj)
  if (Array.isArray(obj)) return '[' + obj.map(canonical).join(',') + ']'
  const keys = Object.keys(obj).sort()
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonical(obj[k])).join(',') + '}'
}

const existing = config.mcpServers[serverName]
if (existing && canonical(existing) === canonical(entry)) {
  process.stdout.write('UNCHANGED\n')
  process.exit(0)
}

config.mcpServers[serverName] = entry

if (dryRun) {
  process.stdout.write(fileExists ? 'WOULD-UPDATE\n' : 'WOULD-CREATE\n')
  process.exit(0)
}

// Best-effort backup before destructive writes — only when the file
// already had content. Created files never need a backup.
if (fileExists) {
  const bak = `${configPath}.bak.${timestamp()}`
  try {
    copyFileSync(configPath, bak)
  } catch (err) {
    die(`could not write backup to ${bak}: ${err.message}`)
  }
}

// Ensure parent dir exists (the Antigravity config lives under
// ~/.gemini/config/, which may not exist on a fresh machine).
const dir = dirname(configPath)
if (dir && !existsSync(dir)) {
  try {
    mkdirSync(dir, { recursive: true })
  } catch (err) {
    die(`could not create directory ${dir}: ${err.message}`)
  }
}

// Two-space indent matches what Claude Code and Antigravity emit
// natively — preserves the user's reading experience and keeps
// diffs minimal across edits.
const out = JSON.stringify(config, null, 2) + '\n'

try {
  writeFileSync(configPath, out, 'utf8')
} catch (err) {
  die(`could not write ${configPath}: ${err.message}`)
}

process.stdout.write((fileExists ? 'UPDATED ' : 'CREATED ') + configPath + '\n')
process.exit(0)
