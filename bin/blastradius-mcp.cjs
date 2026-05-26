#!/usr/bin/env node
// CommonJS shim wrapper that delegates to bin/blastradius-mcp.mjs.
// Some MCP clients (e.g. Claude Desktop 1.8555.x) validate the
// `command + args` shape with a stricter parser that flags .mjs
// entries as invalid. This wrapper presents a plain .cjs entry
// point and forwards stdin/stdout/stderr to the ESM implementation
// via Node's child_process.
const { spawn } = require('child_process')
const path = require('path')

const target = path.join(__dirname, 'blastradius-mcp.mjs')
const child = spawn(process.execPath, [target], {
  stdio: 'inherit',     // straight pass-through to parent's stdio
  env: process.env,
})
child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal)
  else process.exit(code ?? 0)
})
