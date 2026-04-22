import type { ReqFrame, ResFrame } from '/src/gateway/ws/frames.ts'
import { resErr, resOk } from '/src/gateway/ws/frames.ts'
import {
  GATEWAY_PROTOCOL_VERSION,
  GATEWAY_SERVICE_ID,
} from '/src/gateway/paths.ts'
import { PROTOCOL_VERSION } from '/src/gateway/ws/frames.ts'
import { echoDriver, Session } from '/src/ai/core/session.ts'

/**
 * Per-connection state. Phase 2A: just auth. Phase 2B adds the
 * active session (created lazily on the first `session.send`-family
 * call) and an event-seq counter that's bumped for every pushed
 * event frame.
 */
export type ConnState = {
  authenticated: boolean
  nextEventSeq: number
  // Lazily-created Session for this connection. Null until the
  // first session.* method call.
  session: Session | null
}

export const newConnState = (): ConnState => ({
  authenticated: false,
  nextEventSeq: 1,
  session: null,
})

import type { SessionEvent } from '/src/ai/core/events.ts'

export type DispatchCtx = {
  token: string
  // Push an event frame to this specific connection. The router
  // framework packages each SessionEvent with the right seq number
  // and encodes as an EventFrame — handlers don't see frames.
  emitEvent: (event: SessionEvent) => void
}

type MethodHandler = (
  req: ReqFrame,
  state: ConnState,
  ctx: DispatchCtx,
) => Promise<ResFrame> | ResFrame

const methods: Record<string, MethodHandler> = {
  /**
   * Unauthenticated handshake. Every client SHOULD call this first
   * so it knows the server is actually an slv gateway and not
   * some other service that happened to bind 20026.
   */
  'gateway.hello': (req) =>
    resOk(req, {
      service: GATEWAY_SERVICE_ID,
      version: GATEWAY_PROTOCOL_VERSION,
      protocol: PROTOCOL_VERSION,
    }),

  /**
   * Authenticate with the token from ~/.slv/gateway/gateway.json.
   * A compromised socket is a compromised host (loopback + token),
   * so constant-time compare is belt-and-suspenders. Using
   * `crypto.subtle.timingSafeEqual`-equivalent via length-match +
   * char-by-char XOR.
   */
  'gateway.auth': (req, state, ctx) => {
    const p = req.params as { token?: unknown } | undefined
    const token = p && typeof p.token === 'string' ? p.token : null
    if (!token) return resErr(req, 'params.token missing or not a string')
    if (!constantTimeEquals(token, ctx.token)) {
      return resErr(req, 'invalid token')
    }
    state.authenticated = true
    return resOk(req, { authenticated: true })
  },

  /**
   * Liveness probe. Requires auth so unauthenticated clients can't
   * use it as a keep-open with no cost.
   */
  'gateway.ping': (req, state) => {
    if (!state.authenticated) return resErr(req, 'not authenticated')
    return resOk(req, { pong: true })
  },

  /**
   * Phase 2B loopback driver: echoes the input text back as a stream
   * of `text_delta` events followed by `complete`. Purely a wire-
   * validation tool — the real `session.send` arrives when the
   * provider driver lands in the next PR. Using a separate method
   * name now means the eventual `session.send` (backed by a real
   * LLM) can be added without breaking callers that expect the
   * deterministic echo behaviour.
   */
  'session.echo': (req, state, ctx) => {
    if (!state.authenticated) return resErr(req, 'not authenticated')
    const p = req.params as { text?: unknown } | undefined
    const text = p && typeof p.text === 'string' ? p.text : null
    if (text === null) return resErr(req, 'params.text must be a string')

    // Lazily create the Session + wire our event-push callback the
    // first time a session.* method is called on this connection.
    if (!state.session) {
      state.session = new Session(echoDriver)
      state.session.on((event) => ctx.emitEvent(event))
    }
    if (state.session.isRunning) {
      return resErr(req, 'session is already running; call session.abort first')
    }

    // Fire-and-forget — the driver emits events asynchronously.
    // We return immediately so the client sees the req ack before
    // the first event frame.
    state.session.send(text).catch(() => {
      // Session.send never throws (it wraps everything into error
      // events), so this catch is defensive only.
    })
    return resOk(req, { accepted: true })
  },

  /**
   * Cancel the in-flight session.send/echo. Idempotent: no-op if
   * nothing is running.
   */
  'session.abort': (req, state) => {
    if (!state.authenticated) return resErr(req, 'not authenticated')
    const was = state.session?.isRunning ?? false
    state.session?.abort('client requested abort')
    return resOk(req, { wasRunning: was })
  },
}

const constantTimeEquals = (a: string, b: string): boolean => {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  }
  return diff === 0
}

/**
 * Dispatch a request to the right handler. Unknown methods return a
 * `method not found` error with the exact method name so callers can
 * feature-detect without guessing.
 */
export const dispatchRequest = async (
  req: ReqFrame,
  state: ConnState,
  ctx: DispatchCtx,
): Promise<ResFrame> => {
  const handler = methods[req.method]
  if (!handler) return resErr(req, `method not found: ${req.method}`)
  try {
    return await handler(req, state, ctx)
  } catch (err) {
    return resErr(req, err instanceof Error ? err.message : String(err))
  }
}

/** Introspection helper for tests — keeps the keys in one place. */
export const getSupportedMethods = (): readonly string[] =>
  Object.keys(methods)
