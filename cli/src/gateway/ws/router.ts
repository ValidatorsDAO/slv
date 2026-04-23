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
import { loadAgentContext } from '/src/ai/agentConfig/loader.ts'
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
    // Fresh session per turn so switching drivers between echo and
    // send works cleanly. Previous-turn history is not preserved in
    // Phase 2C; session persistence lands in a later PR.
    state.session = new Session(echoDriver)
    state.session.on((event) => ctx.emitEvent(event))

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

    // Hydrate the same system prompt the TUI uses so browser chat has
    // access to SOUL.md (agent identity), USER.md (user profile + name),
    // MEMORY.md (persisted session notes), enabled skills, and the
    // sub-agent team. Without this, `/ui/` just talks to a raw LLM with
    // no context and the conversation feels disconnected from `slv c`.
    // buildSystemPrompt memoizes via loadAgentContext, so the cost is a
    // one-time FS read per process.
    let systemPrompt = ''
    try {
      systemPrompt = await buildSystemPrompt()
    } catch (err) {
      return resErr(
        req,
        `failed to build system prompt: ${err instanceof Error ? err.message : String(err)}`,
      )
    }

    const driver = providerDriver({
      kind: aiCfg.provider,
      apiKey,
      model: aiCfg.model,
      systemPrompt,
    })
    state.session = new Session(driver)
    state.session.on((event) => ctx.emitEvent(event))

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
