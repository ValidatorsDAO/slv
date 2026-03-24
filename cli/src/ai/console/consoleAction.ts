import { colors } from '@cliffy/colors'
import { readAiConfig } from '@/ai/config.ts'
import { OpenAIProvider } from '@/ai/console/providers/openai.ts'
import { AnthropicProvider } from '@/ai/console/providers/anthropic.ts'
import denoJson from '/deno.json' with { type: 'json' }

type Provider = OpenAIProvider | AnthropicProvider

const readLine = async (): Promise<string | null> => {
  const chunks: Uint8Array[] = []
  const buf = new Uint8Array(4096)

  while (true) {
    const n = await Deno.stdin.read(buf)
    if (n === null) {
      if (chunks.length === 0) return null
      break
    }
    chunks.push(buf.slice(0, n))
    // Check if we received a newline — indicates end of line
    if (buf.subarray(0, n).includes(10)) break
  }

  const totalLength = chunks.reduce((sum, c) => sum + c.length, 0)
  const merged = new Uint8Array(totalLength)
  let offset = 0
  for (const chunk of chunks) {
    merged.set(chunk, offset)
    offset += chunk.length
  }
  return new TextDecoder().decode(merged).trim()
}

export const consoleAction = async () => {
  const config = await readAiConfig()
  if (!config) {
    console.log(
      colors.yellow(
        '\n  AI not configured. Run `slv onboard` first.\n',
      ),
    )
    return
  }

  const providerLabel = config.provider === 'openai' ? 'OpenAI' : 'Anthropic'

  console.log(
    colors.bold.rgb24(
      `\n  SLV AI Console v${denoJson.version}`,
      0x14f195,
    ),
  )
  console.log(
    colors.white(
      `  Provider: ${providerLabel} | Model: ${config.model}`,
    ),
  )
  console.log(
    colors.rgb24(
      '  Type /exit to quit, /clear to reset conversation.\n',
      0x888888,
    ),
  )

  let provider: Provider
  if (config.provider === 'openai') {
    provider = new OpenAIProvider(config.api_key, config.model)
  } else {
    provider = new AnthropicProvider(config.api_key, config.model)
  }

  while (true) {
    process.stdout.write(
      colors.bold.rgb24('slv> ', 0x14f195),
    )

    const input = await readLine()
    if (input === null) break

    if (input === '') continue

    if (input === '/exit' || input === '/quit') {
      console.log(colors.rgb24('\n  Goodbye!\n', 0x888888))
      break
    }

    if (input === '/clear') {
      if (config.provider === 'openai') {
        provider = new OpenAIProvider(config.api_key, config.model)
      } else {
        provider = new AnthropicProvider(config.api_key, config.model)
      }
      console.log(
        colors.rgb24('  Conversation cleared.\n', 0x888888),
      )
      continue
    }

    if (input === '/help') {
      console.log(colors.white('\n  Commands:'))
      console.log(colors.white('  /exit, /quit  — Exit the console'))
      console.log(
        colors.white('  /clear        — Clear conversation history'),
      )
      console.log(colors.white('  /help         — Show this help\n'))
      continue
    }

    try {
      await provider.chat(input)
      console.log()
    } catch (error) {
      console.log(
        colors.red(
          `\n  Error: ${(error as Error).message}\n`,
        ),
      )
    }
  }
}
