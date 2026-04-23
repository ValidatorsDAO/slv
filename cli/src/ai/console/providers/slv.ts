import {
  executeTool,
  getAbortSignal,
  getActiveTools,
  shouldAbortAfterTools,
  type ToolDefinition,
} from '@/ai/console/tools.ts'
import { isAbortLikeError } from '/lib/isAbortError.ts'
import { DEFAULT_MAX_TOKENS } from '@/ai/config.ts'
import {
  fetchAuthorizationStatus,
  getAuthorizationStatus,
} from '@/ai/authorization.ts'
import type { ChatCallbacks } from '@/ai/console/consoleAction.ts'
import { getModuleContent } from '@/ai/console/systemPrompt.ts'
import type { MessageInput } from '@/ai/core/messageInput.ts'
import { messageInputToContent } from '@/ai/core/messageInput.ts'

type MessageParam = {
  role: 'user' | 'assistant'
  content: unknown
}

type AnthropicTool = {
  name: string
  description: string
  input_schema: Record<string, unknown>
}

type ToolResultBlockParam = {
  type: 'tool_result'
  tool_use_id: string
  content: string
}

type TokenErrorPayload = Record<string, unknown>

function formatNumber(value: unknown): string | null {
  const num = Number(value)
  return Number.isFinite(num) ? num.toLocaleString() : null
}

function formatCurrency(
  value: unknown,
  currencyValue?: unknown,
): string | null {
  const num = Number(value)
  if (!Number.isFinite(num)) return null
  const currency = String(currencyValue ?? 'EUR').toUpperCase()
  try {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency,
      maximumFractionDigits: 2,
    }).format(num)
  } catch {
    return `${num.toFixed(2)} ${currency}`
  }
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return null
}

function buildCostDriver(payload: TokenErrorPayload): string | null {
  return firstString(
    payload.expensive_reason,
    payload.expensiveReason,
    payload.cost_driver,
    payload.costDriver,
    payload.reason,
    payload.message,
  )
}

async function buildInsufficientTokenMessage(
  apiKey: string,
  payload: TokenErrorPayload,
): Promise<string> {
  const estimatedTokens = formatNumber(
    payload.estimated_tokens ?? payload.estimatedTokens,
  )
  const estimatedCost = formatCurrency(
    payload.estimated_cost ?? payload.estimatedCost,
    payload.currency,
  )
  const remainingTokens = formatNumber(
    payload.remaining_tokens ?? payload.remainingTokens,
  )
  const planName = firstString(
    payload.ai_plan,
    payload.plan_name,
    payload.planName,
  )
  const costDriver = buildCostDriver(payload)

  const dashboardAuthorization = await fetchAuthorizationStatus(apiKey)
  const payloadAuthorization = getAuthorizationStatus(payload)
  const authState = dashboardAuthorization.state !== 'unknown'
    ? dashboardAuthorization.state
    : payloadAuthorization.state
  const authorizationLink = dashboardAuthorization.authorizationLink ??
    payloadAuthorization.authorizationLink

  const lines = ['⚠️ Insufficient tokens for this request.']
  const details: string[] = []

  if (planName) details.push(`Plan: ${planName}`)
  if (estimatedTokens) details.push(`Estimated tokens: ~${estimatedTokens}`)
  if (estimatedCost) details.push(`Estimated cost: ${estimatedCost}`)
  if (remainingTokens) {
    details.push(`Current balance: ${remainingTokens} tokens`)
  }
  if (details.length > 0) {
    lines.push('')
    lines.push(...details.map((detail) => `  • ${detail}`))
  }

  if (costDriver) {
    lines.push('')
    lines.push(`Why this was expensive: ${costDriver}`)
  }

  lines.push('')
  lines.push('Next steps:')
  lines.push('  • Run /slv ai usage to check your current balance')
  lines.push(
    '  • Run /slv ai product to browse AI products and purchase more tokens',
  )
  lines.push(
    '  • Or purchase tokens on Discord: https://discord.com/channels/1278625724248494120/1488527495639601233',
  )

  if (authState === 'unauthorized') {
    lines.push(
      `  • Complete Authorization (€5) to receive 100,000 free AI tokens${
        authorizationLink ? ':' : ''
      }`,
    )
    if (authorizationLink) {
      lines.push(`    ${authorizationLink}`)
    }
  }

  return lines.join('\n')
}

