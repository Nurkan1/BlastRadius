/**
 * Preferences persistence — single JSON file at
 * `~/.blastradius/preferences.json` that survives server restarts and
 * holds the user's choice of parent directory + active repo + flags.
 *
 * Source of truth model
 * ─────────────────────
 *   - At boot we load() once into memory.
 *   - Every mutating call goes through save() which atomically
 *     replaces the file (write to .tmp, then rename) and updates
 *     the in-memory copy. There is NO re-read during runtime.
 *   - If the file is missing, corrupted, or unreadable, load()
 *     returns a default with `needsSetup: true` so the frontend
 *     can launch the wizard. The corrupted file is NOT deleted —
 *     keeps a recovery breadcrumb.
 *
 * Schema
 * ──────
 *   {
 *     parentDir:         string,            // absolute, forward-slashed
 *     autoSwitch:        boolean,           // auto-pick active repo from activity
 *     currentRepo:       string | null,     // absolute path of the active repo
 *     iterationWindowMs: number,            // F4 marker fallback window
 *     createdAt:         ISO string,
 *     updatedAt:         ISO string
 *   }
 *
 * Migration from legacy env
 * ─────────────────────────
 *   - The top-level boot in index.js owns the migration logic
 *     (preferences.js only knows the schema + IO). When the prefs
 *     file doesn't exist:
 *       * BLASTRADIUS_PARENT_DIR (new) → bootstrap autoSwitch=true.
 *       * BLASTRADIUS_TARGET_REPO (legacy) → bootstrap from its
 *         dirname() as parentDir; set autoSwitch=false (the user
 *         explicitly picked that one repo).
 *     The migration writes the file once and logs a deprecation
 *     warning for the legacy var.
 *
 * Cross-platform notes
 * ────────────────────
 *   - On POSIX we chmod 0600 the prefs file (and 0700 the parent
 *     directory) after creating them — defense against shared
 *     systems.
 *   - On Windows the FS permission model is different and
 *     chmod is largely a no-op; we skip it without warning.
 *   - All paths in the schema are forward-slashed so they survive
 *     a copy from a Windows box to a Unix box and back.
 */

import { promises as fs } from 'node:fs'
import { homedir, platform } from 'node:os'
import { dirname, resolve } from 'node:path'

export const DEFAULT_ITERATION_WINDOW_MS = 3 * 60 * 1000

const FILE_NAME = 'preferences.json'
const DIR_NAME = '.blastradius'
const TMP_SUFFIX = '.tmp'

/** Compute the canonical preferences directory + file paths. Exported so
 *  tests can override via the constructor `homeDir` option without
 *  monkey-patching os.homedir(). */
export function getDefaultPaths(home = homedir()) {
  const dir = resolve(home, DIR_NAME)
  return {
    dir,
    file: resolve(dir, FILE_NAME),
    tmp: resolve(dir, `${FILE_NAME}${TMP_SUFFIX}`),
  }
}

/** Force-forward-slash a path, idempotently. */
function fwd(p) {
  return typeof p === 'string' ? p.replace(/\\/g, '/') : p
}

/** Build a default Prefs object. `needsSetup: true` flags the caller
 *  that the file didn't exist (or was malformed) so the UI should
 *  launch the wizard. */
export function emptyPreferences() {
  return {
    parentDir: null,
    autoSwitch: true,
    currentRepo: null,
    iterationWindowMs: DEFAULT_ITERATION_WINDOW_MS,
    createdAt: null,
    updatedAt: null,
    needsSetup: true,
  }
}

/** Validate + coerce a partial preferences object. Throws on truly
 *  invalid input (wrong type, etc.) so callers learn fast. */
function normalize(partial) {
  const out = {}
  if (partial == null || typeof partial !== 'object') {
    throw new TypeError('preferences must be an object')
  }
  if ('parentDir' in partial) {
    if (partial.parentDir != null && typeof partial.parentDir !== 'string') {
      throw new TypeError('parentDir must be a string or null')
    }
    out.parentDir = partial.parentDir ? fwd(resolve(partial.parentDir)) : null
  }
  if ('autoSwitch' in partial) {
    out.autoSwitch = !!partial.autoSwitch
  }
  if ('currentRepo' in partial) {
    if (partial.currentRepo != null && typeof partial.currentRepo !== 'string') {
      throw new TypeError('currentRepo must be a string or null')
    }
    out.currentRepo = partial.currentRepo ? fwd(resolve(partial.currentRepo)) : null
  }
  if ('iterationWindowMs' in partial) {
    const n = Number(partial.iterationWindowMs)
    if (!Number.isFinite(n) || n <= 0) {
      throw new TypeError('iterationWindowMs must be a positive number')
    }
    out.iterationWindowMs = Math.floor(n)
  }
  return out
}

/**
 * Preferences store. Singleton per server boot.
 *
 *   const prefs = new PreferencesStore({ logger })
 *   await prefs.load()
 *   prefs.get()                  // synchronous accessor
 *   await prefs.save({ parentDir: '/foo' })
 */
