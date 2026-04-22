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
  // Line-level output from an actively running tool (shell / ansible).
  // Clients stream these into a progress area so long-running commands
  // (cargo build, apt install, playbook) don't look frozen. Emitted
  // AFTER `tool_use_start` for the same logical tool execution; the
  // pairing isn't explicit — clients can assume each stdout line
  // belongs to the most recent tool_use_start within the same turn.
  | { type: 'tool_stdout'; text: string }
  // Shorter, higher-signal progress hint extracted from the stream
  // (e.g. "Compiling solana-program", "Building wheel for foo").
  // Paired with tool_stdout — clients may choose to pin this on a
  // spinner-style label while tool_stdout fills a scrollable area.
  | { type: 'tool_progress'; label: string }
  | { type: 'tool_result'; id: string; ok: boolean; content: string }
  | { type: 'status'; state: 'running' | 'idle'; label?: string }
  | { type: 'complete' }
  | { type: 'aborted'; reason?: string }
  | { type: 'error'; message: string }

export type SessionEventListener = (event: SessionEvent) => void