function toAnthropicTools(
  tools: ToolDefinition[],
): AnthropicTool[] {
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.parameters as Record<string, unknown>,
  }))
}

export class SLVProvider {
  private apiKey: string
  private model: string
  private messages: MessageParam[] = []
  private systemPrompt: string
  private callbacks: ChatCallbacks

  constructor(
    apiKey: string,
    model: string,
    systemPrompt: string,
    callbacks: ChatCallbacks,
  ) {
    this.apiKey = apiKey
    // "SLV AI" maps to the default model on the server side
    this.model = model === 'SLV AI' ? 'slv-ai-default' : model
    this.systemPrompt = systemPrompt
    this.callbacks = callbacks
  }

  setSystemPrompt(systemPrompt: string): void {
    this.systemPrompt = systemPrompt
  }

  /**
   * Swap the per-turn callbacks without touching message history.
   * Used by the gateway's providerDriver so a single provider
   * instance serves every turn of a WS connection (preserving
   * `this.messages`) while the `emit` closure differs per call.
   */
  updateCallbacks(callbacks: ChatCallbacks): void {
    this.callbacks = callbacks
  }

  async chat(userMessage: MessageInput): Promise<void> {
    // Convert the widened MessageInput to the Anthropic content
    // shape the erpc proxy expects. For text-only turns this
    // collapses back to a plain string (so the wire payload stays
    // identical to pre-vision requests); for turns with images it
    // becomes a [text, image…] block array.
    this.messages.push({
      role: 'user',
      content: messageInputToContent(userMessage),
    })

    while (true) {
      // Combine the per-request 120s timeout with the user-abort signal
      // so Ctrl+C cancels the HTTP call immediately instead of waiting
      // for the timeout.
      const signal = AbortSignal.any([
        AbortSignal.timeout(120_000),
        getAbortSignal(),
      ])
      let response
      try {
        response = await fetch('https://user-api.erpc.global/v3/ai/chat', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${this.apiKey}`,
          },
          body: JSON.stringify({
            model: this.model,
            max_tokens: DEFAULT_MAX_TOKENS,
            system: this.systemPrompt + getModuleContent(),
            messages: this.messages,
            tools: toAnthropicTools(getActiveTools()),
            // stream=true gets text_delta events back as soon as the
            // model produces the first token, rather than holding the
            // whole response hostage until the model is done. Makes
            // the browser UI feel responsive (ms-scale first-byte
            // latency) instead of frozen for several seconds.
            stream: true,
          }),
          signal,
        })
      } catch (err) {
        if (isAbortLikeError(err)) {
          this.callbacks.onComplete()
          return
        }
        throw err
      }

      if (!response.ok) {
        const errorText = await response.text()
        let errJson: TokenErrorPayload | null = null
        try {
          errJson = JSON.parse(errorText) as TokenErrorPayload
        } catch {
          errJson = null
        }

        const tokenLimitReached = response.status === 529 ||
          (response.status === 403 &&
            errorText.includes('ai_token_limit_reached'))

        if (tokenLimitReached) {
          throw new Error(
            await buildInsufficientTokenMessage(this.apiKey, errJson ?? {}),
          )
        }

        throw new Error(`SLV AI API error (${response.status}): ${errorText}`)
      }

      // Parse the Anthropic SSE stream. Events we care about:
      //   - content_block_start  → begin a text or tool_use block
      //   - content_block_delta  → text_delta or input_json_delta
      //   - content_block_stop   → finalize the block
      //   - message_delta        → stop_reason lands here
      //   - message_stop         → end of this turn's stream
      //   - error                → upstream error mid-stream
      const reader = response.body?.getReader()
      if (!reader) {
        throw new Error('SLV AI returned a non-streaming response body')
      }
      const decoder = new TextDecoder()
      let sseBuffer = ''
      let assistantText = ''
      const finalContent: Array<
        | { type: 'text'; text: string }
        | {
          type: 'tool_use'
          id: string
          name: string
          input: Record<string, unknown>
        }
      > = []
      const toolUseBlocks: {
        id: string
        name: string
        input: Record<string, unknown>
      }[] = []
      // Per-block scratch state keyed by the `index` ordinal the
      // server uses in content_block_* events.
      type BlockScratch =
        | { kind: 'text'; text: string }
        | { kind: 'tool_use'; id: string; name: string; partialJson: string }
      const scratch = new Map<number, BlockScratch>()

      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          sseBuffer += decoder.decode(value, { stream: true })
          // SSE event delimiter is a blank line (\n\n). Drain every
          // complete event from the buffer in order; anything after
          // the last \n\n is a partial event we keep for the next
          // read.
          let sep
          while ((sep = sseBuffer.indexOf('\n\n')) !== -1) {
            const rawEvent = sseBuffer.slice(0, sep)
            sseBuffer = sseBuffer.slice(sep + 2)
            let dataLine = ''
            for (const line of rawEvent.split('\n')) {
              if (line.startsWith('data: ')) {
                dataLine = line.slice(6)
                break
              }
            }
            if (!dataLine || dataLine === '[DONE]') continue
            let p: {
              type: string
              index?: number
              content_block?: {
                type: string
                id?: string
                name?: string
                text?: string
              }
              delta?: {
                type?: string
                text?: string
                partial_json?: string
                stop_reason?: string
              }
              error?: { message?: string }
            }
            try {
              p = JSON.parse(dataLine)
            } catch {
              continue
            }
            if (p.type === 'content_block_start' && p.content_block) {
              const idx = p.index ?? 0
              if (p.content_block.type === 'text') {
                scratch.set(idx, { kind: 'text', text: '' })
              } else if (p.content_block.type === 'tool_use') {
                scratch.set(idx, {
                  kind: 'tool_use',
                  id: p.content_block.id ?? '',
                  name: p.content_block.name ?? '',
                  partialJson: '',
                })
              }
            } else if (p.type === 'content_block_delta' && p.delta) {
              const idx = p.index ?? 0
              const b = scratch.get(idx)
              if (!b) continue
              if (p.delta.type === 'text_delta' && b.kind === 'text') {
                const chunk = p.delta.text ?? ''
                b.text += chunk
                assistantText += chunk
                // Cumulative — providerDriver diffs against the
                // previously-emitted length to build incremental
                // text_delta events for the client.
                this.callbacks.onStream(assistantText)
              } else if (
                p.delta.type === 'input_json_delta' &&
                b.kind === 'tool_use'
              ) {
                b.partialJson += p.delta.partial_json ?? ''
              }
            } else if (p.type === 'content_block_stop') {
              const idx = p.index ?? 0
              const b = scratch.get(idx)
              if (!b) continue
              if (b.kind === 'text') {
                finalContent.push({ type: 'text', text: b.text })
              } else {
                let input: Record<string, unknown> = {}
                try {
                  input = JSON.parse(b.partialJson || '{}')
                } catch {
                  // Tool args were truncated — surface an empty
                  // input so the tool layer can error out cleanly
                  // instead of us throwing here.
                }
                const tu = { id: b.id, name: b.name, input }
                toolUseBlocks.push(tu)
                finalContent.push({ type: 'tool_use', ...tu })
              }
              scratch.delete(idx)
            } else if (p.type === 'error') {
              throw new Error(p.error?.message ?? 'SLV AI stream error')
            }
            // message_start / message_delta / message_stop / ping
            // carry no state we need — the stream ends on the
            // reader's `done` or message_stop (either way).
          }
        }
      } catch (err) {
        if (isAbortLikeError(err)) {
          this.callbacks.onComplete()
          return
        }
        throw err
      }

      // Save assistant message with the reconstructed block array.
      this.messages.push({ role: 'assistant', content: finalContent })

      if (toolUseBlocks.length === 0) {
        this.callbacks.onComplete()
        break
      }

      // Execute tools and add results
      const toolResults: ToolResultBlockParam[] = []
      for (const tb of toolUseBlocks) {
        this.callbacks.onToolCall(
          tb.name,
          JSON.stringify(tb.input).slice(0, 200),
        )
        const result = await executeTool(tb.name, tb.input)
        toolResults.push({
          type: 'tool_result',
          tool_use_id: tb.id,
          content: result,
        })
      }
      this.messages.push({ role: 'user', content: toolResults })

      // User pressed Ctrl+C during tool execution — stop here instead of
      // requesting another turn so the user stays in control.
      if (shouldAbortAfterTools(this.callbacks.onComplete)) break

      // Continue loop to let model respond after tool results
    }
  }
}
