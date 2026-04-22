import type { ChatCallbacks } from '/src/ai/console/consoleAction.ts'
import { errToString } from '/lib/errToString.ts'

/**
 * WebSocket client that lets the TUI talk to a local gateway's
 * `session.send` as if it were a direct provider. Implements the
 * same 4-method shape existing providers expose (`constructor` /
 * `setSystemPrompt` / `chat` / `abort`) so `consoleAction.ts` can
 * swap this in at the provider-init site with no further TUI
 * changes.
 *
 * Phase 2D-v3: one persistent WebSocket per TUI session.
 *
 *   - `ensureConnected()` opens + authenticates lazily on first
 *     chat(). Subsequent chat() calls reuse the socket, amortising
 *     the handshake cost and — more importantly — making
 *     `abort()` deliverable without opening a second connection.
 *   - If the server drops us (gateway restart), the next chat()
 *     transparently reopens.
 *   - `abort()` fires `session.abort` over the live socket so the
 *     gateway cancels the in-flight provider loop. The server emits
 *     `aborted`, which chat()'s terminal promise resolves on.
 *
 * Translation from gateway events → ChatCallbacks:
 *
 *   - `text_delta` → accumulate and fire `onStream(fullText)` since
 *     providers are contractually cumulative.
 *   - `tool_use_start` → `onToolCall(name, argsJson)`.
 *   - `tool_stdout` → `onToolStdout?(line)` — renders through the
 *     TUI's existing progress viewport so cargo builds etc. feel
 *     identical to the in-process path.
 *   - `tool_progress` → `onToolProgress?(label)`.
 *   - `complete` / `aborted` → `onComplete()` and resolve.
 *   - `error` → reject so the caller's try/catch fires.
 */
export class GatewaySessionProvider {
  private systemPrompt: string
  private callbacks: ChatCallbacks
  private ws: WebSocket | null = null
  private pendingCalls = new Map<
    string,
    (res: { ok: boolean; payload?: unknown; error?: string }) => void
  >()
  private nextCallId = 0
  // When a chat is in flight we store its event handlers here so
  // message dispatch (which is WS-global) can route events to the
  // right promise without juggling per-message listeners.
  private activeChat: {
    onEvent: (event: string, payload: Record<string, unknown>) => void
  } | null = null

  constructor(
    private wsUrl: string,
    private token: string,
    _model: string,
    systemPrompt: string,
    callbacks: ChatCallbacks,
  ) {
    this.systemPrompt = systemPrompt
    this.callbacks = callbacks
  }

  setSystemPrompt(systemPrompt: string): void {
    this.systemPrompt = systemPrompt
  }

  /** Close the socket and reject any pending calls. Called on TUI exit. */
  dispose(): void {
    this.pendingCalls.forEach((fn) =>
      fn({ ok: false, error: 'client disposed' })
    )
    this.pendingCalls.clear()
    if (this.ws && this.ws.readyState !== WebSocket.CLOSED) {
      try {
        this.ws.close()
      } catch { /* ignore */ }
    }
    this.ws = null
  }

