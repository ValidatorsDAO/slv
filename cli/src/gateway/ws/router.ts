import type { ReqFrame, ResFrame } from '/src/gateway/ws/frames.ts'
import { resErr, resOk } from '/src/gateway/ws/frames.ts'
import {
  GATEWAY_PROTOCOL_VERSION,
  GATEWAY_SERVICE_ID,
} from '/src/gateway/paths.ts'
import { PROTOCOL_VERSION } from '/src/gateway/ws/frames.ts'
import { echoDriver, Session } from '/src/ai/core/session.ts'
import { providerDriver } from '/src/ai/core/drivers/provider.ts'
import { readAiConfig } from '/src/ai/config.ts'
import { getApiKeyFromYml } from '/lib/getApiKeyFromYml.ts'
import {
  invalidateAgentContext,
  loadAgentContext,
} from '/src/ai/agentConfig/loader.ts'
import { buildSystemPrompt } from '/src/ai/console/systemPrompt.ts'
import {
  explainImageParseError,
  type MessageInput,
  parseImagesParam,
} from '/src/ai/core/messageInput.ts'

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
  // first session.* method call. `sessionKind` tracks whether the
  // current Session is wired to the echo driver or the real
  // provider driver, so a subsequent call of the other kind knows
  // to rebuild instead of piping messages into the wrong driver.
  session: Session | null
  sessionKind: 'echo' | 'provider' | null
}

export const newConnState = (): ConnState => ({
  authenticated: false,
  nextEventSeq: 1,
  session: null,
  sessionKind: null,
})

// Cross-reconnect Session store. Keyed by `token:provider:model`
// so the same browser reattaches to the same provider instance
// (preserving its in-memory message history) even when the WS
// connection drops or the user refreshes the tab. Without this,
// every reconnect spun up a fresh provider and EL lost all prior
// turns — the user observed "これが最初のセッションです" after
// sending a follow-up question.
type SessionEntry = {
  session: Session
  kind: 'provider'
  // Unsubscribe handle for the previously-attached WS's emitEvent
  // listener. We drop it before attaching the new connection's
  // listener so events aren't broadcast to dead sockets.
  unsubscribe: (() => void) | null
  lastActiveMs: number
}

const sessionStore = new Map<string, SessionEntry>()
// Evict entries idle longer than this. 30 minutes balances "brief
// laptop-lid close" reconnects against unbounded memory growth for
// long-lived gateway processes.
const SESSION_TTL_MS = 30 * 60 * 1000
// Sweep frequency for GC — cheap (iterate a small Map) so we can
// run it at the top of each session.send without setInterval
// plumbing that'd leak across process restarts.
const SESSION_GC_INTERVAL_MS = 5 * 60 * 1000
let lastGcMs = 0

