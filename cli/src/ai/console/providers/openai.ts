import OpenAI from 'openai'
import { colors } from '@cliffy/colors'
import { SYSTEM_PROMPT } from '@/ai/console/systemPrompt.ts'
import {
  executeTool,
  TOOL_DEFINITIONS,
  type ToolDefinition,
} from '@/ai/console/tools.ts'

type Message = OpenAI.ChatCompletionMessageParam

function toOpenAITools(
  tools: ToolDefinition[],
): OpenAI.ChatCompletionTool[] {
  return tools.map((t) => ({
    type: 'function' as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    },
  }))
}

export class OpenAIProvider {
  private client: OpenAI
  private model: string
  private messages: Message[] = []

  constructor(apiKey: string, model: string) {
    this.client = new OpenAI({ apiKey })
    this.model = model
    this.messages = [
      { role: 'system', content: SYSTEM_PROMPT },
    ]
  }

  async chat(userMessage: string): Promise<void> {
    this.messages.push({ role: 'user', content: userMessage })

    while (true) {
      const stream = await this.client.chat.completions.create({
        model: this.model,
        messages: this.messages,
        tools: toOpenAITools(TOOL_DEFINITIONS),
        stream: true,
      })

      let assistantContent = ''
      const toolCalls: {
        id: string
        name: string
        arguments: string
      }[] = []

      process.stdout.write(colors.rgb24('\n  ', 0x14f195))

      for await (const chunk of stream) {
        const delta = chunk.choices[0]?.delta

        if (delta?.content) {
          const text = delta.content
          assistantContent += text
          process.stdout.write(colors.white(text))
        }

        if (delta?.tool_calls) {
          for (const tc of delta.tool_calls) {
            if (tc.index !== undefined) {
              while (toolCalls.length <= tc.index) {
                toolCalls.push({ id: '', name: '', arguments: '' })
              }
              if (tc.id) toolCalls[tc.index].id = tc.id
              if (tc.function?.name) {
                toolCalls[tc.index].name = tc.function.name
              }
              if (tc.function?.arguments) {
                toolCalls[tc.index].arguments += tc.function.arguments
              }
            }
          }
        }
      }

      console.log()

      if (toolCalls.length === 0) {
        this.messages.push({
          role: 'assistant',
          content: assistantContent,
        })
        break
      }

      // Handle tool calls
      this.messages.push({
        role: 'assistant',
        content: assistantContent || null,
        tool_calls: toolCalls.map((tc) => ({
          id: tc.id,
          type: 'function' as const,
          function: { name: tc.name, arguments: tc.arguments },
        })),
      })

      for (const tc of toolCalls) {
        let args: Record<string, string>
        try {
          args = JSON.parse(tc.arguments)
        } catch (e) {
          const errMsg = `Failed to parse tool arguments: ${(e as Error).message}`
          this.messages.push({
            role: 'tool',
            tool_call_id: tc.id,
            content: errMsg,
          })
          continue
        }
        const result = await executeTool(tc.name, args)
        this.messages.push({
          role: 'tool',
          tool_call_id: tc.id,
          content: result,
        })
      }

      // Continue the loop to let the model respond after tool results
    }
  }
}