  /**
   * Request the gateway cancel the in-flight session. Fire-and-
   * forget: the server emits an `aborted` event which the in-flight
   * `chat()` resolves on. Safe to call when nothing is running —
   * the server returns `wasRunning: false`.
   */
  abort(): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return
    try {
      this.ws.send(JSON.stringify({
        kind: 'req',
        id: `a${++this.nextCallId}`,
        method: 'session.abort',
      }))
    } catch { /* socket closing — nothing to do */ }
  }

  async chat(userMessage: string): Promise<void> {
    await this.ensureConnected()

    let accumulated = ''
    let terminalResolve: (() => void) | null = null
    let terminalReject: ((err: Error) => void) | null = null
    const terminal = new Promise<void>((resolve, reject) => {
      terminalResolve = resolve
      terminalReject = reject
    })

    this.activeChat = {
      onEvent: (eventName, payload) => {
        const type = payload.type as string | undefined
        switch (type) {
          case 'text_delta': {
            const delta = (payload.text as string) ?? ''
            accumulated += delta
            this.callbacks.onStream(accumulated)
            break
          }
          case 'tool_use_start': {
            const name = (payload.name as string) ?? 'unknown'
            const args = payload.args
            const detail = typeof args === 'string'
              ? args
              : JSON.stringify(args ?? {})
            this.callbacks.onToolCall(name, detail)
            break
          }
          case 'tool_stdout': {
            const text = (payload.text as string) ?? ''
            this.callbacks.onToolStdout?.(text)
            break
          }
          case 'tool_progress': {
            const label = (payload.label as string) ?? ''
            this.callbacks.onToolProgress?.(label)
            break
          }
          case 'complete':
          case 'aborted':
            this.callbacks.onComplete()
            terminalResolve?.()
            break
          case 'error': {
            const msg = (payload.message as string) ?? 'unknown error'
            terminalReject?.(new Error(msg))
            break
          }
        }
        // Silence unused-param lint: server's `event` field mirrors
        // payload.type today. Retained for debugging.
        void eventName
      },
    }

    try {
      const sent = await this.call('session.send', { text: userMessage })
      if (!sent.ok) throw new Error(sent.error ?? 'session.send rejected')
      // Also surface the system prompt the next time we're wired
      // end-to-end; gateway currently ignores it.
      void this.systemPrompt
      await terminal
    } finally {
      this.activeChat = null
    }
  }

  // ---- private plumbing ----

  private async ensureConnected(): Promise<void> {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) return
    this.ws = new WebSocket(this.wsUrl)
    await new Promise<void>((resolve, reject) => {
      this.ws!.addEventListener('open', () => resolve(), { once: true })
      this.ws!.addEventListener('error', () => {
        reject(new Error("can't reach the SLV background service"))
      }, { once: true })
    }).catch((err) => {
      this.ws = null
      throw new Error(errToString(err))
    })

    this.ws.addEventListener('message', (ev) => this.onMessage(ev))
    this.ws.addEventListener('close', () => this.onClose())

    const hello = await this.call('gateway.hello')
    if (!hello.ok) throw new Error(`gateway rejected hello: ${hello.error}`)

    const auth = await this.call('gateway.auth', { token: this.token })
    if (!auth.ok) {
      throw new Error(
        'gateway rejected authentication — try deleting ~/.slv/gateway/gateway.json and rerunning',
      )
    }
  }

  private onMessage(ev: MessageEvent): void {
    let f: {
      kind: string
      id?: string
      ok?: boolean
      payload?: unknown
      error?: string
      event?: string
    }
    try {
      f = JSON.parse(String(ev.data))
    } catch {
      return
    }
    if (f.kind === 'res' && typeof f.id === 'string') {
      const r = this.pendingCalls.get(f.id)
      if (r) {
        this.pendingCalls.delete(f.id)
        r({ ok: !!f.ok, payload: f.payload, error: f.error })
      }
      return
    }
    if (f.kind === 'event' && this.activeChat) {
      const payload = (f.payload ?? {}) as Record<string, unknown>
      this.activeChat.onEvent(f.event ?? '', payload)
    }
  }

  private onClose(): void {
    // If a chat was in flight, surface a clean error so the caller
    // isn't left waiting forever. The next chat() will transparently
    // reconnect.
    if (this.activeChat) {
      // terminalReject isn't directly reachable here — route via a
      // synthetic error event.
      this.activeChat.onEvent('error', {
        type: 'error',
        message: 'connection to SLV background service was lost',
      })
      this.activeChat = null
    }
    // Reject any outstanding RPC calls too.
    this.pendingCalls.forEach((fn) =>
      fn({ ok: false, error: 'connection closed' })
    )
    this.pendingCalls.clear()
    this.ws = null
  }

  private call(
    method: string,
    params?: unknown,
  ): Promise<{ ok: boolean; payload?: unknown; error?: string }> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return Promise.resolve({
        ok: false,
        error: 'not connected to gateway',
      })
    }
    return new Promise((resolve) => {
      const id = `c${++this.nextCallId}`
      this.pendingCalls.set(id, resolve)
      this.ws!.send(JSON.stringify({ kind: 'req', id, method, params }))
    })
  }
}
