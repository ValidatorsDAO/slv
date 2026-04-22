import { Checkbox, Input, Secret, Select } from '@cliffy/prompt'
import { colors } from '@cliffy/colors'
import { parse, stringify } from '@std/yaml'
import { slvAA } from '/lib/slvAA.ts'
import denoJson from '/deno.json' with { type: 'json' }
import {
  type AiProvider,
  // ANTHROPIC_MODELS and OPENAI_MODELS available via manual ~/.slv/api.yml config
  hasLangSet,
  readLang,
  writeAiConfig,
  writeLang,
  writeSudoersInstalledAt,
} from '@/ai/config.ts'
import {
  isSudoersTarget,
  promptAndInstallSudoers,
} from '@/ai/onboard/installSudoers.ts'
import { BUILTIN_LANGS, initI18n, t } from '@/ai/i18n/index.ts'
import { isValidApiKey, resolveHome } from '/lib/getApiKeyFromYml.ts'

// Approximate monospace display width: CJK/wide characters take 2 columns,
// combining marks take 0, most others 1. Used to pad i18n lines inside boxes
// so translated strings (Japanese, Chinese, …) don't break the borders.
const displayWidth = (text: string): number => {
  let w = 0
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0
    if (cp === 0) continue
    // Combining marks
    if ((cp >= 0x0300 && cp <= 0x036f) || (cp >= 0x1ab0 && cp <= 0x1aff)) {
      continue
    }
    // Wide ranges: CJK, Hangul, full-width forms, emoji presentation, etc.
    if (
      (cp >= 0x1100 && cp <= 0x115f) || // Hangul Jamo
      (cp >= 0x2e80 && cp <= 0x303e) || // CJK Radicals, Kangxi
      (cp >= 0x3041 && cp <= 0x33ff) || // Hiragana/Katakana/CJK symbols
      (cp >= 0x3400 && cp <= 0x4dbf) || // CJK Ext A
      (cp >= 0x4e00 && cp <= 0x9fff) || // CJK Unified
      (cp >= 0xa000 && cp <= 0xa4cf) || // Yi
      (cp >= 0xac00 && cp <= 0xd7a3) || // Hangul Syllables
      (cp >= 0xf900 && cp <= 0xfaff) || // CJK Compat Ideographs
      (cp >= 0xfe30 && cp <= 0xfe4f) || // CJK Compat Forms
      (cp >= 0xff00 && cp <= 0xff60) || // Fullwidth Forms
      (cp >= 0xffe0 && cp <= 0xffe6) || // Fullwidth signs
      (cp >= 0x1f300 && cp <= 0x1f64f) || // Misc Symbols / Emoji
      (cp >= 0x1f680 && cp <= 0x1f6ff) || // Transport
      (cp >= 0x1f900 && cp <= 0x1f9ff) || // Supplemental Symbols
      (cp >= 0x20000 && cp <= 0x2fffd) // CJK Ext B-F
    ) {
      w += 2
      continue
    }
    w += 1
  }
  return w
}

// Wrap a plain (unstyled) string into lines that fit `maxWidth` display cells.
// Breaks on spaces when possible; falls back to hard-cut for long CJK runs.
const wrapToWidth = (text: string, maxWidth: number): string[] => {
  const lines: string[] = []
  const words = text.split(/(\s+)/) // keep whitespace tokens
  let current = ''
  let currentW = 0
  const flush = () => {
    if (current.length > 0) {
      lines.push(current)
      current = ''
      currentW = 0
    }
  }
  for (const tok of words) {
    const tw = displayWidth(tok)
    if (currentW + tw <= maxWidth) {
      current += tok
      currentW += tw
      continue
    }
    if (tok.trim().length === 0) {
      flush()
      continue
    }
    // Token doesn't fit — if current has content, break first.
    if (currentW > 0) flush()
    if (tw <= maxWidth) {
      current = tok
      currentW = tw
      continue
    }
    // Hard-cut long token character-by-character.
    for (const ch of tok) {
      const cw = displayWidth(ch)
      if (currentW + cw > maxWidth) flush()
      current += ch
      currentW += cw
    }
  }
  flush()
  return lines.length > 0 ? lines : ['']
}

