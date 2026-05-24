#!/usr/bin/env node
/**
 * BlastRadius — log-external.js
 *
 * A simple utility to log manual or external agent edits (such as Antigravity,
 * git hooks, or IDE extensions) to the active BlastRadius JSONL logs.
 *
 * Usage:
 *   node scripts/log-external.js --path <absolute-or-relative-path> [--tool <Read|Write|Edit>] [--cwd <repo-path>]
 */

import { resolve } from 'node:path'
import {
  toForwardSlashes,
  normalizePath,
  buildEvent,
  hashFile,
  appendJsonl,
  logFilePath,
} from '../src/hook/log-touch.js'
import 'dotenv/config'

const logDir = process.env.BLASTRADIUS_LOG_DIR || './logs'

async function main() {
  const args = process.argv.slice(2)
  let filePath = ''
  let tool = 'Write'
  let cwd = process.cwd()

  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--path' && i + 1 < args.length) {
      filePath = args[i + 1]
      i += 1
    } else if (args[i] === '--tool' && i + 1 < args.length) {
      tool = args[i + 1]
      i += 1
    } else if (args[i] === '--cwd' && i + 1 < args.length) {
      cwd = args[i + 1]
      i += 1
    }
  }

  if (!filePath) {
    console.error('Error: --path is required.')
    console.log('\nUsage:')
    console.log('  node scripts/log-external.js --path <file_path> [--tool <Read|Write|Edit>] [--cwd <cwd>]')
    process.exit(1)
  }

  const absPath = resolve(cwd, filePath)
  const hash = await hashFile(absPath)

  const event = buildEvent({
    ts: new Date().toISOString(),
    tool,
    path: toForwardSlashes(absPath),
    pathNorm: normalizePath(absPath, cwd),
    cwd: toForwardSlashes(cwd),
    hash,
    sessionId: 'antigravity-session',
  })

  const logFile = logFilePath(logDir)
  await appendJsonl(logFile, event)
  console.log(`[BlastRadius] Logged ${tool} on: ${filePath}`)
}

main().catch((err) => {
  console.error('[BlastRadius] Log failed:', err)
  process.exit(1)
})
