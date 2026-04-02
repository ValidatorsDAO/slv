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

const selectModel = async (provider: AiProvider): Promise<string> => {
  const models = provider === 'anthropic' ? ANTHROPIC_MODELS : OPENAI_MODELS

  const model = await Select.prompt({
    message: 'Select default model',
    options: models.map((m) => ({ name: m, value: m })),
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
  if (key.length <= 8) return key
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

    if (options.anthropic) {
      provider = 'anthropic'
      apiKey = options.anthropic
    } else if (options.openai) {
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

    const model = await selectModel(provider)
    await saveAndSummarize(provider, apiKey, model)
  })
