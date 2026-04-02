import { Command } from '@cliffy'
import { Input, Secret, Select } from '@cliffy/prompt'
import { colors } from '@cliffy/colors'
import {
  type AiConfig,
  type AiProvider,
  ANTHROPIC_MODELS,
  OPENAI_MODELS,
  writeAiConfig,
} from '@/ai/config.ts'

const CUSTOM_OPTION = 'Custom (enter model name)'

/**
 * Validate an API key by making a lightweight request to the provider.
 * Returns true if the key is valid, false otherwise.
 */
const validateApiKey = async (
  provider: AiProvider,
  apiKey: string,
): Promise<{ valid: boolean; error?: string }> => {
  try {
    if (provider === 'anthropic') {
      // Use messages API with minimal request to validate
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 1,
          messages: [{ role: 'user', content: 'hi' }],
        }),
      })
      if (res.status === 401) {
        return { valid: false, error: 'Invalid API key' }
      }
      if (res.status === 403) {
        const body = await res.json().catch(() => ({}))
        return { valid: false, error: (body as Record<string, Record<string, string>>)?.error?.message || 'Access denied' }
      }
      // 200 or 429 (rate limit) or 400 all mean the key itself is valid
      return { valid: true }
    } else if (provider === 'openai') {
      // Use models list endpoint — lightweight and doesn't consume tokens
      const res = await fetch('https://api.openai.com/v1/models', {
        headers: { 'Authorization': `Bearer ${apiKey}` },
      })
      if (res.status === 401) {
        return { valid: false, error: 'Invalid API key' }
      }
      return { valid: true }
    }
    return { valid: true }
  } catch (e) {
    return { valid: false, error: `Connection error: ${(e as Error).message}` }
  }
}

const selectModel = async (provider: AiProvider): Promise<string> => {
  const models = provider === 'anthropic' ? ANTHROPIC_MODELS : OPENAI_MODELS

  const model = await Select.prompt({
    message: 'Select default model',
    options: models,
  })

  if (model === CUSTOM_OPTION) {
    return await Input.prompt({
      message: 'Enter model name',
      validate: (v) => v.trim().length > 0 || 'Model name is required',
    })
  }

  return model
}

const maskKey = (key: string): string => {
  if (key.length <= 4) return '****'
  if (key.length <= 8) return key.slice(0, 4) + '****'
  return key.slice(0, 8) + '...'
}

const saveAndSummarize = async (
  provider: AiProvider,
  apiKey: string,
  model: string,
) => {
  const config: AiConfig = { provider, api_key: apiKey, model }
  await writeAiConfig(config)

  console.log(colors.green('\n✔ Configuration saved to ~/.slv/api.yml\n'))
  console.log(
    colors.bold.rgb24('  Provider: ', 0x14f195) +
      colors.white(provider),
  )
  console.log(
    colors.bold.rgb24('  Model:    ', 0x14f195) +
      colors.white(model),
  )
  console.log(
    colors.bold.rgb24('  Key:      ', 0x14f195) +
      colors.white(maskKey(apiKey)),
  )
  console.log()
}

export const authCmd = new Command()
  .description(colors.white('Configure AI provider API key and default model'))
  .option('--anthropic <key:string>', 'Set Anthropic API key')
  .option('--openai <key:string>', 'Set OpenAI API key')
  .action(async (options: { anthropic?: string; openai?: string }) => {
    console.log(
      colors.bold.rgb24('\n┌  SLV Auth — AI Provider Setup\n│', 0x14f195),
    )

    let provider: AiProvider
    let apiKey: string

    // Exclusive flag check
    if (options.anthropic && options.openai) {
      console.error(colors.red('Error: --anthropic and --openai cannot be used together'))
      Deno.exit(1)
    }

    if (options.anthropic) {
      if (options.anthropic.trim().length === 0) {
        console.error(colors.red('Error: API key cannot be empty'))
        Deno.exit(1)
      }
      provider = 'anthropic'
      apiKey = options.anthropic
    } else if (options.openai) {
      if (options.openai.trim().length === 0) {
        console.error(colors.red('Error: API key cannot be empty'))
        Deno.exit(1)
      }
      provider = 'openai'
      apiKey = options.openai
    } else {
      // Interactive mode
      const selected = await Select.prompt({
        message: 'Select AI provider',
        options: [
          { name: 'Anthropic', value: 'anthropic' },
          { name: 'OpenAI', value: 'openai' },
        ],
      })
      provider = selected as AiProvider

      apiKey = await Secret.prompt({
        message: `Enter ${provider === 'anthropic' ? 'Anthropic' : 'OpenAI'} API key`,
        validate: (v) => v.trim().length > 0 || 'API key is required',
      })
    }

    // Validate API key before saving
    console.log(colors.gray('\n  Validating API key...'))
    const validation = await validateApiKey(provider, apiKey)
    if (!validation.valid) {
      console.error(colors.red(`\n  ✗ ${validation.error || 'Invalid API key'}`))
      console.error(colors.gray('  Please check your API key and try again.\n'))
      Deno.exit(1)
    }
    console.log(colors.green('  ✔ API key is valid\n'))

    const model = await selectModel(provider)
    await saveAndSummarize(provider, apiKey, model)
  })
