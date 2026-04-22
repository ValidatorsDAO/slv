import type { ReqFrame, ResFrame } from '/src/gateway/ws/frames.ts'
import { resErr, resOk } from '/src/gateway/ws/frames.ts'
import {
  GATEWAY_PROTOCOL_VERSION,
  GATEWAY_SERVICE_ID,
} from '/src/gateway/paths.ts'
import { PROTOCOL_VERSION } from '/src/gateway/ws/frames.ts'

/**
 * Per-connection state. Phase 2A tracks only auth; Phase 2B adds a
 * reference to the active session.
 */
export type ConnState = {
  authenticated: boolean
  // seq of the next server-pushed event. Bumped by the eventual
  // session-core event emitter (Phase 2B); kept here so we don't
  // need a separate store.
  nextEventSeq: number
}

export const newConnState = (): ConnState => ({
  authenticated: false,
  nextEventSeq: 1,
})

type MethodHandler = (
  req: ReqFrame,
  state: ConnState,
  ctx: { token: string },
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
  ctx: { token: string },
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
