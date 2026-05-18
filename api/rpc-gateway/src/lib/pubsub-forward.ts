// Bidirectional WebSocket pipe: client ↔ upstream Solana JSON-RPC pubsub.
// Used to relay standard methods (accountSubscribe, logsSubscribe, etc.) to
// the richat PubSub endpoint (or any Solana-spec WS) while the gateway
// retains the connection for its enhanced WS methods.

export type PubsubForwardOptions = {
  upstreamUrl: string
  onUpstreamMessage: (raw: string) => void
  onUpstreamClose: () => void
  onUpstreamError: (err: unknown) => void
}

export class PubsubForward {
  private ws: WebSocket | null = null
  private buffered: string[] = []
  private opts: PubsubForwardOptions
  private opening = false

  constructor(opts: PubsubForwardOptions) {
    this.opts = opts
  }

  /** Lazily open the upstream connection. */
  ensureOpen(): void {
    if (this.ws || this.opening) return
    this.opening = true
    this.ws = new WebSocket(this.opts.upstreamUrl)
    this.ws.onopen = () => {
      this.opening = false
      const queued = this.buffered
      this.buffered = []
      for (const m of queued) this.ws?.send(m)
    }
    this.ws.onmessage = (e) => {
      this.opts.onUpstreamMessage(typeof e.data === 'string' ? e.data : '')
    }
    this.ws.onerror = (e) => this.opts.onUpstreamError(e)
    this.ws.onclose = () => {
      this.opts.onUpstreamClose()
      this.ws = null
    }
  }

  /** Forward one frame to upstream.  Buffers if upstream isn't open yet. */
  send(raw: string): void {
    this.ensureOpen()
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(raw)
    } else {
      this.buffered.push(raw)
    }
  }

  close(): void {
    try {
      this.ws?.close()
    } catch { /* ignore */ }
    this.ws = null
  }
}
