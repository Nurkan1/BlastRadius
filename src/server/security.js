/**
 * Security headers + simple rate limiter for the BlastRadius dashboard.
 *
 * Threat model
 * ────────────
 * BlastRadius runs as a local-only dashboard (binds to 127.0.0.1:7842 by
 * default — see BLASTRADIUS_HOST in src/server/index.js). It has no auth —
 * anyone who can reach the port can read every endpoint. So the goal of
 * these headers is NOT to defend against a remote attacker (the bind is
 * the boundary) but to defend the running tab against:
 *
 *   - A malicious page in ANOTHER tab that tries to read the dashboard
 *     via cross-origin requests (CORS already blocks reads; CSP +
 *     X-Frame-Options + CORP harden it further).
 *   - A clickjacked iframe somewhere else loading the dashboard.
 *   - XSS through any future input field that forgets to escape — the
 *     CSP keeps the blast radius small (no eval, no inline scripts).
 *
 * What we DO NOT set
 * ──────────────────
 *   - HSTS: dashboard runs on http://localhost, HSTS would be wrong.
 *   - CORS allow-origin: we don't allow cross-origin reads at all.
 *
 * The CSP is reasonably tight. The only third-party script we load is
 * D3 from unpkg (index.html line 270-ish); everything else is served
 * from this origin. `style-src 'unsafe-inline'` is defensive — diff2html
 * inserts HTML via innerHTML and a future version might include inline
 * style attributes; banning them outright would silently break the diff
 * modal. We do NOT allow `script-src 'unsafe-inline'` so XSS via
 * injected <script> remains blocked.
 */

/**
 * Express middleware that stamps a baseline set of security headers on
 * every response. Pure function over (req, res, next) — no IO, no state.
 */
export function securityHeaders() {
  // Precompute the CSP string once at module load.
  const csp = [
    "default-src 'self'",
    // D3 v7 from unpkg. If we ever vendor D3 locally too, this can
    // shrink to 'self'.
    "script-src 'self' https://unpkg.com",
    // Diff2html HTML may contain inline style attributes that we
    // can't nonce because the HTML is server-rendered by their lib.
    "style-src 'self' 'unsafe-inline'",
    // SSE + every /api/* call.
    "connect-src 'self'",
    // data: covers favicon embedding + future inline base64 assets.
    "img-src 'self' data:",
    // No web fonts are loaded; restrict to self anyway so any future
    // accidental external font URL is blocked.
    "font-src 'self'",
    // Refuse to be framed anywhere.
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "object-src 'none'",
  ].join('; ')

  return function securityHeadersMiddleware(req, res, next) {
    res.setHeader('Content-Security-Policy', csp)
    // Belt-and-suspenders for older browsers that don't honor
    // frame-ancestors. Modern browsers ignore X-Frame-Options when CSP
    // is present, so they're not redundant in practice.
    res.setHeader('X-Frame-Options', 'DENY')
    // Disable MIME-type sniffing — every JSON response should be
    // treated as JSON, not text/html that the browser might try to
    // render.
    res.setHeader('X-Content-Type-Options', 'nosniff')
    // Don't leak the full URL on outbound links/requests.
    res.setHeader('Referrer-Policy', 'no-referrer')
    // Cross-Origin-Resource-Policy: prevent another origin from
    // embedding our static assets (the JSONL log file path, the diff
    // HTML, etc.). same-origin is strictly tighter than same-site.
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin')
    // Tell the browser this page is a top-level isolated context.
    // Pairs with COEP if we ever add it; harmless alone.
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin')
    // Disable a long list of platform features we never use. Saves
    // a fingerprinting surface; costs us nothing.
    res.setHeader(
      'Permissions-Policy',
      'camera=(), microphone=(), geolocation=(), interest-cohort=(), payment=()',
    )
    next()
  }
}

