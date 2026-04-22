import type { ChatCallbacks } from '/src/ai/console/consoleAction.ts'
import { errToString } from '/lib/errToString.ts'

/**
 * Minimal WebSocket client that lets the TUI talk to a local
 * gateway's `session.send` as if it were a direct provider.
 *
 * Implements the same 4-method shape existing providers expose
 * (`constructor / setSystemPrompt / chat`) so `consoleAction.ts` can
 * swap this in at the provider-init site with no further TUI
 * changes. Under the hood it opens one WS per chat() turn (simple
 * and stateless; connection reuse is a future optimisation).
 *
 * Translation from gateway events → existing ChatCallbacks:
 *
 *   - `text_delta` → accumulate and fire `onStream(fullText)` since
 *     providers are contractually cumulative.
 *   - `tool_use_start` → `onToolCall(name, argsJson)`.
 *   - `complete` / `aborted` → `onComplete()` and resolve.
 *   - `error` → resolve with an Error so the caller's catch fires.
 *
 * Notes for the Phase 2D-v1 surface:
 *
 *   - `systemPrompt` is accepted for API parity but NOT yet
 *     forwarded (gateway's session.send doesn't thread it today —
 *     tracked as a future enhancement).
 *   - Tool use will surface as `onToolCall` but the gateway's
 *     Session doesn't actually execute tools yet — that's Phase
 *     2D-v2. Users who rely on tools today should stay off
 *     `--via-gateway` until v2 lands.
 */
export class GatewaySessionProvider {
  private systemPrompt: string
  private callbacks: ChatCallbacks

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

  async chat(userMessage: string): Promise<void> {
    // Open a fresh WS per turn. Simpler than keeping a long-lived
    // connection, and robust against the gateway restarting —
    // each turn reconnects.
    const ws = new WebSocket(this.wsUrl)
    const opened = new Promise<void>((resolve, reject) => {
      const onErr = () => reject(new Error('could not connect to gateway'))
      ws.addEventListener('open', () => resolve(), { once: true })
      ws.addEventListener('error', onErr, { once: true })
    })
    try {
      await opened
    } catch (err) {
      throw new Error(
        `can't reach the SLV background service: ${errToString(err)}`,
      )
    }

    const pending = new Map<
      string,
      (f: { ok: boolean; payload?: unknown; error?: string }) => void
    >()
    let nextId = 0
    const call = (method: string, params?: unknown) =>
      new Promise<{ ok: boolean; payload?: unknown; error?: string }>((res) => {
        const id = `c${++nextId}`
        pending.set(id, res)
        ws.send(JSON.stringify({ kind: 'req', id, method, params }))
      })

    let accumulated = ''
    let terminalResolve: (() => void) | null = null
    let terminalReject: ((err: Error) => void) | null = null
    const terminal = new Promise<void>((resolve, reject) => {
      terminalResolve = resolve
      terminalReject = reject
    })

    ws.addEventListener('message', (ev) => {
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
        const r = pending.get(f.id)
        if (r) {
          pending.delete(f.id)
          r({ ok: !!f.ok, payload: f.payload, error: f.error })
        }
        return
      }
      if (f.kind !== 'event') return
      const payload = f.payload as { type?: string } | undefined
      switch (payload?.type) {
        case 'text_delta': {
          const delta = (payload as { text?: string }).text ?? ''
          accumulated += delta
          this.callbacks.onStream(accumulated)
          break
        }
        case 'tool_use_start': {
          const p = payload as { name?: string; args?: unknown }
          const name = p.name ?? 'unknown'
          const detail = typeof p.args === 'string'
            ? p.args
            : JSON.stringify(p.args ?? {})
          this.callbacks.onToolCall(name, detail)
          break
        }
        case 'tool_stdout': {
          const text = (payload as { text?: string }).text ?? ''
          this.callbacks.onToolStdout?.(text)
          break
        }
        case 'tool_progress': {
          const label = (payload as { label?: string }).label ?? ''
          this.callbacks.onToolProgress?.(label)
          break
        }
        case 'complete':
        case 'aborted':
          this.callbacks.onComplete()
          terminalResolve?.()
          break
        case 'error': {
          const msg = (payload as { message?: string }).message ?? 'unknown error'
          terminalReject?.(new Error(msg))
          break
        }
      }
    })

    ws.addEventListener('close', () => {
      // If close arrives before a terminal event, surface as an
      // error so the TUI doesn't hang forever.
      terminalReject?.(new Error('connection to SLV background service was lost'))
    })

    try {
      const hello = await call('gateway.hello')
      if (!hello.ok) throw new Error(`gateway rejected hello: ${hello.error}`)

      const auth = await call('gateway.auth', { token: this.token })
      if (!auth.ok) {
        throw new Error(
          `gateway rejected authentication — try deleting ~/.slv/gateway/gateway.json and rerunning`,
        )
      }

      // Apply system prompt if we have one — the gateway ignores
      // it today but this is where it'll land when wired.
      if (this.systemPrompt) {
        // params.systemPrompt is reserved for the future gateway
        // upgrade; no-op today.
      }

      const sent = await call('session.send', { text: userMessage })
      if (!sent.ok) throw new Error(sent.error ?? 'session.send rejected')

      await terminal
    } finally {
      try {
        ws.close()
      } catch { /* ignore */ }
    }
  }

  async abort(): Promise<void> {
    // No-op for Phase 2D-v1: the per-turn WS client isn't persistent
    // enough to route abort reliably. Ctrl+C still kills any child
    // process via the TUI's existing handler. Session-level abort
    // over WS arrives with connection reuse in Phase 2D-v2.
  }
}
