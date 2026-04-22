import type { Context, Hono } from '@hono/hono'
import {
  encodeFrame,
  parseFrame,
  resErr,
} from '/src/gateway/ws/frames.ts'
import type { EventFrame } from '/src/gateway/ws/frames.ts'
import {
  dispatchRequest,
  newConnState,
} from '/src/gateway/ws/router.ts'
import type { SessionEvent } from '/src/ai/core/events.ts'

/**
 * Register the `/v1/session/ws` WebSocket endpoint on the Hono app.
 *
 * Auth flow: connection opens immediately (no HTTP Authorization
 * header in browser WebSocket API), client sends `req: gateway.auth`
 * with the token from ~/.slv/gateway/gateway.json. Until that
 * succeeds, only `gateway.hello` is allowed; every other method
 * returns `not authenticated`. If the client sends 4 invalid frames
 * in a row without authenticating, we close 1008 to avoid becoming
 * a free keepalive for random probers.
 */
export const registerWsRoutes = (
  app: Hono,
  ctx: { token: string },
): void => {
  app.get('/v1/session/ws', (c: Context) => upgradeWs(c, ctx))
}

const MAX_PREAUTH_BAD_FRAMES = 4

const upgradeWs = (
  c: Context,
  ctx: { token: string },
): Response => {
  const upgrade = c.req.header('upgrade')?.toLowerCase()
  if (upgrade !== 'websocket') {
    return c.json(
      { error: 'WebSocket upgrade required on /v1/session/ws' },
      426,
    )
  }
  const { socket, response } = Deno.upgradeWebSocket(c.req.raw)
  const state = newConnState()
  let preauthBad = 0

  // Per-connection event pump: serializes each SessionEvent into an
  // `event` frame with a monotonically-increasing `seq`. Clients
  // that reconnect (Phase 3) will be able to resume from the last
  // `seq` they saw; for now this at least gives them gap detection.
  const emitEvent = (event: SessionEvent): void => {
    if (socket.readyState !== WebSocket.OPEN) return
    const frame: EventFrame = {
      kind: 'event',
      event: event.type,
      payload: event,
      seq: state.nextEventSeq++,
    }
    socket.send(encodeFrame(frame))
  }

  socket.onopen = () => {
    // No server-initiated hello — spec says the client sends the
    // first frame (req: gateway.hello) so the WS feels identical to
    // an HTTP request/response API.
  }

  socket.onmessage = async (ev) => {
    let parsed: ReturnType<typeof parseFrame>
    try {
      parsed = parseFrame(JSON.parse(String(ev.data)))
    } catch (err) {
      preauthBad++
      socket.send(
        encodeFrame(
          resErr(null, `invalid JSON: ${err instanceof Error ? err.message : String(err)}`),
        ),
      )
      if (!state.authenticated && preauthBad >= MAX_PREAUTH_BAD_FRAMES) {
        socket.close(1008, 'too many bad frames before auth')
      }
      return
    }

    if (parsed.kind === 'parse_error') {
      preauthBad++
      socket.send(encodeFrame(resErr(null, parsed.error)))
      if (!state.authenticated && preauthBad >= MAX_PREAUTH_BAD_FRAMES) {
        socket.close(1008, 'too many bad frames before auth')
      }
      return
    }

    if (parsed.kind !== 'req') {
      // res/event from the client don't mean anything on the server
      // side yet. Ignore — but count against the pre-auth budget so
      // random WS chatter can't keep the connection open.
      if (!state.authenticated) preauthBad++
      return
    }

    const res = await dispatchRequest(parsed, state, {
      token: ctx.token,
      emitEvent,
    })
    socket.send(encodeFrame(res))
    // Reset the bad-frame counter on any successful request (even
    // an unauthenticated hello) so a client that recovers after a
    // typo isn't kicked off.
    if (res.ok) preauthBad = 0
  }

  socket.onerror = () => {
    // No-op: onmessage catches malformed payloads; transport errors
    // cause onclose anyway.
  }

  socket.onclose = () => {
    // Abort any in-flight session so the echo driver (or future
    // provider loop) stops burning cycles on events that can't be
    // delivered. Idempotent: no-op if nothing is running.
    state.session?.abort('client disconnected')
  }

  return response
}
