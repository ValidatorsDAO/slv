import {
  executeTool,
  TOOL_DEFINITIONS,
  type ToolDefinition,
} from '@/ai/console/tools.ts'
import { DEFAULT_MAX_TOKENS } from '@/ai/config.ts'
import type { ChatCallbacks } from '@/ai/console/consoleAction.ts'

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

  constructor(apiKey: string, model: string, systemPrompt: string, callbacks: ChatCallbacks) {
    this.apiKey = apiKey
    // "SLV AI" maps to the default model on the server side
    this.model = model === 'SLV AI' ? 'slv-ai-default' : model
    this.systemPrompt = systemPrompt
    this.callbacks = callbacks
  }

  async chat(userMessage: string): Promise<void> {
    this.messages.push({ role: 'user', content: userMessage })

    while (true) {
      const response = await fetch('https://user-api.erpc.global/v3/ai/chat', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model: this.model,
          max_tokens: DEFAULT_MAX_TOKENS,
          system: this.systemPrompt,
          messages: this.messages,
          tools: toAnthropicTools(TOOL_DEFINITIONS),
        }),
        signal: AbortSignal.timeout(120_000),
      })

      if (!response.ok) {
        const errorText = await response.text()

        if (
          response.status === 403 &&
          errorText.includes('ai_token_limit_reached')
        ) {
          // Try to parse estimated_tokens and remaining_tokens from the API response
          let tokenInfo = ''
          try {
            const errJson = JSON.parse(errorText)
            const estimated = errJson.estimated_tokens
            const remaining = errJson.remaining_tokens
            if (estimated != null && remaining != null) {
              tokenInfo = `  Estimated cost: ~${Number(estimated).toLocaleString()} tokens | Your balance: ${Number(remaining).toLocaleString()} tokens\n\n`
            }
          } catch { /* response may not be JSON */ }

          throw new Error(
            '\u26a0\ufe0f Insufficient tokens for this request.\n' +
            tokenInfo +
            '\ud83d\udca1 Options:\n' +
            '  \u2022 Run /slv ai product to view plans and purchase tokens\n' +
            '  \u2022 Run /slv ai usage to check your current balance\n' +
            '  \u2022 Secure Authorization (\u20ac5) includes 100,000 AI tokens',
          )
        }

        // 529 = overloaded / token quota exhausted
        if (response.status === 529) {
          // Try to parse token info from 529 response as well
          let tokenInfo = ''
          try {
            const errJson = JSON.parse(errorText)
            const estimated = errJson.estimated_tokens
            const remaining = errJson.remaining_tokens
            if (estimated != null && remaining != null) {
              tokenInfo = `  Estimated cost: ~${Number(estimated).toLocaleString()} tokens | Your balance: ${Number(remaining).toLocaleString()} tokens\n\n`
            }
          } catch { /* response may not be JSON */ }

          throw new Error(
            '\u26a0\ufe0f Insufficient tokens for this request.\n' +
            tokenInfo +
            '\ud83d\udca1 Options:\n' +
            '  \u2022 Run /slv ai product to view plans and purchase tokens\n' +
            '  \u2022 Run /slv ai usage to check your current balance\n' +
            '  \u2022 Secure Authorization (\u20ac5) includes 100,000 AI tokens',
          )
        }

        throw new Error(`SLV AI API error (${response.status}): ${errorText}`)
      }

      const data = await response.json()

      if (!data || !Array.isArray(data.content)) {
        throw new Error(`SLV AI returned unexpected response: ${JSON.stringify(data).slice(0, 200)}`)
      }

      let assistantText = ''
      const toolUseBlocks: {
        id: string
        name: string
        input: Record<string, unknown>
      }[] = []

      // Process response content blocks (Anthropic Messages API format)
      for (const block of data.content) {
        if (block.type === 'text') {
          assistantText += block.text
          this.callbacks.onStream(assistantText)
        } else if (block.type === 'tool_use') {
          toolUseBlocks.push({
            id: block.id,
            name: block.name,
            input: block.input as Record<string, unknown>,
          })
        }
      }

      // Save assistant message with the raw response content
      this.messages.push({ role: 'assistant', content: data.content })

      if (toolUseBlocks.length === 0) {
        this.callbacks.onComplete()
        break
      }

      // Execute tools and add results
      const toolResults: ToolResultBlockParam[] = []
      for (const tb of toolUseBlocks) {
        this.callbacks.onToolCall(tb.name, JSON.stringify(tb.input).slice(0, 200))
        const result = await executeTool(tb.name, tb.input)
        toolResults.push({
          type: 'tool_result',
          tool_use_id: tb.id,
          content: result,
        })
      }
      this.messages.push({ role: 'user', content: toolResults })

      // Continue loop to let model respond after tool results
    }
  }
}
