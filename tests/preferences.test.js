import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, statSync, chmodSync, mkdirSync } from 'node:fs'
import { tmpdir, platform } from 'node:os'
import { join, resolve } from 'node:path'

// path.resolve() makes its argument absolute relative to the *current
// drive* on Windows. So `resolve('/x')` → `C:/x` (or whatever drive is
// active). These helpers keep the test expectations platform-portable.
const abs = (p) => resolve(p).replace(/\\/g, '/')

import {
  PreferencesStore,
  emptyPreferences,
  getDefaultPaths,
  DEFAULT_ITERATION_WINDOW_MS,
} from '../src/server/preferences.js'

function paths(homeDir) {
  return getDefaultPaths(homeDir)
}

describe('emptyPreferences + getDefaultPaths', () => {
  it('emptyPreferences has needsSetup:true and sane defaults', () => {
    const e = emptyPreferences()
    expect(e.needsSetup).toBe(true)
    expect(e.parentDir).toBe(null)
    expect(e.currentRepo).toBe(null)
    expect(e.autoSwitch).toBe(true)
    expect(e.iterationWindowMs).toBe(DEFAULT_ITERATION_WINDOW_MS)
  })

  it('getDefaultPaths composes ~/.blastradius/preferences.json', () => {
    const p = getDefaultPaths('/home/u')
    expect(p.dir.replace(/\\/g, '/').endsWith('/.blastradius')).toBe(true)
    expect(p.file.endsWith('preferences.json')).toBe(true)
    expect(p.tmp.endsWith('preferences.json.tmp')).toBe(true)
  })
})

// ─── load() ─────────────────────────────────────────────────────────────────

describe('PreferencesStore.load', () => {
  let home

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'br-prefs-'))
  })

  afterEach(() => {
    if (home) rmSync(home, { recursive: true, force: true })
  })

  it('returns wizard state when file does not exist (no warn log)', async () => {
    const store = new PreferencesStore({ homeDir: home })
    const got = await store.load()
    expect(got.needsSetup).toBe(true)
    expect(got.parentDir).toBe(null)
  })

  it('reads a valid file end-to-end', async () => {
    const { dir, file } = paths(home)
    mkdirSync(dir, { recursive: true })
    writeFileSync(file, JSON.stringify({
      parentDir: '/x/code',
      autoSwitch: false,
      currentRepo: '/x/code/foo',
      iterationWindowMs: 60_000,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-02-01T00:00:00.000Z',
    }))

    const store = new PreferencesStore({ homeDir: home })
    const got = await store.load()
    expect(got.parentDir).toBe('/x/code')
    expect(got.autoSwitch).toBe(false)
    expect(got.currentRepo).toBe('/x/code/foo')
    expect(got.iterationWindowMs).toBe(60_000)
    expect(got.needsSetup).toBe(false)
  })

  it('falls back to wizard on corrupt JSON (file preserved)', async () => {
    const { dir, file } = paths(home)
    mkdirSync(dir, { recursive: true })
    writeFileSync(file, '{ this is : not json')

    const store = new PreferencesStore({ homeDir: home })
    const got = await store.load()
    expect(got.needsSetup).toBe(true)
    // File is preserved for the user to inspect
    expect(existsSync(file)).toBe(true)
  })

  it('falls back to wizard when JSON root is not an object', async () => {
    const { dir, file } = paths(home)
    mkdirSync(dir, { recursive: true })
    writeFileSync(file, JSON.stringify('a string'))

    const store = new PreferencesStore({ homeDir: home })
    const got = await store.load()
    expect(got.needsSetup).toBe(true)
  })

  it('fills missing fields with defaults', async () => {
    const { dir, file } = paths(home)
    mkdirSync(dir, { recursive: true })
    writeFileSync(file, JSON.stringify({ parentDir: '/x/code' }))

    const store = new PreferencesStore({ homeDir: home })
    const got = await store.load()
    expect(got.parentDir).toBe('/x/code')
    expect(got.autoSwitch).toBe(true) // default
    expect(got.iterationWindowMs).toBe(DEFAULT_ITERATION_WINDOW_MS) // default
    expect(got.needsSetup).toBe(false)
  })

  it('Windows-style paths are normalized to forward slashes on read', async () => {
    const { dir, file } = paths(home)
    mkdirSync(dir, { recursive: true })
    writeFileSync(file, JSON.stringify({
      parentDir: 'C:\\code',
      currentRepo: 'C:\\code\\foo',
    }))

    const store = new PreferencesStore({ homeDir: home })
    const got = await store.load()
    expect(got.parentDir).toBe('C:/code')
    expect(got.currentRepo).toBe('C:/code/foo')
  })

  it('rejects negative or non-numeric iterationWindowMs by using default', async () => {
    const { dir, file } = paths(home)
    mkdirSync(dir, { recursive: true })
    writeFileSync(file, JSON.stringify({ parentDir: '/x', iterationWindowMs: -1 }))

    const store = new PreferencesStore({ homeDir: home })
    const got = await store.load()
    expect(got.iterationWindowMs).toBe(DEFAULT_ITERATION_WINDOW_MS)
  })
})

