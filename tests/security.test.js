import { describe, it, expect, vi } from 'vitest'
import { securityHeaders, makeRateLimiter } from '../src/server/security.js'

// ─── Fake req/res factory ────────────────────────────────────────────────────

function fakeReq({ ip = '127.0.0.1', socket } = {}) {
  return { ip, socket: socket ?? { remoteAddress: ip } }
}

function fakeRes() {
  const headers = {}
  const res = {
    statusCode: 200,
    setHeader(name, value) { headers[name] = value },
    getHeader(name) { return headers[name] },
    headers,
    status(code) { this.statusCode = code; return this },
    json(body) { this.body = body; return this },
  }
  return res
}

// ─── securityHeaders ────────────────────────────────────────────────────────

describe('securityHeaders()', () => {
  it('stamps the full set of expected headers', () => {
    const mw = securityHeaders()
    const req = fakeReq()
    const res = fakeRes()
    const next = vi.fn()
    mw(req, res, next)
    expect(next).toHaveBeenCalledOnce()
    expect(res.getHeader('Content-Security-Policy')).toBeTruthy()
    expect(res.getHeader('X-Frame-Options')).toBe('DENY')
    expect(res.getHeader('X-Content-Type-Options')).toBe('nosniff')
    expect(res.getHeader('Referrer-Policy')).toBe('no-referrer')
    expect(res.getHeader('Cross-Origin-Resource-Policy')).toBe('same-origin')
    expect(res.getHeader('Cross-Origin-Opener-Policy')).toBe('same-origin')
    expect(res.getHeader('Permissions-Policy')).toContain('camera=()')
  })

  it('CSP allows the third-party scripts BlastRadius actually loads', () => {
    const mw = securityHeaders()
    const res = fakeRes()
    mw(fakeReq(), res, () => {})
    const csp = res.getHeader('Content-Security-Policy')
    // D3 from unpkg is the only allowed external script source.
    expect(csp).toMatch(/script-src[^;]+https:\/\/unpkg\.com/)
    // Default-src locked to self.
    expect(csp).toMatch(/default-src 'self'/)
    // SSE + /api/* connect surface stays on self.
    expect(csp).toMatch(/connect-src 'self'/)
    // No eval / inline scripts allowed.
    expect(csp).not.toMatch(/script-src[^;]*'unsafe-inline'/)
    expect(csp).not.toMatch(/script-src[^;]*'unsafe-eval'/)
    // Frame embedding refused.
    expect(csp).toMatch(/frame-ancestors 'none'/)
  })

  it('does not set HSTS (dashboard is http://localhost)', () => {
    const mw = securityHeaders()
    const res = fakeRes()
    mw(fakeReq(), res, () => {})
    expect(res.getHeader('Strict-Transport-Security')).toBeUndefined()
  })

  it('precomputes the CSP — same string across requests', () => {
    const mw = securityHeaders()
    const res1 = fakeRes()
    const res2 = fakeRes()
    mw(fakeReq(), res1, () => {})
    mw(fakeReq(), res2, () => {})
    expect(res1.getHeader('Content-Security-Policy'))
      .toBe(res2.getHeader('Content-Security-Policy'))
  })
})

// ─── makeRateLimiter ────────────────────────────────────────────────────────

describe('makeRateLimiter()', () => {
  it('throws on bad config', () => {
    expect(() => makeRateLimiter({ maxTokens: 0, refillTokens: 1, refillIntervalMs: 1000 }))
      .toThrow(/maxTokens/)
    expect(() => makeRateLimiter({ maxTokens: 1, refillTokens: 0, refillIntervalMs: 1000 }))
      .toThrow(/refillTokens/)
    expect(() => makeRateLimiter({ maxTokens: 1, refillTokens: 1, refillIntervalMs: 0 }))
      .toThrow(/refillIntervalMs/)
  })

  it('allows up to maxTokens requests in a single burst', () => {
    const mw = makeRateLimiter({ maxTokens: 3, refillTokens: 1, refillIntervalMs: 10_000 })
    const req = fakeReq()
    let allowed = 0
    for (let i = 0; i < 3; i += 1) {
      const res = fakeRes()
      const next = vi.fn()
      mw(req, res, next)
      if (next.mock.calls.length > 0) allowed += 1
    }
    expect(allowed).toBe(3)
  })

  it('blocks request 4 in a burst of 3 capacity and returns 429 + Retry-After', () => {
    const mw = makeRateLimiter({ maxTokens: 3, refillTokens: 1, refillIntervalMs: 10_000 })
    const req = fakeReq()
    for (let i = 0; i < 3; i += 1) mw(req, fakeRes(), () => {})
    const res = fakeRes()
    const next = vi.fn()
    mw(req, res, next)
    expect(next).not.toHaveBeenCalled()
    expect(res.statusCode).toBe(429)
    expect(res.body.error).toBe('rate_limited')
    expect(res.body.retryAfterSec).toBeGreaterThan(0)
    expect(res.getHeader('Retry-After')).toBeTruthy()
  })

  it('refills after the interval and lets requests through again', async () => {
    const mw = makeRateLimiter({ maxTokens: 2, refillTokens: 1, refillIntervalMs: 50 })
    const req = fakeReq()
    mw(req, fakeRes(), () => {})
    mw(req, fakeRes(), () => {})
    // bucket now empty
    const blocked = fakeRes()
    mw(req, blocked, () => {})
    expect(blocked.statusCode).toBe(429)
    // Wait one refill window.
    await new Promise((r) => setTimeout(r, 70))
    const next = vi.fn()
    mw(req, fakeRes(), next)
    expect(next).toHaveBeenCalledOnce()
  })

  it('different IPs have independent buckets', () => {
    const mw = makeRateLimiter({ maxTokens: 1, refillTokens: 1, refillIntervalMs: 60_000 })
    const next1 = vi.fn()
    const next2 = vi.fn()
    mw(fakeReq({ ip: '10.0.0.1' }), fakeRes(), next1)
    mw(fakeReq({ ip: '10.0.0.2' }), fakeRes(), next2)
    expect(next1).toHaveBeenCalledOnce()
    expect(next2).toHaveBeenCalledOnce()
  })

  it('same IP from a follow-up request shares the bucket', () => {
    const mw = makeRateLimiter({ maxTokens: 1, refillTokens: 1, refillIntervalMs: 60_000 })
    const req = fakeReq({ ip: '10.0.0.7' })
    const first = fakeRes()
    const second = fakeRes()
    mw(req, first, () => {})
    mw(req, second, () => {})
    expect(second.statusCode).toBe(429)
  })

  it('falls back to socket.remoteAddress when req.ip is missing', () => {
    const mw = makeRateLimiter({ maxTokens: 1, refillTokens: 1, refillIntervalMs: 60_000 })
    const req = { ip: undefined, socket: { remoteAddress: '10.0.0.99' } }
    const next = vi.fn()
    mw(req, fakeRes(), next)
    expect(next).toHaveBeenCalledOnce()
  })

  it('calls onRateLimit hook when a request is blocked', () => {
    const onRateLimit = vi.fn()
    const mw = makeRateLimiter({
      maxTokens: 1, refillTokens: 1, refillIntervalMs: 60_000,
      onRateLimit,
    })
    const req = fakeReq()
    mw(req, fakeRes(), () => {})
    mw(req, fakeRes(), () => {}) // blocked
    expect(onRateLimit).toHaveBeenCalledOnce()
    expect(onRateLimit.mock.calls[0][0]).toBe(req)
  })
})
