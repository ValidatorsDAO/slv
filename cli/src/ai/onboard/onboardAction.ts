import { Checkbox, Input, Secret, Select } from '@cliffy/prompt'
import { colors } from '@cliffy/colors'
import { parse, stringify } from '@std/yaml'
import { slvAA } from '/lib/slvAA.ts'
import denoJson from '/deno.json' with { type: 'json' }
import {
  type AiProvider,
  // ANTHROPIC_MODELS and OPENAI_MODELS available via manual ~/.slv/api.yml config
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
  'gRPC Geyser Streaming': { name: 'slv-grpc-geyser', agent: 'Tina' },
  'Benchmark & Connectivity Testing': { name: 'slv-benchmark', agent: 'Cid' },
  'Solana App Development': { name: 'slv-app', agent: 'Setzer' },
  'Server Procurement': { name: 'slv-server-procurement', agent: 'Figaro' },
}

const hasBenchmarkOps = (selectedOps: string[]) =>
  selectedOps.includes('Index RPC Node Operations') ||
  selectedOps.includes('gRPC Geyser Streaming')

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

  // Default to SLV AI — no provider selection needed
  // Users can manually configure OpenAI/Anthropic in ~/.slv/api.yml if desired
  console.log(colors.green('  ✔ Using SLV AI (powered by your SLV API Key).\n'))

  await writeAiConfig({
    provider: 'slv' as AiProvider,
    api_key: '',
    model: 'SLV AI',
  })

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
      { name: 'Benchmark & Connectivity Testing', value: 'Benchmark & Connectivity Testing', checked: true },
      { name: 'Solana App Development (Trade Bot)', value: 'Solana App Development' },
      { name: 'Server Procurement', value: 'Server Procurement', checked: true },
    ],
  })

  // --- Deployment mode ---
  const deployMode = await Select.prompt({
    message: 'Deployment mode',
    options: [
      { name: 'Local — deploy to this machine', value: 'local' },
      { name: 'Remote — deploy to remote servers via SSH', value: 'remote' },
    ],
  })

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
- **Cecil** — Solana Validator specialist (slv-validator skill)
- **Tina** — Index RPC Node specialist (slv-rpc skill)
- **Cloud** — gRPC Geyser Streaming specialist (slv-grpc-geyser skill)
- **Cid** — Benchmark & connectivity testing specialist (grpc_test, geyserbench, shreds_test)
- **Setzer** — Solana App specialist (slv-app skill, trade bot creation)

## Behavior
- Greet the user by their preferred name
- Analyze user requests and delegate to the appropriate sub-agent
- For validator tasks → delegate to Cecil
- For RPC node tasks → delegate to Tina
- For benchmark/connectivity test tasks → delegate to Cid
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
  // Cid reads slv-rpc SKILL.md as additional context for benchmarks,
  // but this is handled in tools.ts (injectSkillDocs), not via config.yml.
  // Do NOT add a duplicate slv-rpc entry for Cid here.
  const configData = {
    skills,
    auto_execute: true,  // Commands execute without confirmation by default
    mode: deployMode,
  }
  const configYml = stringify(configData as Record<string, unknown>)
  await Deno.writeTextFile(`${agentDir}/config.yml`, configYml)

  // --- GitHub Setup (optional) ---
  console.log(
    colors.bold.rgb24('\n│  GitHub Setup (optional)', 0x14f195),
  )

  // Check if gh CLI is available and authenticated
  let ghAuthenticated = false
  try {
    const p = new Deno.Command('gh', {
      args: ['auth', 'status'],
      stdout: 'piped',
      stderr: 'piped',
    })
    const { success } = await p.output()
    ghAuthenticated = success
  } catch {
    /* gh not installed */
  }

  if (ghAuthenticated) {
    console.log(colors.green('  ✔ GitHub CLI already authenticated.\n'))
  } else {
    // Check if gh is installed
    let ghInstalled = false
    try {
      const p = new Deno.Command('gh', {
        args: ['--version'],
        stdout: 'piped',
        stderr: 'piped',
      })
      const { success } = await p.output()
      ghInstalled = success
    } catch {
      /* not installed */
    }

    if (!ghInstalled) {
      console.log(
        colors.rgb24(
          '  GitHub CLI (gh) not found. Install it from https://cli.github.com/\n',
          0x888888,
        ),
      )
      console.log(
        colors.rgb24('  Skipped. You can set up GitHub later.\n', 0x888888),
      )
    } else {
      const setupGh = await Select.prompt({
        message:
          'Set up GitHub authentication? (enables repo creation, PRs, etc.)',
        options: [
          { name: 'Yes — run gh auth login', value: 'yes' },
          { name: 'Skip for now', value: 'skip' },
        ],
      })

      if (setupGh === 'yes') {
        console.log(colors.white('\n  Running `gh auth login`...\n'))
        const proc = new Deno.Command('gh', {
          args: ['auth', 'login'],
          stdin: 'inherit',
          stdout: 'inherit',
          stderr: 'inherit',
        })
        const { success } = await proc.output()
        if (success) {
          console.log(colors.green('\n  ✔ GitHub authenticated.\n'))
        } else {
          console.log(
            colors.yellow(
              '\n  ⚠ GitHub authentication failed. You can retry with `gh auth login`.\n',
            ),
          )
        }
      } else {
        console.log(
          colors.rgb24(
            '  Skipped. You can run `gh auth login` later.\n',
            0x888888,
          ),
        )
      }
    }
  }

  // --- Notifications (optional) ---
  console.log(
    colors.bold.rgb24('\n│  Notifications (optional)', 0x14f195),
  )

  const discordWebhook = await Input.prompt({
    message: 'Discord Webhook URL for notifications (Enter to skip)',
    default: '',
  })

  if (discordWebhook && discordWebhook.trim().length > 0) {
    // Save to api.yml preserving existing content
    const apiYmlPath = `${agentHome}/.slv/api.yml`
    let existing: Record<string, unknown> = {}
    try {
      const content = await Deno.readTextFile(apiYmlPath)
      existing = (parse(content) as Record<string, unknown>) ?? {}
    } catch { /* file doesn't exist */ }
    existing.notifications = { discord_webhook: discordWebhook.trim() }
    await Deno.writeTextFile(apiYmlPath, stringify(existing))
    await Deno.chmod(apiYmlPath, 0o600)
    console.log(colors.green('  ✔ Discord Webhook saved to ~/.slv/api.yml\n'))
  } else {
    console.log(colors.rgb24('  Skipped.\n', 0x888888))
  }

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
  console.log(
    colors.green('◇  AI configuration saved to ~/.slv/api.yml'),
  )
  console.log(
    colors.bold.rgb24('│', 0x14f195),
  )
  console.log(
    colors.rgb24(
      `└  Run \`slv c\` to start the AI console.\n`,
      0x14f195,
    ),
  )
}