// ─── save() ─────────────────────────────────────────────────────────────────

describe('PreferencesStore.save', () => {
  let home

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'br-prefs-'))
  })

  afterEach(() => {
    if (home) rmSync(home, { recursive: true, force: true })
  })

  it('creates the dir + file on first save', async () => {
    const store = new PreferencesStore({ homeDir: home })
    await store.load()
    const got = await store.save({ parentDir: '/x/code' })
    const { dir, file } = paths(home)
    expect(existsSync(dir)).toBe(true)
    expect(existsSync(file)).toBe(true)
    expect(got.parentDir).toBe(abs('/x/code'))
    expect(got.needsSetup).toBe(false)
  })

  it('sets createdAt on first save and only updates updatedAt afterwards', async () => {
    const store = new PreferencesStore({ homeDir: home })
    await store.load()
    const first = await store.save({ parentDir: '/x' })
    expect(first.createdAt).toBeTruthy()
    expect(first.updatedAt).toBe(first.createdAt)

    await new Promise((r) => setTimeout(r, 10))
    const second = await store.save({ autoSwitch: false })
    expect(second.createdAt).toBe(first.createdAt)   // unchanged
    expect(second.updatedAt > first.updatedAt).toBe(true)
  })

  it('merges partial input with existing state', async () => {
    const store = new PreferencesStore({ homeDir: home })
    await store.load()
    await store.save({ parentDir: '/x', autoSwitch: false })
    const got = await store.save({ currentRepo: '/x/foo' })
    expect(got.parentDir).toBe(abs('/x'))
    expect(got.autoSwitch).toBe(false)
    expect(got.currentRepo).toBe(abs('/x/foo'))
  })

  it('writes valid JSON that load() can round-trip', async () => {
    const store = new PreferencesStore({ homeDir: home })
    await store.load()
    await store.save({
      parentDir: '/x',
      autoSwitch: false,
      currentRepo: '/x/foo',
      iterationWindowMs: 90_000,
    })
    const { file } = paths(home)
    const raw = readFileSync(file, 'utf8')
    expect(() => JSON.parse(raw)).not.toThrow()

    // Fresh store reads the same back.
    const store2 = new PreferencesStore({ homeDir: home })
    const reloaded = await store2.load()
    expect(reloaded.parentDir).toBe(abs('/x'))
    expect(reloaded.autoSwitch).toBe(false)
    expect(reloaded.iterationWindowMs).toBe(90_000)
  })

  it('uses atomic write — does not leave a .tmp file behind', async () => {
    const store = new PreferencesStore({ homeDir: home })
    await store.load()
    await store.save({ parentDir: '/x' })
    const { tmp } = paths(home)
    expect(existsSync(tmp)).toBe(false)
  })

  it('does not persist `needsSetup` to disk', async () => {
    const store = new PreferencesStore({ homeDir: home })
    await store.load()
    await store.save({ parentDir: '/x' })
    const { file } = paths(home)
    const onDisk = JSON.parse(readFileSync(file, 'utf8'))
    expect('needsSetup' in onDisk).toBe(false)
  })

  it('rejects invalid types fast', async () => {
    const store = new PreferencesStore({ homeDir: home })
    await store.load()
    await expect(store.save({ parentDir: 42 })).rejects.toThrow(TypeError)
    await expect(store.save({ iterationWindowMs: -1 })).rejects.toThrow(TypeError)
    await expect(store.save({ iterationWindowMs: 'oops' })).rejects.toThrow(TypeError)
    await expect(store.save({ currentRepo: {} })).rejects.toThrow(TypeError)
    await expect(store.save(null)).rejects.toThrow(TypeError)
  })

  // ─── rc8: viewMode ───────────────────────────────────────────────────────
  it('accepts viewMode "tree" and "graph" and persists across reloads', async () => {
    const store = new PreferencesStore({ homeDir: home })
    await store.load()
    expect(store.get().viewMode).toBe('tree') // default for fresh prefs

    await store.save({ parentDir: '/x', viewMode: 'graph' })
    expect(store.get().viewMode).toBe('graph')

    // Reload reads the same value from disk.
    const store2 = new PreferencesStore({ homeDir: home })
    const reloaded = await store2.load()
    expect(reloaded.viewMode).toBe('graph')

    // Switching back also persists.
    await store2.save({ viewMode: 'tree' })
    expect(store2.get().viewMode).toBe('tree')
  })

  it('rejects unknown viewMode values', async () => {
    const store = new PreferencesStore({ homeDir: home })
    await store.load()
    await expect(store.save({ viewMode: 'galaxy' })).rejects.toThrow(TypeError)
    await expect(store.save({ viewMode: '' })).rejects.toThrow(TypeError)
    await expect(store.save({ viewMode: 42 })).rejects.toThrow(TypeError)
  })

  it('falls back to tree when on-disk viewMode is unknown', async () => {
    // Simulate a forward-compat scenario: someone hand-edited the file
    // to a value this version doesn't support, or a future version
    // wrote one we don't recognize.
    const { dir, file } = paths(home)
    mkdirSync(dir, { recursive: true })
    writeFileSync(file, JSON.stringify({ parentDir: '/x', viewMode: 'galaxy' }))
    const store = new PreferencesStore({ homeDir: home })
    const got = await store.load()
    expect(got.viewMode).toBe('tree')
  })

  it.runIf(platform() !== 'win32')('chmods the prefs file to 600 on POSIX', async () => {
    const store = new PreferencesStore({ homeDir: home })
    await store.load()
    await store.save({ parentDir: '/x' })
    const { file } = paths(home)
    const mode = statSync(file).mode & 0o777
    expect(mode).toBe(0o600)
  })

  it.runIf(platform() !== 'win32')('chmods the prefs dir to 700 on POSIX', async () => {
    const store = new PreferencesStore({ homeDir: home })
    await store.load()
    await store.save({ parentDir: '/x' })
    const { dir } = paths(home)
    const mode = statSync(dir).mode & 0o777
    expect(mode).toBe(0o700)
  })
})

