import { Checkbox, Input, Secret, Select } from '@cliffy/prompt'
import { colors } from '@cliffy/colors'
import { parse, stringify } from '@std/yaml'
import { slvAA } from '/lib/slvAA.ts'
import denoJson from '/deno.json' with { type: 'json' }
import {
  type AiProvider,
  ANTHROPIC_MODELS,
  OPENAI_MODELS,
  writeAiConfig,
} from '@/ai/config.ts'
import { isValidApiKey, resolveHome } from '/lib/getApiKeyFromYml.ts'

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

const SKILL_MAP: Record<string, { name: string; agent: string }> = {
  'Solana Validator Operations': { name: 'slv-validator', agent: 'Cecil' },
  'Index RPC Node Operations': { name: 'slv-rpc', agent: 'Tina' },
  'gRPC Geyser Streaming': { name: 'slv-grpc-geyser', agent: 'Cloud' },
}

export const onboardAction = async () => {
  slvAA(denoJson.version)

  console.log(
    colors.bold.rgb24('\n┌  SLV AI Onboarding\n│', 0x14f195),
  )

  printSecurityWarning()

  const accepted = await Select.prompt({
    message: 'I understand this is powerful and inherently risky. Continue?',
    options: [
      { name: 'Yes', value: 'yes' },
      { name: 'No', value: 'no' },
    ],
  })

  if (accepted !== 'yes') {
    console.log(colors.yellow('\n  Setup cancelled.\n'))
    return
  }

  // Check for existing SLV API key
  const home = resolveHome()
  const apiYmlPath = `${home}/.slv/api.yml`
  let hasSlvKey = false
  try {
    const raw = await Deno.readTextFile(apiYmlPath)
    const yml = parse(raw) as { slv?: { api_key?: string } } | null
    hasSlvKey = !!(yml?.slv?.api_key && isValidApiKey(String(yml.slv.api_key)))
  } catch { /* file doesn't exist yet */ }

  if (!hasSlvKey) {
    console.log(
      colors.bold.rgb24('│  SLV API Key', 0x14f195),
    )
    console.log(
      colors.white(
        `  Get your free API key: https://discord.gg/S2gEbJTGJA\n`,
      ),
    )

    const slvApiKey = await Secret.prompt({
      message: '🔑 SLV API Key (or press Enter to skip)',
    })

    if (slvApiKey && slvApiKey.trim().length > 0) {
      await Deno.mkdir(`${home}/.slv`, { recursive: true })
      // Read existing or create new
      let existing: Record<string, unknown> = {}
      try {
        const content = await Deno.readTextFile(apiYmlPath)
        existing = (parse(content) as Record<string, unknown>) ?? {}
      } catch { /* file doesn't exist */ }
      existing.slv = { api_key: slvApiKey.trim() }
      await Deno.writeTextFile(apiYmlPath, stringify(existing))
      await Deno.chmod(apiYmlPath, 0o600)
      console.log(colors.green('  ✔ SLV API Key saved.\n'))
    } else {
      console.log(colors.rgb24('  Skipped. You can run `slv login` later.\n', 0x888888))
    }
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
        '\n  AI provider skipped. You can configure it later with `slv onboard`.\n',
      ),
    )
  } else {
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
  }

  // --- Agent setup ---
  console.log(
    colors.bold.rgb24('\n│  Agent Setup', 0x14f195),
  )

  const userName = await Input.prompt({
    message: 'Your name',
    validate: (v) => v.trim().length > 0 || 'Name is required',
  })

  const callMe = await Input.prompt({
    message: 'What should the AI call you?',
    default: userName,
  })

  const agentName = await Input.prompt({
    message: 'Name your main AI agent',
    default: 'SLV Agent',
  })

  const selectedOps: string[] = await Checkbox.prompt({
    message: 'What will you be doing? (↑↓ move, Space toggle, Enter confirm)',
    options: [
      { name: 'Solana Validator Operations', value: 'Solana Validator Operations', checked: true },
      { name: 'Index RPC Node Operations', value: 'Index RPC Node Operations', checked: true },
      { name: 'gRPC Geyser Streaming', value: 'gRPC Geyser Streaming', checked: true },
      { name: '🔜 Build a Trade App', value: 'Build a Trade App' },
    ],
  })

  // Handle Trade App selection
  if (selectedOps.includes('Build a Trade App')) {
    console.log(colors.yellow('  🔜 Trade App — Coming soon...\n'))
  }

  // Build config
  const agentHome = resolveHome()
  const agentDir = `${agentHome}/.slv/agent`
  await Deno.mkdir(agentDir, { recursive: true })

  // USER.md
  const userMd = `# USER.md
- **Name:** ${userName}
- **Call me:** ${callMe}
`
  await Deno.writeTextFile(`${agentDir}/USER.md`, userMd)

  // SOUL.md
  const soulMd = `# SOUL.md — Main Agent
- **Name:** ${agentName}
- **Role:** Commander — routes tasks to specialist sub-agents

## Sub-Agents
- **Cecil (セシル)** — Solana Validator specialist (slv-validator skill)
- **Tina (ティナ)** — Index RPC Node specialist (slv-rpc skill)
- **Cloud (クラウド)** — gRPC Geyser Streaming specialist (slv-grpc-geyser skill)

## Behavior
- Greet the user by their preferred name
- Analyze user requests and delegate to the appropriate sub-agent
- For validator tasks → delegate to Cecil
- For RPC node tasks → delegate to Tina
- For gRPC Geyser tasks → delegate to Cloud
- Summarize sub-agent results for the user
`
  await Deno.writeTextFile(`${agentDir}/SOUL.md`, soulMd)

  // MEMORY.md
  const memoryMd = `# MEMORY.md
Session history and important notes.
`
  await Deno.writeTextFile(`${agentDir}/MEMORY.md`, memoryMd)

  // config.yml
  const allSkillKeys = Object.keys(SKILL_MAP)
  const skills = allSkillKeys.map((key) => ({
    name: SKILL_MAP[key].name,
    enabled: selectedOps.includes(key),
    agent: SKILL_MAP[key].agent,
  }))
  const configYml = stringify({ skills } as Record<string, unknown>)
  await Deno.writeTextFile(`${agentDir}/config.yml`, configYml)

  console.log(
    colors.bold.rgb24('\n│', 0x14f195),
  )
  console.log(
    colors.green('◇  Agent files saved to ~/.slv/agent/'),
  )
  console.log(
    colors.bold.rgb24('│', 0x14f195),
  )
  console.log(
    colors.white(`  Agent:    ${colors.bold(agentName)}`),
  )
  if (provider !== 'skip') {
    console.log(
      colors.green('◇  AI configuration saved to ~/.slv/api.yml'),
    )
  }
  console.log(
    colors.bold.rgb24('│', 0x14f195),
  )
  console.log(
    colors.rgb24(
      `└  ${provider !== 'skip' ? 'Run `slv c` to start the AI console.' : 'Run `slv onboard` again to configure AI provider.'}\n`,
      0x14f195,
    ),
  )
}