export class PreferencesStore {
  /**
   * @param {{
   *   homeDir?: string,
   *   paths?: { dir: string, file: string, tmp: string },
   *   logger?: { debug:Function, info:Function, warn:Function },
   * }} [opts]
   */
  constructor(opts = {}) {
    this.paths = opts.paths ?? getDefaultPaths(opts.homeDir)
    this.logger = opts.logger ?? { debug() {}, info() {}, warn() {} }
    /** @type {ReturnType<typeof emptyPreferences>} */
    this._current = emptyPreferences()
    this._loaded = false
  }

  /** Synchronous accessor for the in-memory copy. Always returns an
   *  object (never null). */
  get() {
    return { ...this._current }
  }

  /** Convenience: is the wizard needed? */
  needsSetup() {
    return !!this._current.needsSetup
  }

  /**
   * Load the prefs file. Idempotent: subsequent calls re-read disk
   * (handy for tests, but the live server only calls once at boot).
   *
   * Behavior on file states:
   *   - File missing  → `needsSetup: true`, no warning logged.
   *   - File parses but missing required fields → fill with defaults,
   *     keep `needsSetup` false IF parentDir is present.
   *   - File present but corrupt JSON → log warn, return empty with
   *     `needsSetup: true`; file is left alone for the user to fix.
   *   - Read error (EACCES etc.) → log warn, return empty wizard.
   */
  async load() {
    let raw
    try {
      raw = await fs.readFile(this.paths.file, 'utf8')
    } catch (err) {
      if (err.code === 'ENOENT') {
        this._current = emptyPreferences()
      } else {
        this.logger.warn({ err: String(err?.message ?? err), file: this.paths.file },
          'preferences read failed; starting in wizard mode')
        this._current = emptyPreferences()
      }
      this._loaded = true
      return this.get()
    }

    let parsed
    try {
      parsed = JSON.parse(raw)
    } catch (err) {
      this.logger.warn({ err: String(err?.message ?? err), file: this.paths.file },
        'preferences JSON is corrupt; starting in wizard mode (file preserved)')
      this._current = emptyPreferences()
      this._loaded = true
      return this.get()
    }

    if (!parsed || typeof parsed !== 'object') {
      this.logger.warn({ file: this.paths.file },
        'preferences root is not an object; starting in wizard mode')
      this._current = emptyPreferences()
      this._loaded = true
      return this.get()
    }

    // Fill in defaults for missing fields.
    const merged = {
      parentDir: typeof parsed.parentDir === 'string' ? fwd(parsed.parentDir) : null,
      autoSwitch: typeof parsed.autoSwitch === 'boolean' ? parsed.autoSwitch : true,
      currentRepo: typeof parsed.currentRepo === 'string' ? fwd(parsed.currentRepo) : null,
      iterationWindowMs: Number.isFinite(parsed.iterationWindowMs) && parsed.iterationWindowMs > 0
        ? Math.floor(parsed.iterationWindowMs)
        : DEFAULT_ITERATION_WINDOW_MS,
      createdAt: typeof parsed.createdAt === 'string' ? parsed.createdAt : null,
      updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : null,
      // needsSetup is derived, NOT persisted to disk.
      needsSetup: !parsed.parentDir,
    }
    this._current = merged
    this._loaded = true
    return this.get()
  }

  /**
   * Merge `partial` into the in-memory copy and atomically rewrite the
   * file. Returns the full updated prefs object.
   *
   * Atomicity: write the new contents to `preferences.json.tmp` and
   * then rename(.tmp, preferences.json). On POSIX rename is atomic
   * per the spec. On Windows it's atomic from a same-volume rename
   * (which our tmp always is, since we put it next to the target).
   *
   * Side effects:
   *   - Creates `~/.blastradius/` if missing (mode 0700 on POSIX).
   *   - chmod 0600 the prefs file on POSIX.
   *   - Updates `updatedAt` on every save; sets `createdAt` on first.
   */
  async save(partial = {}) {
    const merged = { ...this._current, ...normalize(partial) }
    const now = new Date().toISOString()
    merged.updatedAt = now
    if (!merged.createdAt) merged.createdAt = now
    merged.needsSetup = !merged.parentDir

    // Ensure the dir exists. mkdir is idempotent with recursive:true.
    await fs.mkdir(this.paths.dir, { recursive: true })
    if (platform() !== 'win32') {
      // Tighten the parent dir on POSIX. No-op on Windows.
      try { await fs.chmod(this.paths.dir, 0o700) } catch { /* best effort */ }
    }

    // Strip `needsSetup` from the on-disk shape — it's derived state.
    const onDisk = { ...merged }
    delete onDisk.needsSetup

    // Atomic write: tmp + rename.
    const json = `${JSON.stringify(onDisk, null, 2)}\n`
    await fs.writeFile(this.paths.tmp, json, { encoding: 'utf8', flag: 'w' })
    if (platform() !== 'win32') {
      try { await fs.chmod(this.paths.tmp, 0o600) } catch { /* best effort */ }
    }
    await fs.rename(this.paths.tmp, this.paths.file)

    this._current = merged
    this.logger.debug({ file: this.paths.file }, 'preferences saved')
    return this.get()
  }
}
