import OpenAI from 'openai'
import {
  executeTool,
  getAbortSignal,
  getActiveTools,
  shouldAbortAfterTools,
  type ToolDefinition,
} from '@/ai/console/tools.ts'
import { isAbortLikeError } from '/lib/isAbortError.ts'
import type { ChatCallbacks } from '@/ai/console/consoleAction.ts'
import { getModuleContent } from '@/ai/console/systemPrompt.ts'
import type { MessageInput } from '@/ai/core/messageInput.ts'
import { getMessageText } from '@/ai/core/messageInput.ts'

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
  private systemPrompt: string
  private callbacks: ChatCallbacks

  constructor(
    apiKey: string,
    model: string,
    systemPrompt: string,
    callbacks: ChatCallbacks,
  ) {
    this.client = new OpenAI({ apiKey })
    this.model = model
    this.callbacks = callbacks
    this.systemPrompt = systemPrompt
    this.messages = [
      { role: 'system', content: systemPrompt },
    ]
  }

  setSystemPrompt(systemPrompt: string): void {
    this.systemPrompt = systemPrompt
    this.messages[0] = {
      role: 'system',
      content: systemPrompt + getModuleContent(),
    }
  }

  /** Swap per-turn callbacks — see SLVProvider.updateCallbacks. */
  updateCallbacks(callbacks: ChatCallbacks): void {
    this.callbacks = callbacks
  }

  async chat(userMessage: MessageInput): Promise<void> {
    // OpenAI's vision format differs from Anthropic's. We only ship
    // vision through SLV (Anthropic) for now, so drop any attached
    // images and use the text — the browser UI's pre-flight check
    // already warns the user when the provider is not slv. This
    // stays a one-liner change so adding OpenAI vision later is
    // local to this file.
    this.messages.push({ role: 'user', content: getMessageText(userMessage) })

    while (true) {
      // Update system message with any newly loaded context modules
      this.messages[0] = {
        role: 'system',
        content: this.systemPrompt + getModuleContent(),
      }

      let stream
      try {
        stream = await this.client.chat.completions.create(
          {
            model: this.model,
            messages: this.messages,
            tools: toOpenAITools(getActiveTools()),
            stream: true,
          },
          // Ctrl+C cancels the in-flight HTTP stream immediately.
          { signal: getAbortSignal() },
        )
      } catch (err) {
        if (isAbortLikeError(err)) {
          this.callbacks.onComplete()
          return
        }
        throw err
      }

      let assistantContent = ''
      const toolCalls: {
        id: string
        name: string
        arguments: string
      }[] = []

      try {
        for await (const chunk of stream) {
          const delta = chunk.choices[0]?.delta

          if (delta?.content) {
            const text = delta.content
            assistantContent += text
            this.callbacks.onStream(assistantContent)
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
      } catch (err) {
        if (isAbortLikeError(err)) {
          this.callbacks.onComplete()
          return
        }
        throw err
      }

      if (toolCalls.length === 0) {
        this.messages.push({
          role: 'assistant',
          content: assistantContent,
        })
        this.callbacks.onComplete()
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
        let args: Record<string, unknown>
        try {
          args = JSON.parse(tc.arguments)
        } catch (e) {
          const errMsg = `Failed to parse tool arguments: ${
            (e as Error).message
          }`
          this.messages.push({
            role: 'tool',
            tool_call_id: tc.id,
            content: errMsg,
          })
          continue
        }
        this.callbacks.onToolCall(tc.name, JSON.stringify(args).slice(0, 200))
        const result = await executeTool(tc.name, args)
        this.messages.push({
          role: 'tool',
          tool_call_id: tc.id,
          content: result,
        })
      }

      // User pressed Ctrl+C during tool execution — stop here instead of
      // requesting another turn so the user stays in control.
      if (shouldAbortAfterTools(this.callbacks.onComplete)) break

      // Continue the loop to let the model respond after tool results
    }
  }
}
