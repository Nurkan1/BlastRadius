/**
 * Tiny utility to read the current commit SHA of the BlastRadius repo
 * WITHOUT shelling out to git. Reading the porcelain plumbing files
 * directly is fast, sync-safe, and zero-cost — fine for the boot path
 * and for /api/health.
 *
 * Algorithm:
 *   1. Read `<repo>/.git/HEAD`. Two shapes are possible:
 *      a) Detached HEAD: the file contains the 40-char SHA directly.
 *      b) Ref: the file says `ref: refs/heads/<branch>`. We then read
 *         `<repo>/.git/<refs/heads/branch>` to get the SHA.
 *   2. Return the trimmed SHA.
 *
 * The function never throws — anything unexpected (missing file,
 * unreadable, malformed) yields `null` so callers can show a graceful
 * "unknown" state rather than crashing the boot.
 *
 * Worktrees / submodules: we don't attempt to follow `.git` files
 * (which submodules and worktrees use as redirects). The BlastRadius
 * repo itself is always a normal checkout in practice; if that ever
 * changes the caller will see `null` and surface a helpful warning.
 */

import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Read the current commit SHA of the repo at `repoRoot`.
 * @param {string} repoRoot Absolute path to the repo whose SHA we want.
 * @returns {string|null} 40-char hex SHA, or null on any error.
 */
export function readHeadSha(repoRoot) {
  if (typeof repoRoot !== 'string' || repoRoot.length === 0) return null
  try {
    const headPath = join(repoRoot, '.git', 'HEAD')
    // We need to bail early if .git/ is a file (worktree/submodule) or
    // doesn't exist. statSync is sync and fast.
    let stat
    try {
      stat = statSync(join(repoRoot, '.git'))
    } catch {
      return null
    }
    if (!stat.isDirectory()) return null

    const raw = readFileSync(headPath, 'utf8').trim()
    // Detached HEAD: 40 hex chars.
    if (/^[a-f0-9]{40}$/i.test(raw)) return raw.toLowerCase()
    // Ref form: "ref: refs/heads/main"
    const refMatch = raw.match(/^ref:\s*(.+)$/)
    if (!refMatch) return null
    const refRelative = refMatch[1].trim()
    // Sanity guard: ref must be inside .git/refs/ — never absolute or
    // escaping via ".." (defense in depth; we only ever read git-shaped
    // strings).
    if (refRelative.startsWith('/') || refRelative.includes('..')) return null
    const refPath = join(repoRoot, '.git', refRelative)
    try {
      const refSha = readFileSync(refPath, 'utf8').trim()
      if (/^[a-f0-9]{40}$/i.test(refSha)) return refSha.toLowerCase()
    } catch {
      // Packed refs: ref file might not exist as a separate file when
      // git has packed it into .git/packed-refs. Try that fallback.
      try {
        const packed = readFileSync(join(repoRoot, '.git', 'packed-refs'), 'utf8')
        for (const line of packed.split('\n')) {
          if (line.startsWith('#') || line.startsWith('^') || !line.trim()) continue
          const [sha, refName] = line.split(/\s+/)
          if (refName === refRelative && /^[a-f0-9]{40}$/i.test(sha)) {
            return sha.toLowerCase()
          }
        }
      } catch {
        // No packed-refs either — give up gracefully.
      }
    }
    return null
  } catch {
    return null
  }
}

/** Short 7-char SHA for display. Returns the input unchanged if it's
 *  not a recognizable full SHA — keeps callers simple. */
export function shortSha(sha) {
  if (typeof sha !== 'string') return ''
  return /^[a-f0-9]{40}$/i.test(sha) ? sha.slice(0, 7) : sha
}
