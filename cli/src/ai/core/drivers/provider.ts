import type { SessionDriver } from '/src/ai/core/session.ts'
import type { ChatCallbacks } from '/src/ai/console/consoleAction.ts'
import { AnthropicProvider } from '/src/ai/console/providers/anthropic.ts'
import { OpenAIProvider } from '/src/ai/console/providers/openai.ts'
import { SLVProvider } from '/src/ai/console/providers/slv.ts'
import {
  clearAbort,
  killActiveProcess,
} from '/src/ai/console/tools.ts'
import type { AiProvider } from '/src/ai/config.ts'
import { errToString } from '/lib/errToString.ts'

/**
 * Minimum provider-chat shape the driver needs — any object with a
 * `.chat(text)` method that emits via callbacks supplied at
 * construction time. All three existing providers fit.
 */
export type ProviderLike = { chat: (userMessage: string) => Promise<void> }

export type ProviderBuilder = (callbacks: ChatCallbacks) => ProviderLike

export type ProviderConfig = {
  kind: AiProvider
  apiKey: string
  model: string
  systemPrompt: string
}

/**
 * Default builder that instantiates the real SDK-backed provider
 * matching `cfg.kind`. Exposed as a separate function so tests can
 * inject a stub via `providerDriver({build: ...})` — and so the
 * Session doesn't need to import the SDKs directly when mocked.
 */
export const defaultProviderBuilder = (cfg: ProviderConfig): ProviderBuilder =>
(callbacks) => {
  switch (cfg.kind) {
    case 'anthropic':
      return new AnthropicProvider(cfg.apiKey, cfg.model, cfg.systemPrompt, callbacks)
    case 'openai':
      return new OpenAIProvider(cfg.apiKey, cfg.model, cfg.systemPrompt, callbacks)
    case 'slv':
      return new SLVProvider(cfg.apiKey, cfg.model, cfg.systemPrompt, callbacks)
  }
}

/**
 * Translate a provider's callback-based streaming into `SessionEvent`s.
 *
 * Key translations:
 *   - `onStream(fullText)` is CUMULATIVE — we diff against the last
 *     observed length to emit incremental `text_delta`s. This matches
 *     what clients expect (and keeps the WS frame size bounded).
 *   - `onToolCall(name, detail)` becomes `tool_use_start` with a
 *     synthetic id (providers don't expose their internal id) and
 *     `args` parsed from JSON best-effort — fall back to raw string.
 *   - `onComplete` becomes `complete`.
 *
 * Abort handling: when the Session's signal fires we call
 * `killActiveProcess()` which flips the global abort flag read by the
 * provider loops (see #299). This is a single-session-at-a-time
 * constraint — documented in the PR. Multi-session abort isolation
 * needs a deeper provider refactor and is out of scope here.
 */
export const providerDriver = (
  cfgOrBuilder: ProviderConfig | { build: ProviderBuilder },
): SessionDriver => {
  const buildProvider: ProviderBuilder = 'build' in cfgOrBuilder
    ? cfgOrBuilder.build
    : defaultProviderBuilder(cfgOrBuilder)

  return async (text, { emit, signal }) => {
    let emittedChars = 0
    let toolSeq = 0
    let aborted = false

    const callbacks: ChatCallbacks = {
      onStream: (full: string) => {
        if (typeof full !== 'string') return
        const delta = full.slice(emittedChars)
        emittedChars = full.length
        if (delta.length > 0) emit({ type: 'text_delta', text: delta })
      },
      onToolCall: (name: string, detail: string) => {
        let args: unknown = detail
        try {
          args = JSON.parse(detail)
        } catch { /* leave as raw string */ }
        emit({
          type: 'tool_use_start',
          id: `${name}-${++toolSeq}`,
          name,
          args,
        })
      },
      // Providers call onComplete even on the abort path — their
      // `shouldAbortAfterTools` helper fires onComplete before
      // returning. So we re-check the abort state here; if we
      // aborted, emit `aborted` so Session's terminal logic doesn't
      // settle as `complete` when the user explicitly cancelled.
      onComplete: () => {
        if (aborted || signal.aborted) {
          emit({ type: 'aborted' })
        } else {
          emit({ type: 'complete' })
        }
      },
    }

    const provider = buildProvider(callbacks)

    // Forward Session.abort → global provider abort flag. Providers
    // check this flag between LLM turns and break out of their loop
    // cleanly. See cli/src/ai/console/tools.ts:killActiveProcess.
    const onAbort = () => {
      aborted = true
      try {
        killActiveProcess()
      } catch { /* already dead */ }
    }
    signal.addEventListener('abort', onAbort, { once: true })

    // Reset the global abort flag before starting so a previous
    // abort doesn't instantly short-circuit us.
    clearAbort()

    try {
      await provider.chat(text)
      // Provider.chat already fires onComplete → Session turns it
      // into `complete`. If it returned without either, Session
      // synthesizes one in its wrapper.
    } catch (err) {
      if (aborted || signal.aborted) {
        emit({ type: 'aborted', reason: errToString(err) })
      } else {
        emit({ type: 'error', message: errToString(err) })
      }
    } finally {
      signal.removeEventListener('abort', onAbort)
    }
  }
}
