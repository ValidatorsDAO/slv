import type {
  SessionEvent,
  SessionEventListener,
} from '/src/ai/core/events.ts'
import type { MessageInput } from '/src/ai/core/messageInput.ts'
import { getMessageText } from '/src/ai/core/messageInput.ts'

/**
 * Session drives a single chat run. It's driver-agnostic: pass any
 * async function that produces `SessionEvent`s via the supplied
 * `emit` callback, and the Session takes care of:
 *
 *   - listener management (subscribe/unsubscribe with cleanup)
 *   - AbortController wiring (so Ctrl+C / WS `session.abort` can
 *     cancel in-flight work)
 *   - terminal-event guarantees (`complete` | `aborted` | `error`
 *     always fires exactly once, even if the driver throws)
 *
 * Phase 2B ships the echo driver (below) for end-to-end wire tests.
 * The real provider driver lands in the next PR — Session itself
 * doesn't need to change.
 */
export type SessionDriver = (
  input: MessageInput,
  ctx: {
    emit: (event: SessionEvent) => void
    signal: AbortSignal
  },
) => Promise<void>

export class Session {
  private listeners = new Set<SessionEventListener>()
  private abortController: AbortController | null = null
  private sending = false

  constructor(private driver: SessionDriver) {}

  on(fn: SessionEventListener): () => void {
    this.listeners.add(fn)
    return () => {
      this.listeners.delete(fn)
    }
  }

  get isRunning(): boolean {
    return this.sending
  }

  /**
   * Kick off a turn. Returns when the driver settles. Every emitted
   * event reaches every listener synchronously in `on`-registration
   * order. Exactly one terminal event (`complete` | `aborted` |
   * `error`) fires per call.
   */
  async send(input: MessageInput): Promise<void> {
    if (this.sending) {
      this.emit({
        type: 'error',
        message: 'session is already processing a turn',
      })
      return
    }
    this.sending = true
    this.abortController = new AbortController()
    this.emit({ type: 'status', state: 'running' })

    let settled: 'complete' | 'aborted' | 'error' | null = null
    const markTerminal = (kind: 'complete' | 'aborted' | 'error') => {
      if (settled) return
      settled = kind
    }

    try {
      await this.driver(input, {
        emit: (e) => {
          if (e.type === 'complete') markTerminal('complete')
          if (e.type === 'aborted') markTerminal('aborted')
          if (e.type === 'error') markTerminal('error')
          this.emit(e)
        },
        signal: this.abortController.signal,
      })
      // Driver returned without emitting a terminal event. If the
      // abort signal was raised, that's an `aborted` terminal (the
      // driver bailed out of its loop cleanly). Otherwise it's a
      // `complete` — so downstream consumers always see exactly
      // one terminal event per send().
      if (!settled) {
        if (this.abortController?.signal.aborted) {
          this.emit({ type: 'aborted' })
        } else {
          this.emit({ type: 'complete' })
        }
      }
    } catch (err) {
      if (!settled) {
        // If the driver threw because we aborted it, surface as
        // aborted; otherwise as error. `signal.aborted` at this
        // point means abort() was called before the driver settled.
        if (this.abortController?.signal.aborted) {
          this.emit({
            type: 'aborted',
            reason: err instanceof Error ? err.message : String(err),
          })
        } else {
          this.emit({
            type: 'error',
            message: err instanceof Error ? err.message : String(err),
          })
        }
      }
    } finally {
      this.emit({ type: 'status', state: 'idle' })
      this.sending = false
      this.abortController = null
    }
  }

  /**
   * Cancel the in-flight send. The driver should check `signal.aborted`
   * periodically — we don't force-kill from here. If nothing is in
   * flight, abort() is a no-op.
   */
  abort(reason?: string): void {
    if (!this.abortController) return
    // AbortController only carries an optional reason on abort();
    // our abort-observing drivers receive it via signal.reason.
    this.abortController.abort(reason)
  }

  private emit(event: SessionEvent): void {
    for (const fn of this.listeners) {
      try {
        fn(event)
      } catch {
        // Listener errors must not break the loop — other listeners
        // still need the event, and the driver shouldn't care.
      }
    }
  }
}

/**
 * Echo driver: a dev/smoke-test driver that turns the input text into
 * a small sequence of events so we can verify the Session → WS → client
 * plumbing end-to-end without needing API keys or hitting a real
 * provider. Splits on whitespace, emits one `text_delta` per token
 * with a short delay, then `complete`. Respects `signal.aborted`.
 */
export const echoDriver: SessionDriver = async (input, { emit, signal }) => {
  // echoDriver is a plumbing smoke-test — it never rendered images
  // and doesn't need to. Pull the text out and echo that; attached
  // images are silently ignored (the gateway's `session.send`
  // handler already validated them upstream).
  const text = getMessageText(input)
  const tokens = text.split(/\s+/).filter((t) => t.length > 0)
  if (tokens.length === 0) {
    emit({ type: 'text_delta', text: '(empty message — echoing nothing)' })
    emit({ type: 'complete' })
    return
  }
  for (let i = 0; i < tokens.length; i++) {
    if (signal.aborted) return // Session wraps this into an `aborted` event
    emit({ type: 'text_delta', text: (i === 0 ? '' : ' ') + tokens[i] })
    // Small delay so clients observing the stream see incremental
    // arrival (not a batch).
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, 40)
      const onAbort = () => {
        clearTimeout(timer)
        reject(new Error('aborted'))
      }
      if (signal.aborted) {
        clearTimeout(timer)
        reject(new Error('aborted'))
        return
      }
      signal.addEventListener('abort', onAbort, { once: true })
    }).catch(() => {/* aborted — fall through and let Session handle */})
  }
  emit({ type: 'complete' })
}
