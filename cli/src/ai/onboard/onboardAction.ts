import { Confirm, Input, Secret, Select } from '@cliffy/prompt'
import { colors } from '@cliffy/colors'
import { slvAA } from '/lib/slvAA.ts'
import denoJson from '/deno.json' with { type: 'json' }
import {
  type AiProvider,
  ANTHROPIC_MODELS,
  OPENAI_MODELS,
  writeAiConfig,
} from '@/ai/config.ts'

const printSecurityWarning = () => {
  const w = 72
  const border = colors.yellow
  const line = (text: string) => {
    const stripped = text.replace(
      // deno-lint-ignore no-control-regex
      /\x1b\[[0-9;]*m/g,
      '',
    )
    const pad = w - 2 - stripped.length
    return border('│') + ' ' + text + ' '.repeat(Math.max(0, pad - 1)) +
      border('│')
  }

  console.log()
  console.log(
    border('┌─ Security ') + border('─'.repeat(w - 13)) + border('┐'),
  )
  console.log(line(''))
  console.log(
    line(
      colors.bold.white('Security warning — please read.'),
    ),
  )
  console.log(line(''))
  console.log(
    line(
      colors.white(
        'SLV AI Console can execute commands on your system.',
      ),
    ),
  )
  console.log(
    line(
      colors.white(
        'A bad prompt can trick it into doing unsafe things.',
      ),
    ),
  )
  console.log(line(''))
  console.log(
    line(colors.white('Recommended:')),
  )
  console.log(
    line(
      colors.white(
        '- Review commands before confirming execution.',
      ),
    ),
  )
  console.log(
    line(
      colors.white("- Don't paste untrusted prompts."),
    ),
  )
  console.log(
    line(
      colors.white(
        '- Keep secrets out of the conversation.',
      ),
    ),
  )
  console.log(line(''))
  console.log(
    border('└') + border('─'.repeat(w - 2)) + border('┘'),
  )
  console.log()
}

export const onboardAction = async () => {
  slvAA(denoJson.version)

  console.log(
    colors.bold.rgb24('\n┌  SLV AI Onboarding\n│', 0x14f195),
  )

  printSecurityWarning()

  const accepted = await Confirm.prompt({
    message: 'I understand this is powerful and inherently risky. Continue?',
    default: false,
  })

  if (!accepted) {
    console.log(colors.yellow('\n  Setup cancelled.\n'))
    return
  }

  const provider: string = await Select.prompt({
    message: 'Model/auth provider',
    options: [
      { name: 'OpenAI', value: 'openai' },
      { name: 'Anthropic', value: 'anthropic' },
      { name: 'Skip for now', value: 'skip' },
    ],
  })

  if (provider === 'skip') {
    console.log(
      colors.yellow(
        '\n  Skipped. Run `slv onboard` again when ready.\n',
      ),
    )
    return
  }

  const models = provider === 'openai' ? OPENAI_MODELS : ANTHROPIC_MODELS
  const providerLabel = provider === 'openai' ? 'OpenAI' : 'Anthropic'

  const apiKey = await Secret.prompt({
    message: `${providerLabel} API Key`,
    validate: (value) => {
      if (!value || value.trim().length === 0) {
        return 'API key is required'
      }
      return true
    },
  })

  let model = await Select.prompt({
    message: 'Default model',
    options: models,
  })

  if (model === 'Custom (enter model name)') {
    model = await Input.prompt({
      message: 'Enter custom model name',
      validate: (value) => {
        if (!value || value.trim().length === 0) {
          return 'Model name is required'
        }
        return true
      },
    })
  }

  await writeAiConfig({
    provider: provider as AiProvider,
    api_key: apiKey,
    model,
  })

  console.log(
    colors.bold.rgb24('\n│', 0x14f195),
  )
  console.log(
    colors.green('◇  AI configuration saved to ~/.slv/api.yml'),
  )
  console.log(
    colors.bold.rgb24('│', 0x14f195),
  )
  console.log(
    colors.white(`  Provider: ${colors.bold(providerLabel)}`),
  )
  console.log(
    colors.white(`  Model:    ${colors.bold(model)}`),
  )
  console.log(
    colors.bold.rgb24('│', 0x14f195),
  )
  console.log(
    colors.rgb24(
      '└  Run `slv c` to start the AI console.\n',
      0x14f195,
    ),
  )
}
