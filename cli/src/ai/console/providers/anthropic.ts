import Anthropic from '@anthropic-ai/sdk'
import {
  executeTool,
  getAbortSignal,
  getActiveTools,
  shouldAbortAfterTools,
  type ToolDefinition,
} from '@/ai/console/tools.ts'
import { isAbortLikeError } from '/lib/isAbortError.ts'
import { DEFAULT_MAX_TOKENS } from '@/ai/config.ts'
import type { ChatCallbacks } from '@/ai/console/consoleAction.ts'
import { getModuleContent } from '@/ai/console/systemPrompt.ts'

type MessageParam = Anthropic.MessageParam
type ToolResultBlockParam = Anthropic.ToolResultBlockParam

function toAnthropicTools(
  tools: ToolDefinition[],
): Anthropic.Tool[] {
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.parameters as Anthropic.Tool['input_schema'],
  }))
}

export class AnthropicProvider {
  private client: Anthropic
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
    this.client = new Anthropic({ apiKey })
    this.model = model
    this.systemPrompt = systemPrompt
    this.callbacks = callbacks
  }

  setSystemPrompt(systemPrompt: string): void {
    this.systemPrompt = systemPrompt
  }

  async chat(userMessage: string): Promise<void> {
    this.messages.push({ role: 'user', content: userMessage })

    while (true) {
      const stream = this.client.messages.stream(
        {
          model: this.model,
          max_tokens: DEFAULT_MAX_TOKENS,
          system: this.systemPrompt + getModuleContent(),
          messages: this.messages,
          tools: toAnthropicTools(getActiveTools()),
        },
        // Ctrl+C aborts this signal — cancels the in-flight HTTP stream
        // immediately instead of waiting for the model's next token.
        { signal: getAbortSignal() },
      )

      let assistantText = ''
      const toolUseBlocks: {
        id: string
        name: string
        input: Record<string, unknown>
      }[] = []

      // Stream text in real-time via callback
      stream.on('text', (text) => {
        assistantText += text
        this.callbacks.onStream(assistantText)
      })

      let response
      try {
        response = await stream.finalMessage()
      } catch (err) {
        // The SDK throws APIUserAbortError / AbortError when the signal
        // fires. Exit the loop cleanly so the TUI returns to an input-
        // ready state instead of surfacing the abort as a red error.
        if (isAbortLikeError(err)) {
          this.callbacks.onComplete()
          return
        }
        throw err
      }

      // Collect tool_use blocks from the final message
      for (const block of response.content) {
        if (block.type === 'tool_use') {
          toolUseBlocks.push({
            id: block.id,
            name: block.name,
            input: block.input as Record<string, unknown>,
          })
        }
      }

      // Save assistant message with the raw response content
      this.messages.push({ role: 'assistant', content: response.content })

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

      // User pressed Ctrl+C during tool execution. The tool_result is still
      // appended (API contract requires it for every tool_use), but we do
      // NOT request another turn — the user wants control back.
      if (shouldAbortAfterTools(this.callbacks.onComplete)) break

      // Continue loop to let model respond after tool results
    }
  }
}
