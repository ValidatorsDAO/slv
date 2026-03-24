import Anthropic from '@anthropic-ai/sdk'
import { colors } from '@cliffy/colors'
import {
  executeTool,
  TOOL_DEFINITIONS,
  type ToolDefinition,
} from '@/ai/console/tools.ts'
import { DEFAULT_MAX_TOKENS } from '@/ai/config.ts'

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

  constructor(apiKey: string, model: string, systemPrompt: string) {
    this.client = new Anthropic({ apiKey })
    this.model = model
    this.systemPrompt = systemPrompt
  }

  async chat(userMessage: string): Promise<void> {
    this.messages.push({ role: 'user', content: userMessage })

    while (true) {
      const stream = this.client.messages.stream({
        model: this.model,
        max_tokens: DEFAULT_MAX_TOKENS,
        system: this.systemPrompt,
        messages: this.messages,
        tools: toAnthropicTools(TOOL_DEFINITIONS),
      })

      let assistantText = ''
      const toolUseBlocks: {
        id: string
        name: string
        input: Record<string, unknown>
      }[] = []

      process.stdout.write(colors.rgb24('\n  ', 0x14f195))

      // Stream text in real-time
      stream.on('text', (text) => {
        assistantText += text
        process.stdout.write(colors.white(text))
      })

      const response = await stream.finalMessage()

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

      console.log()

      // Save assistant message with the raw response content
      this.messages.push({ role: 'assistant', content: response.content })

      if (toolUseBlocks.length === 0) {
        break
      }

      // Execute tools and add results
      const toolResults: ToolResultBlockParam[] = []
      for (const tb of toolUseBlocks) {
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
