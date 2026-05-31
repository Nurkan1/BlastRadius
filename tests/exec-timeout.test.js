/**
 * Execution-timeout primitive (rc9.15).
 *
 * Both the git diff path (simple-git `timeout.block`) and the
 * dependency-cruiser graph build use a hard execution ceiling so a
 * pathological or gigantic repo can never hang the dashboard. The graph build
 * uses this `withTimeout` helper; these tests pin its contract: a fast op
 * resolves untouched, a slow op rejects with a typed `timeout` error, and the
 * internal timer is always cleared (no leaked handles).
 */

import { describe, it, expect, vi } from 'vitest'
import { withTimeout } from '../src/server/graphResolver.js'

describe('withTimeout', () => {
  it('resolves with the value when the promise settles in time', async () => {
    const fast = new Promise((resolve) => setTimeout(() => resolve('ok'), 5))
    await expect(withTimeout(fast, 1000, 'fast')).resolves.toBe('ok')
  })

  it('rejects with a typed timeout error when the promise is too slow', async () => {
    const slow = new Promise((resolve) => {
      const t = setTimeout(() => resolve('late'), 10_000)
      t.unref?.()
    })
    await expect(withTimeout(slow, 20, 'slow-op')).rejects.toMatchObject({ code: 'timeout' })
    await expect(withTimeout(slow, 20, 'slow-op')).rejects.toThrow(/exceeded 20ms.*slow-op/)
  })

  it('propagates the underlying rejection when the promise fails fast', async () => {
    const boom = Promise.reject(new Error('upstream failure'))
    await expect(withTimeout(boom, 1000, 'boom')).rejects.toThrow('upstream failure')
  })

  it('clears its internal timer so a resolved op leaks no pending handle', async () => {
    const clearSpy = vi.spyOn(globalThis, 'clearTimeout')
    await withTimeout(Promise.resolve('done'), 1000, 'clean')
    expect(clearSpy).toHaveBeenCalled()
    clearSpy.mockRestore()
  })
})