const gcSessionStore = (now: number): void => {
  if (now - lastGcMs < SESSION_GC_INTERVAL_MS) return
  lastGcMs = now
  for (const [key, entry] of sessionStore) {
    if (now - entry.lastActiveMs > SESSION_TTL_MS) {
      entry.unsubscribe?.()
      sessionStore.delete(key)
    }
  }
}

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
   * Metadata the browser UI needs once per connection: the configured
   * agent's display name + the AI provider/model in use. Kept out of
   * gateway.hello so unauthenticated callers can't fingerprint the
   * agent config; kept out of every event frame because it's a
   * session constant, not per-message.
   */
  'session.info': async (req, state) => {
    if (!state.authenticated) return resErr(req, 'not authenticated')
    const ctx = await loadAgentContext()
    const aiCfg = await readAiConfig().catch(() => null)
    return resOk(req, {
      agentName: ctx.soul?.name ?? 'Assistant',
      provider: aiCfg?.provider ?? null,
      model: aiCfg?.model ?? null,
    })
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
   * Deterministic loopback driver that echoes the input text back as
   * a stream of `text_delta` events followed by `complete`. Kept
   * alongside `session.send` (real LLM) because it's invaluable for
   * wire-protocol tests + fresh-VPS smoke-testing without API keys.
   */
  'session.echo': (req, state, ctx) => {
    if (!state.authenticated) return resErr(req, 'not authenticated')
    const p = req.params as { text?: unknown } | undefined
    const text = p && typeof p.text === 'string' ? p.text : null
    if (text === null) return resErr(req, 'params.text must be a string')

    if (state.session?.isRunning) {
      return resErr(req, 'session is already running; call session.abort first')
    }
    // Fresh echo session per turn. Echo is deterministic and
    // history-free by design, so we always rebuild — and we mark
    // the kind so a later session.send knows to rebuild with the
    // real provider instead of piping chat into the echo driver.
    state.session = new Session(echoDriver)
    state.session.on((event) => ctx.emitEvent(event))
    state.sessionKind = 'echo'

    state.session.send(text).catch(() => {
      // Session.send swallows errors into `error` events; this
      // catch is defensive only.
    })
    return resOk(req, { accepted: true })
  },

  /**
   * Real LLM turn. Loads the configured provider from ~/.slv/api.yml
   * (respecting the `ai.provider` + `ai.model` the user set via
   * `slv onboard`) and runs one chat turn, streaming `text_delta`,
   * `tool_use_start`, `complete` / `aborted` / `error` events.
   *
   * Single-session-per-gateway limitation: provider abort goes
   * through the global abort flag in tools.ts, so starting a
   * session.send while a TUI chat is running in the same process
   * will share abort state. Acceptable for Phase 2C (one client at
   * a time); full isolation needs a provider refactor.
   */
  'session.send': async (req, state, ctx) => {
    if (!state.authenticated) return resErr(req, 'not authenticated')
    const p = req.params as
      | { text?: unknown; images?: unknown }
      | undefined
    const text = p && typeof p.text === 'string' ? p.text : null
    if (text === null) return resErr(req, 'params.text must be a string')
    // Optional images: validate shape + mime allowlist + size/count
    // caps BEFORE creating the session so clients get a precise 4xx
    // rather than a vague provider error half a second later.
    const imageParse = parseImagesParam(p?.images)
    if (!imageParse.ok) {
      return resErr(req, explainImageParseError(imageParse.error))
    }
    const input: MessageInput = imageParse.images.length === 0
      ? text
      : { text, images: imageParse.images }

    if (state.session?.isRunning) {
      return resErr(req, 'session is already running; call session.abort first')
    }

    let aiCfg
    try {
      aiCfg = await readAiConfig()
    } catch (err) {
      return resErr(req, `failed to read AI config: ${err instanceof Error ? err.message : String(err)}`)
    }
    if (!aiCfg) {
      return resErr(
        req,
        'no AI provider configured — run `slv onboard` first',
      )
    }
    // SLV provider reads its bearer from ~/.slv/api.yml's slv.api_key
    // (not the ai.api_key field, which is used by anthropic/openai
    // for their own API keys).
    let apiKey = aiCfg.api_key
    if (aiCfg.provider === 'slv') {
      try {
        apiKey = await getApiKeyFromYml(true)
      } catch (err) {
        return resErr(
          req,
          `failed to read SLV API key: ${err instanceof Error ? err.message : String(err)}`,
        )
      }
      if (!apiKey) {
        return resErr(
          req,
          'no SLV API key — run `slv signup` / `slv login` first',
        )
      }
    }

    // Invalidate the cached agent context so MEMORY.md / USER.md /
    // SOUL.md edits made between turns (or by EL itself via
    // write_file) propagate on the next turn without waiting for
    // a gateway restart.
    invalidateAgentContext()

    // Hydrate the same system prompt the TUI uses so browser chat has
    // access to SOUL.md (agent identity), USER.md (user profile + name),
    // MEMORY.md (persisted session notes), enabled skills, and the
    // sub-agent team. Without this, `/ui/` just talks to a raw LLM with
    // no context and the conversation feels disconnected from `slv c`.
    let systemPrompt = ''
    try {
      systemPrompt = await buildSystemPrompt()
    } catch (err) {
      return resErr(
        req,
        `failed to build system prompt: ${err instanceof Error ? err.message : String(err)}`,
      )
    }

    // Reuse the existing provider Session across WS reconnects via
    // the token-keyed sessionStore. `state.session` handles the
    // same-connection case; the store handles the cross-connection
    // case (tab refresh, laptop-lid close, network hiccup).
    const now = Date.now()
    gcSessionStore(now)
    const storeKey = `${ctx.token}:${aiCfg.provider}:${aiCfg.model}`
    let entry = sessionStore.get(storeKey)
    const stale = !entry || now - entry.lastActiveMs > SESSION_TTL_MS

    if (stale || state.sessionKind === 'echo') {
      const driver = providerDriver({
        kind: aiCfg.provider,
        apiKey,
        model: aiCfg.model,
        systemPrompt,
      })
      const session = new Session(driver)
      entry = { session, kind: 'provider', unsubscribe: null, lastActiveMs: now }
      sessionStore.set(storeKey, entry)
    }

    // Attach this WS's listener if it's a new connection (or a
    // different WS than the one previously attached to this
    // Session). Drop the prior listener first so dead sockets
    // don't silently receive events.
    if (state.session !== entry!.session) {
      entry!.unsubscribe?.()
      entry!.unsubscribe = entry!.session.on((event) => ctx.emitEvent(event))
      state.session = entry!.session
      state.sessionKind = 'provider'
    }
    entry!.lastActiveMs = now

    state.session.send(input).catch(() => {
      // Session.send swallows errors into `error` events.
    })
    return resOk(req, {
      accepted: true,
      provider: aiCfg.provider,
      imagesAttached: imageParse.images.length,
    })
  },

  /**
   * Cancel the in-flight session. Idempotent: no-op if nothing is
   * running.
   */
  'session.abort': (req, state) => {
    if (!state.authenticated) return resErr(req, 'not authenticated')
    const was = state.session?.isRunning ?? false
    state.session?.abort('client requested abort')
    return resOk(req, { wasRunning: was })
  },

  /**
   * Trigger `slv upgrade && slv gateway restart` asynchronously.
   * The child is spawned detached so it outlives this process —
   * when `slv gateway restart` SIGTERMs us, the detached shell
   * keeps running and waits for the new binary to come back up
   * via the systemd unit. The watchdog timer (installed by
   * `slv gateway install`) covers the case where the restart
   * itself fails partway.
   *
   * Intentionally fire-and-forget: we return ack immediately so
   * the WS can disconnect cleanly before the shutdown.
   */
  'gateway.upgrade': (req, state) => {
    if (!state.authenticated) return resErr(req, 'not authenticated')
    try {
      const cmd = new Deno.Command('sh', {
        args: ['-c', 'sleep 2; slv upgrade && slv gateway restart'],
        stdin: 'null',
        stdout: 'null',
        stderr: 'null',
      })
      // detached / orphaned child. unref makes sure Deno doesn't
      // keep the event loop alive because of it.
      const child = cmd.spawn()
      child.unref()
      return resOk(req, { started: true })
    } catch (err) {
      return resErr(
        req,
        `upgrade spawn failed: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
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
