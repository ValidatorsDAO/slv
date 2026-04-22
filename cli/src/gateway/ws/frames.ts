/**
 * Wire protocol between gateway clients (TUI, future web UI) and the
 * gateway daemon. Every message on the WS is a single JSON-encoded
 * `Frame`. Three kinds:
 *
 *   - `req`: client → server RPC request. Carries an `id` the client
 *     picks (uuid or counter); server echoes it in the matching `res`.
 *
 *   - `res`: server → client reply to a prior `req.id`. `ok: true`
 *     with `payload`, or `ok: false` with `error` (short string).
 *
 *   - `event`: server → client push, not tied to any `req`. Carries
 *     `seq` so clients that reconnect can tell the server what they
 *     last saw and the server can replay missed events (Phase 3).
 *
 * The envelope is deliberately thin; specific methods and event kinds
 * live alongside the handlers that produce them (`router.ts`).
 * Bumping PROTOCOL_VERSION is for breaking changes to THIS envelope,
 * not for adding methods — methods are discovered at runtime by
 * calling them and seeing if `res.ok` comes back.
 */

export const PROTOCOL_VERSION = 1

export type ReqFrame = {
  kind: 'req'
  id: string
  method: string
  params?: unknown
}

export type ResFrame = {
  kind: 'res'
  id: string
  ok: boolean
  payload?: unknown
  error?: string
}

export type EventFrame = {
  kind: 'event'
  event: string
  payload?: unknown
  seq: number
}

export type Frame = ReqFrame | ResFrame | EventFrame

const isStringId = (v: unknown): v is string =>
  typeof v === 'string' && v.length > 0 && v.length <= 128

/**
 * Minimal hand-rolled validator. Zod would be nicer but adds a
 * dependency gradient the gateway doesn't otherwise need — the
 * protocol surface is tiny. Keep in sync with the types above.
 */
const bad = (error: string): ParseResult => ({ kind: 'parse_error', error })

export const parseFrame = (raw: unknown): ParseResult => {
  if (!raw || typeof raw !== 'object') return bad('frame must be an object')
  const f = raw as Record<string, unknown>
  switch (f.kind) {
    case 'req':
      if (!isStringId(f.id)) return bad('req.id must be a non-empty string')
      if (typeof f.method !== 'string' || f.method.length === 0) {
        return bad('req.method must be a non-empty string')
      }
      return {
        kind: 'req',
        id: f.id,
        method: f.method,
        params: f.params,
      }
    case 'res':
      if (!isStringId(f.id)) return bad('res.id must be a non-empty string')
      if (typeof f.ok !== 'boolean') return bad('res.ok must be a boolean')
      return {
        kind: 'res',
        id: f.id,
        ok: f.ok,
        payload: f.payload,
        error: typeof f.error === 'string' ? f.error : undefined,
      }
    case 'event':
      if (typeof f.event !== 'string' || f.event.length === 0) {
        return bad('event.event must be a non-empty string')
      }
      if (typeof f.seq !== 'number' || !Number.isFinite(f.seq)) {
        return bad('event.seq must be a number')
      }
      return {
        kind: 'event',
        event: f.event,
        payload: f.payload,
        seq: f.seq,
      }
    default:
      return bad(
        `frame.kind must be 'req' | 'res' | 'event' (got ${JSON.stringify(f.kind)})`,
      )
  }
}

export type ParseResult = Frame | { kind: 'parse_error'; error: string }

export const encodeFrame = (f: Frame): string => JSON.stringify(f)

/**
 * Construct a successful reply to a `req`. Keeps callers from forgetting
 * `ok: true` or mis-typing the id.
 */
export const resOk = (req: ReqFrame, payload?: unknown): ResFrame => ({
  kind: 'res',
  id: req.id,
  ok: true,
  payload,
})

export const resErr = (
  req: { id: string } | null,
  error: string,
): ResFrame => ({
  kind: 'res',
  id: req?.id ?? '',
  ok: false,
  error,
})
