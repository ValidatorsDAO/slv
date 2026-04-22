/**
 * Typed event stream emitted by a {@link Session}.
 *
 * Producers: the Session driver (echo for Phase 2B, real provider
 * loop in a follow-up PR). Consumers: the TUI adapter (future) and
 * the WS gateway's `session.send` handler which serializes each
 * event into an `event` frame (see `cli/src/gateway/ws/frames.ts`).
 *
 * Keep this union ADDITIVE — clients match on `type` and ignore
 * unknown events, so adding new variants is backward-compatible.
 * Renaming or removing a type IS breaking and needs a protocol
 * version bump.
 */
export type SessionEvent =
  | { type: 'text_delta'; text: string }
  | { type: 'tool_use_start'; id: string; name: string; args: unknown }
  | { type: 'tool_result'; id: string; ok: boolean; content: string }
  | { type: 'status'; state: 'running' | 'idle'; label?: string }
  | { type: 'complete' }
  | { type: 'aborted'; reason?: string }
  | { type: 'error'; message: string }

export type SessionEventListener = (event: SessionEvent) => void
