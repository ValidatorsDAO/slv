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
    this.model = model === 'SLV AI' ? 'claude-sonnet-4-6' : model
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
          throw new Error(
            'Your SLV AI token limit has been reached.\n' +
            'Please upgrade your plan or add more tokens in this channel:\n' +
            'https://discord.com/channels/1278625724248494120/1488527495639601233',
          )
        }

        // 529 = overloaded / token quota exhausted
        if (response.status === 529) {
          throw new Error(
            'SLV AI is temporarily unavailable or your token balance may be exhausted.\n' +
            'Please upgrade your plan or add more tokens in this channel:\n' +
            'https://discord.com/channels/1278625724248494120/1488527495639601233',
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
        this.callbacks.onToolCall(tb.name, JSON.stringify(tb.input).slice(0, 100))
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