/**
 * Token-bucket rate limiter, in-memory, per-IP. Stateless inside
 * (req, res, next) but the buckets Map is closed over so callers get
 * a self-contained middleware.
 *
 * Why hand-rolled and not `express-rate-limit`: no new dependency, the
 * algorithm is 30 lines, the only consumer is /api/diff. If we end up
 * needing per-route configs and X-RateLimit-* headers, the lib is fine
 * — until then, less surface area is better.
 *
 * @param {{
 *   maxTokens: number,            // bucket size (also max burst)
 *   refillTokens: number,         // tokens added per refill window
 *   refillIntervalMs: number,     // refill window length
 *   evictAfterMs?: number,        // drop idle buckets older than this
 *                                 //   (default: 10 minutes)
 *   onRateLimit?: Function,       // optional hook(req) for logging
 * }} opts
 */
export function makeRateLimiter(opts) {
  const {
    maxTokens,
    refillTokens,
    refillIntervalMs,
    evictAfterMs = 10 * 60 * 1000,
    onRateLimit,
  } = opts
  if (!(maxTokens > 0)) throw new Error('makeRateLimiter: maxTokens must be > 0')
  if (!(refillTokens > 0)) throw new Error('makeRateLimiter: refillTokens must be > 0')
  if (!(refillIntervalMs > 0)) throw new Error('makeRateLimiter: refillIntervalMs must be > 0')

  /** @type {Map<string, { tokens: number, lastRefill: number, lastSeen: number }>} */
  const buckets = new Map()

  function ipFor(req) {
    // Express's `req.ip` honors trust-proxy settings; we don't set that,
    // so it's effectively req.socket.remoteAddress on localhost. Fall
    // back gracefully if everything is undefined (some testing scenarios).
    return req.ip || req.socket?.remoteAddress || 'unknown'
  }

  function refill(bucket, now) {
    const elapsed = now - bucket.lastRefill
    if (elapsed < refillIntervalMs) return
    // How many full refill windows have passed? Each one tops the
    // bucket up by `refillTokens`, capped at `maxTokens`.
    const windows = Math.floor(elapsed / refillIntervalMs)
    bucket.tokens = Math.min(maxTokens, bucket.tokens + windows * refillTokens)
    bucket.lastRefill += windows * refillIntervalMs
  }

  function evictStale(now) {
    // Cheap, called inline on every request. The map stays tiny in
    // practice (one or two local IPs) so the iteration is negligible.
    if (buckets.size < 32) return
    for (const [ip, b] of buckets) {
      if (now - b.lastSeen > evictAfterMs) buckets.delete(ip)
    }
  }

  function rateLimitMiddleware(req, res, next) {
    const now = Date.now()
    const ip = ipFor(req)
    let bucket = buckets.get(ip)
    if (!bucket) {
      bucket = { tokens: maxTokens, lastRefill: now, lastSeen: now }
      buckets.set(ip, bucket)
    } else {
      refill(bucket, now)
      bucket.lastSeen = now
    }
    evictStale(now)

    if (bucket.tokens < 1) {
      // Suggest a sensible retry delay: the time until the next refill.
      const retryAfterSec = Math.max(
        1,
        Math.ceil((bucket.lastRefill + refillIntervalMs - now) / 1000),
      )
      res.setHeader('Retry-After', String(retryAfterSec))
      onRateLimit?.(req)
      res.status(429).json({
        error: 'rate_limited',
        message: 'Too many requests in a short window. Slow down and retry.',
        retryAfterSec,
      })
      return
    }
    bucket.tokens -= 1
    next()
  }

  /**
   * rc9.20: read-only view of the limiter for the system dashboard. Lazily
   * refills each bucket to `now` (idempotent — never grants more than a real
   * request would) and reports the config plus the most-depleted client's
   * remaining tokens. With no traffic, `minTokens` is `maxTokens` (full).
   */
  rateLimitMiddleware.snapshot = (now = Date.now()) => {
    let minTokens = maxTokens
    for (const b of buckets.values()) {
      refill(b, now)
      if (b.tokens < minTokens) minTokens = b.tokens
    }
    return {
      maxTokens,
      refillTokens,
      refillIntervalMs,
      activeBuckets: buckets.size,
      minTokens,
    }
  }

  return rateLimitMiddleware
}
