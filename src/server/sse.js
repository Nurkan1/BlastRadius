/**
 * SSE broadcaster.
 *
 * Server-Sent Events is the deliberate choice for the
 * dashboard ↔ server channel (no WebSocket). It buys us:
 *   - Auto-reconnect on the browser side via EventSource — no client
 *     code to write.
 *   - One-way is exactly what we need: the dashboard never sends data
 *     back over this channel; control flows over plain HTTP.
 *   - Plays well with HTTP/1.1 keep-alive and any reverse proxy that
 *     understands `text/event-stream` (we also send
 *     `X-Accel-Buffering: no` to disable nginx's buffering by default).
 *
 * Per-connection heartbeat every 25 seconds keeps the socket alive
 * through idle-timeout proxies. The heartbeat is an SSE comment
 * (`:hb\n\n`) so it never reaches `EventSource.onmessage` handlers.
 */

const HEARTBEAT_MS = 25_000

export class SSEBroadcaster {
  constructor() {
    /** @type {Set<import('http').ServerResponse>} */
    this.clients = new Set()
    /** @type {WeakMap<object, NodeJS.Timeout>} */
    this.heartbeats = new WeakMap()
  }

  /**
   * Attach an Express response as an SSE stream. Writes the SSE
   * headers, primes the connection with a comment line, schedules a
   * heartbeat, and registers cleanup on close.
   */
  addClient(res) {
    res.statusCode = 200
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8')
    res.setHeader('Cache-Control', 'no-cache, no-transform')
    res.setHeader('Connection', 'keep-alive')
    res.setHeader('X-Accel-Buffering', 'no')
    // Initial comment flushes the response head and signals "stream
    // open" to the client.
    res.write(': connected\n\n')

    this.clients.add(res)

    const hb = setInterval(() => {
      try {
        res.write(': hb\n\n')
      } catch {
        // The next broadcast will catch this and clean up.
      }
    }, HEARTBEAT_MS)
    hb.unref?.()
    this.heartbeats.set(res, hb)

    const cleanup = () => {
      const t = this.heartbeats.get(res)
      if (t) clearInterval(t)
      this.heartbeats.delete(res)
      this.clients.delete(res)
    }
    res.on('close', cleanup)
    res.on('error', cleanup)
  }

  /**
   * Send an event of the given type to every connected client.
   * Returns the number of clients the event reached (after pruning
   * dead sockets).
   */
  broadcast(eventType, data) {
    if (typeof eventType !== 'string' || !eventType) return 0
    const payload = `event: ${eventType}\ndata: ${JSON.stringify(data ?? {})}\n\n`
    let delivered = 0
    for (const res of [...this.clients]) {
      try {
        res.write(payload)
        delivered += 1
      } catch {
        // Socket gone — drop it.
        this.clients.delete(res)
        const t = this.heartbeats.get(res)
        if (t) clearInterval(t)
        this.heartbeats.delete(res)
      }
    }
    return delivered
  }

  size() {
    return this.clients.size
  }

  /** End all live connections and clear timers. Safe to call multiple times. */
  closeAll() {
    for (const res of [...this.clients]) {
      const t = this.heartbeats.get(res)
      if (t) clearInterval(t)
      this.heartbeats.delete(res)
      try { res.end() } catch { /* ignore */ }
    }
    this.clients.clear()
  }
}