// ─── needsSetup behavior ────────────────────────────────────────────────────

describe('needsSetup transitions', () => {
  let home

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'br-prefs-'))
  })

  afterEach(() => {
    if (home) rmSync(home, { recursive: true, force: true })
  })

  it('needsSetup flips to false when parentDir is saved', async () => {
    const store = new PreferencesStore({ homeDir: home })
    expect((await store.load()).needsSetup).toBe(true)
    expect((await store.save({ parentDir: '/x' })).needsSetup).toBe(false)
  })

  it('needsSetup goes back to true if parentDir is cleared explicitly', async () => {
    const store = new PreferencesStore({ homeDir: home })
    await store.load()
    await store.save({ parentDir: '/x' })
    const got = await store.save({ parentDir: null })
    expect(got.needsSetup).toBe(true)
  })
})

// ─── Recovery from a stranded .tmp from a prior crash ───────────────────────

describe('recovery from leftover .tmp', () => {
  let home

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'br-prefs-'))
  })

  afterEach(() => {
    if (home) rmSync(home, { recursive: true, force: true })
  })

  it('a stale .tmp file does not poison the next save', async () => {
    const { dir, file, tmp } = paths(home)
    mkdirSync(dir, { recursive: true })
    writeFileSync(tmp, '{ stale: half-write }') // simulate prior crash

    const store = new PreferencesStore({ homeDir: home })
    await store.load() // file doesn't exist yet → wizard
    await store.save({ parentDir: '/x' })

    // After save the real file exists with valid JSON; tmp is gone.
    expect(existsSync(file)).toBe(true)
    expect(existsSync(tmp)).toBe(false)
    expect(() => JSON.parse(readFileSync(file, 'utf8'))).not.toThrow()
  })
})