const printSecurityWarning = () => {
  const w = 72
  const border = colors.yellow
  const line = (text: string) => {
    const stripped = text.replace(
      // deno-lint-ignore no-control-regex
      /\x1b\[[0-9;]*m/g,
      '',
    )
    const pad = w - 2 - displayWidth(stripped)
    return border('│') + ' ' + text + ' '.repeat(Math.max(0, pad - 1)) +
      border('│')
  }
  // Print a possibly-wrapped translated string as one or more box lines. The
  // colorize callback is applied to each wrapped segment so styling is
  // preserved across lines.
  const printWrapped = (
    raw: string,
    colorize: (s: string) => string,
  ): void => {
    const innerWidth = w - 4 // 2 borders + leading space + trailing space
    for (const seg of wrapToWidth(raw, innerWidth)) {
      console.log(line(colorize(seg)))
    }
  }

  console.log()
  console.log(
    border('┌─ Security ') + border('─'.repeat(w - 13)) + border('┐'),
  )
  console.log(line(''))
  printWrapped(t('Security warning — please read.'), (s) => colors.bold.white(s))
  console.log(line(''))
  printWrapped(
    t('SLV AI Console can execute commands on your system.'),
    (s) => colors.white(s),
  )
  printWrapped(
    t('A bad prompt can trick it into doing unsafe things.'),
    (s) => colors.white(s),
  )
  console.log(line(''))
  printWrapped(t('Recommended:'), (s) => colors.white(s))
  printWrapped(
    t("- Don't paste untrusted prompts."),
    (s) => colors.white(s),
  )
  printWrapped(
    t('- Keep secrets out of the conversation.'),
    (s) => colors.white(s),
  )
  printWrapped(
    t(
      '- `slv bot init` ships a Solana transaction sample designed to be improved with your AI before real use. When using real SOL, assets may decrease — use at your own risk.',
    ),
    (s) => colors.white(s),
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

type ExistingDefaults = {
  userName?: string
  callMe?: string
  agentName?: string
  enabledOps?: string[]
  deployMode?: 'local' | 'remote'
  discordWebhook?: string
}

const loadExistingDefaults = async (
  home: string,
): Promise<ExistingDefaults> => {
  const agentDir = `${home}/.slv/agent`
  const defaults: ExistingDefaults = {}

  try {
    const userMd = await Deno.readTextFile(`${agentDir}/USER.md`)
    const nameMatch = userMd.match(/\*\*Name:\*\*\s*(.+)/)
    const callMatch = userMd.match(/\*\*Call me:\*\*\s*(.+)/)
    if (nameMatch) defaults.userName = nameMatch[1].trim()
    if (callMatch) defaults.callMe = callMatch[1].trim()
  } catch { /* no USER.md */ }

  try {
    const soulMd = await Deno.readTextFile(`${agentDir}/SOUL.md`)
    const nameMatch = soulMd.match(/\*\*Name:\*\*\s*(.+)/)
    if (nameMatch) defaults.agentName = nameMatch[1].trim()
  } catch { /* no SOUL.md */ }

  try {
    const raw = await Deno.readTextFile(`${agentDir}/config.yml`)
    const cfg = parse(raw) as {
      skills?: { name: string; enabled: boolean }[]
      mode?: string
    } | null
    if (cfg?.skills?.length) {
      // Reverse-map skill name → onboarding op label.
      const nameToOp: Record<string, string> = {}
      for (const [op, meta] of Object.entries(SKILL_MAP)) {
        nameToOp[meta.name] = op
      }
      defaults.enabledOps = cfg.skills
        .filter((s) => s.enabled && nameToOp[s.name])
        .map((s) => nameToOp[s.name])
    }
    if (cfg?.mode === 'local' || cfg?.mode === 'remote') {
      defaults.deployMode = cfg.mode
    }
  } catch { /* no config.yml */ }

  try {
    const raw = await Deno.readTextFile(`${home}/.slv/api.yml`)
    const yml = parse(raw) as {
      notifications?: { discord_webhook?: string }
    } | null
    const hook = yml?.notifications?.discord_webhook
    if (typeof hook === 'string' && hook.trim().length > 0) {
      defaults.discordWebhook = hook.trim()
    }
  } catch { /* no api.yml */ }

  return defaults
}

const hasBenchmarkOps = (selectedOps: string[]) =>
  selectedOps.includes('Index RPC Node Operations') ||
  selectedOps.includes('gRPC Geyser Streaming')

export const onboardAction = async () => {
  slvAA(denoJson.version)

  // --- Language gate ---
  // On first run (no lang in api.yml) prompt once. If user picks a non-English
  // builtin language we save it and ask them to re-run so the rest of onboard
  // can show in that language. On subsequent runs we skip this block entirely
  // (avoids the re-run loop) and just load the saved language.
  if (!(await hasLangSet())) {
    const picked = await Select.prompt({
      message: 'Select your language / 言語を選択 / Выберите язык',
      options: [
        { name: 'English', value: 'en' },
        { name: '日本語 (Japanese)', value: 'ja' },
        { name: '中文 (Chinese)', value: 'zh' },
        { name: 'Русский (Russian)', value: 'ru' },
        { name: 'Tiếng Việt (Vietnamese)', value: 'vi' },
        { name: 'Other (type your language)', value: '__other__' },
      ],
      default: 'en',
    })

    let chosenLang: string = picked
    if (picked === '__other__') {
      const typed = await Input.prompt({
        message: 'Enter your language (e.g. "de", "Français", "日本語")',
        default: 'en',
        validate: (v) => v.trim().length > 0 || 'Language is required',
      })
      chosenLang = typed.trim()
    }

    await writeLang(chosenLang)

    if (chosenLang !== 'en') {
      // Load i18n now so the re-run notice can be shown in the chosen language
      // (built-in langs only; "other" may fall back to English here if the AI
      // key isn't set yet, which is fine — the message is short).
      await initI18n()
      console.log()
      console.log(
        colors.yellow(
          `  ${t('Language saved. Please run `slv onboard` again to continue.')}`,
        ),
      )
      console.log()
      return
    }
  }

  await initI18n()

  console.log(
    colors.bold.rgb24(`\n┌  ${t('SLV AI Onboarding')}\n│`, 0x14f195),
  )

  printSecurityWarning()

  const accepted = await Select.prompt({
    message: t('I understand this is powerful and inherently risky. Continue?'),
    options: [
      { name: t('Yes'), value: 'yes' },
      { name: t('No'), value: 'no' },
    ],
  })

  if (accepted !== 'yes') {
    console.log(colors.yellow(`\n  ${t('Setup cancelled.')}\n`))
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
      colors.bold.rgb24(`│  ${t('SLV API Key')}`, 0x14f195),
    )
    console.log(
      colors.white(
        `  ${t('Get your free API key: https://discord.gg/S2gEbJTGJA')}\n`,
      ),
    )

    const slvApiKey = await Secret.prompt({
      message: t('🔑 SLV API Key (or press Enter to skip)'),
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
      console.log(colors.green(`  ✔ ${t('SLV API Key saved.')}\n`))
      // The just-entered SLV key unlocks AI translation for non-builtin langs.
      const currentLang = await readLang()
      if (!BUILTIN_LANGS[currentLang]) {
        await initI18n()
      }
    } else {
      console.log(
        colors.rgb24(`  ${t('Skipped. You can run `slv login` later.')}\n`, 0x888888),
      )
    }
  }

  // Default to SLV AI — no provider selection needed
  // Users can manually configure OpenAI/Anthropic in ~/.slv/api.yml if desired
  console.log(colors.green(`  ✔ ${t('Using SLV AI (powered by your SLV API Key).')}\n`))

  await writeAiConfig({
    provider: 'slv' as AiProvider,
    api_key: '',
    model: 'SLV AI',
  })

  // --- Agent setup ---
  console.log(
    colors.bold.rgb24(`\n│  ${t('Agent Setup')}`, 0x14f195),
  )

  // Pre-fill defaults from any existing agent config so a second-run onboard
  // just needs Enter-Enter-Enter unless the user wants to change something.
  const existing = await loadExistingDefaults(home)

  const userName = await Input.prompt({
    message: t('Your name'),
    default: existing.userName,
    validate: (v) => v.trim().length > 0 || t('Name is required'),
  })

  const callMe = await Input.prompt({
    message: t('What should the AI call you?'),
    default: existing.callMe ?? userName,
  })

  const agentName = await Input.prompt({
    message: t('Name your main AI agent'),
    default: existing.agentName ?? 'SLV Agent',
  })

  // Default the Checkbox to previously-enabled ops; fall back to first-run
  // defaults when nothing is saved yet.
  const isChecked = (op: string, firstRunDefault: boolean): boolean => {
    if (existing.enabledOps) return existing.enabledOps.includes(op)
    return firstRunDefault
  }
  // First-run defaults: only the top option is pre-checked. This narrows the
  // implied primary focus to Validator Operations (SLV's original flagship
  // use-case) and stops the onboarding flow from dumping the user into a
  // "you do everything" state. The user can still tick more with Space.
  // Second-run: defaults come from the existing config (`existing.enabledOps`).
  const selectedOps: string[] = await Checkbox.prompt({
    message: t('What will you be doing? (↑↓ move, Space toggle, Enter confirm)'),
    options: [
      {
        name: 'Solana Validator Operations',
        value: 'Solana Validator Operations',
        checked: isChecked('Solana Validator Operations', true),
      },
      {
        name: 'Index RPC Node Operations',
        value: 'Index RPC Node Operations',
        checked: isChecked('Index RPC Node Operations', false),
      },
      {
        name: 'gRPC Geyser Streaming',
        value: 'gRPC Geyser Streaming',
        checked: isChecked('gRPC Geyser Streaming', false),
      },
      {
        name: 'Benchmark & Connectivity Testing',
        value: 'Benchmark & Connectivity Testing',
        checked: isChecked('Benchmark & Connectivity Testing', false),
      },
      {
        name: 'Solana App Development (Trade Bot)',
        value: 'Solana App Development',
        checked: isChecked('Solana App Development', false),
      },
      {
        name: 'Server Procurement',
        value: 'Server Procurement',
        checked: isChecked('Server Procurement', false),
      },
    ],
  })

  // --- Deployment mode ---
  const deployMode = await Select.prompt({
    message: t('Deployment mode'),
    default: existing.deployMode,
    options: [
      { name: t('Local — deploy to this machine'), value: 'local' },
      { name: t('Remote — deploy to remote servers via SSH'), value: 'remote' },
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
- **Tina** — RPC / gRPC / cloud node specialist (slv-rpc + slv-grpc-geyser skills)
- **Cid** — Benchmark & connectivity testing specialist (grpc_test, geyserbench, shreds_test)
- **Setzer** — Solana App specialist (slv-app skill, trade bot creation)
- **Figaro** — Server procurement and validator hardware specialist (slv-server-procurement skill)

## Behavior
- Greet the user by their preferred name
- Analyze user requests and delegate to the appropriate sub-agent
- For validator tasks → delegate to Cecil
- For RPC, gRPC, and cloud node tasks → delegate to Tina
- For benchmark/connectivity test tasks → delegate to Cid
- For server availability, procurement, or validator hardware questions → delegate to Figaro
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
    colors.bold.rgb24(`\n│  ${t('GitHub Setup (optional)')}`, 0x14f195),
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
    console.log(colors.green(`  ✔ ${t('GitHub CLI already authenticated.')}\n`))
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
          `  ${t('GitHub CLI (gh) not found. Install it from https://cli.github.com/')}\n`,
          0x888888,
        ),
      )
      console.log(
        colors.rgb24(
          `  ${t('Skipped. You can set up GitHub later.')}\n`,
          0x888888,
        ),
      )
    } else {
      const setupGh = await Select.prompt({
        message: t(
          'Set up GitHub authentication? (enables repo creation, PRs, etc.)',
        ),
        options: [
          { name: t('Yes — run gh auth login'), value: 'yes' },
          { name: t('Skip for now'), value: 'skip' },
        ],
      })

      if (setupGh === 'yes') {
        console.log(colors.white(`\n  ${t('Running `gh auth login`...')}\n`))
        const proc = new Deno.Command('gh', {
          args: ['auth', 'login'],
          stdin: 'inherit',
          stdout: 'inherit',
          stderr: 'inherit',
        })
        const { success } = await proc.output()
        if (success) {
          console.log(colors.green(`\n  ✔ ${t('GitHub authenticated.')}\n`))
        } else {
          console.log(
            colors.yellow(
              `\n  ⚠ ${
                t('GitHub authentication failed. You can retry with `gh auth login`.')
              }\n`,
            ),
          )
        }
      } else {
        console.log(
          colors.rgb24(
            `  ${t('Skipped. You can run `gh auth login` later.')}\n`,
            0x888888,
          ),
        )
      }
    }
  }

  // --- Notifications (optional) ---
  console.log(
    colors.bold.rgb24(`\n│  ${t('Notifications (optional)')}`, 0x14f195),
  )

  const discordWebhook = await Input.prompt({
    message: t('Discord Webhook URL for notifications (Enter to skip)'),
    default: existing.discordWebhook ?? '',
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
    console.log(
      colors.green(`  ✔ ${t('Discord Webhook saved to ~/.slv/api.yml')}\n`),
    )
  } else {
    console.log(colors.rgb24(`  ${t('Skipped.')}\n`, 0x888888))
  }

  // Passwordless sudo for slv on a dev VPS. Skipped on macOS / non-
  // systemd hosts. The installer itself detects prior installs via a
  // magic marker in the drop-in file, so re-running `slv onboard`
  // after `sudo rm /etc/sudoers.d/slv-<user>` correctly re-offers.
  // We still record a timestamp for observability, but don't gate on it.
  if (await isSudoersTarget()) {
    const result = await promptAndInstallSudoers({ t })
    if (result.state === 'installed' || result.state === 'already_installed') {
      await writeSudoersInstalledAt(new Date().toISOString())
    } else if (result.state === 'foreign_file_exists') {
      console.log(
        colors.yellow(
          `  ⚠ ${
            t('Existing sudoers file at {path} was not installed by slv — leaving it alone.')
              .replace('{path}', result.path)
          }`,
        ),
      )
    } else if (result.state === 'failed') {
      console.log(
        colors.red(`  ❌ ${t('Sudoers install failed:')} ${result.err}`),
      )
      console.log(
        colors.white(
          `    ${
            t('You can continue without it; see the skill docs for manual setup.')
          }`,
        ),
      )
    }
  }

  console.log(
    colors.bold.rgb24('\n│', 0x14f195),
  )
  console.log(
    colors.green(`◇  ${t('Agent files saved to ~/.slv/agent/')}`),
  )
  console.log(
    colors.bold.rgb24('│', 0x14f195),
  )
  console.log(
    colors.white(`  ${t('Agent:')}    ${colors.bold(agentName)}`),
  )
  console.log(
    colors.green(`◇  ${t('AI configuration saved to ~/.slv/api.yml')}`),
  )
  console.log(
    colors.bold.rgb24('│', 0x14f195),
  )
  console.log(
    colors.rgb24(
      `└  ${t('Run `slv c` to start the AI console.')}\n`,
      0x14f195,
    ),
  )
}
