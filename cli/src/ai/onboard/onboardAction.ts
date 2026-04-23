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
import {
  getApiKeyFromYml,
  isValidApiKey,
  resolveHome,
} from '/lib/getApiKeyFromYml.ts'
import { Confirm } from '@cliffy/prompt'
import { installAction as installGatewayAction } from '/src/gateway/install.ts'
import { pickGatewayService } from '/src/gateway/service/pick.ts'
import { GATEWAY_DEFAULT_PORT } from '/src/gateway/paths.ts'
import { errToString } from '/lib/errToString.ts'
import {
  loadGatewayConfig,
  writeGatewayConfig,
} from '/src/gateway/config.ts'
import { notifyDiscordWebhook } from '/lib/notifyDiscordWebhook.ts'
import {
  ERPC_DASHBOARD_URL,
  getDnsStatus,
  openSupportTicket,
} from '/lib/slvCloudMcp.ts'
import { resolvePublicIp } from '/lib/publicIp.ts'
import { runNginxFlow } from '/src/install/nginxFlow.ts'

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

  // --- Notifications (optional) ---
  console.log(
    colors.bold.rgb24(`\n│  ${t('Notifications (optional)')}`, 0x14f195),
  )
  // Non-engineers rarely know how to create a Discord webhook, so
  // link a 30-second video walkthrough before the prompt. The URL
  // lives in the translation key so alt-language versions can swap
  // to a localized recording later if one exists.
  console.log(
    colors.white(
      `  ${
        t(
          'How to create a Discord webhook (30-sec video): https://youtube.com/shorts/2w-Afr_JVEg',
        )
      }`,
    ),
  )
  console.log(
    colors.rgb24(
      `  ${t('Paste the webhook URL below, or press Enter to skip.')}`,
      0x888888,
    ),
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

  // --- Gateway daemon (optional) ---
  // Installs a user-level systemd/launchd service that exposes the
  // browser chat UI at http://127.0.0.1:20026/ui/. Non-engineers
  // don't know they can run this manually afterwards, so offer it
  // here while we already have their attention. Idempotent: if the
  // service is already installed/running, we say so and continue.
  const gatewayResult = await maybeInstallGateway(t)

  // Access path — try HTTPS first, fall back to LAN mode only if
  // HTTPS was declined or couldn't be set up. Order matters: with
  // HTTPS the gateway stays safely on loopback and nginx handles
  // the external side; offering LAN mode after HTTPS succeeded
  // would just confuse the user with an unneeded 0.0.0.0 bind.
  let httpsUrl: string | null = null
  let accessMode: 'local' | 'lan' = gatewayResult.mode
  if (gatewayResult.gatewayReachable) {
    httpsUrl = await maybeSetupHttps(t)
    if (!httpsUrl) {
      accessMode = await maybeEnableLanMode(t)
    }
  }

  // If the gateway is up AND the user set a Discord webhook, send
  // them the browser-chat URL + token there so they don't have to
  // hunt for it — the "last-mile" signal that makes non-engineers
  // actually use the UI. Prefers the HTTPS URL if we set one up.
  if (gatewayResult.gatewayReachable) {
    await sendOnboardWebhook({
      t,
      agentHome,
      mode: accessMode,
      httpsUrl,
    })
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

type GatewayResult = {
  gatewayReachable: boolean
  mode: 'local' | 'lan'
}

/**
 * Install + start the gateway daemon, then optionally flip to lan
 * mode for remote-browser access with a WireGuard security advisory.
 * Idempotent — probes status() first so re-running onboard on an
 * already-configured host is a no-op with a ✔ message.
 *
 * All failures are non-fatal. Returns the current gateway state so
 * the caller can decide whether to send a Discord completion ping.
 */
const maybeInstallGateway = async (
  t: (key: string) => string,
): Promise<GatewayResult> => {
  console.log(
    colors.bold.rgb24(`\n│  ${t('Browser chat UI')}`, 0x14f195),
  )
  console.log(
    colors.white(
      `  ${
        t(
          'Installing the background service so you can chat with SLV from any browser at http://127.0.0.1:{port}/ui/ without keeping a terminal open.',
        ).replace('{port}', String(GATEWAY_DEFAULT_PORT))
      }`,
    ),
  )

  let service
  try {
    service = pickGatewayService()
  } catch {
    console.log(
      colors.rgb24(
        `  ${t('Not supported on this platform — skipped.')}\n`,
        0x888888,
      ),
    )
    return { gatewayReachable: false, mode: 'local' }
  }

  let status
  try {
    status = await service.status()
  } catch (err) {
    console.log(
      colors.yellow(
        `  ⚠ ${t('Could not probe gateway status:')} ${errToString(err)}`,
      ),
    )
    return { gatewayReachable: false, mode: 'local' }
  }

  // Auto-install: no Confirm. Onboard explicitly assumes the user
  // wants the browser UI — skipping would leave them stranded.
  // Platform gate + idempotent status probe above means this is
  // safe to run every time.
  if (!status.running) {
    if (!status.loaded) {
      const installed = await installGatewayAction()
      if (!installed) {
        console.log(
          colors.yellow(
            `  ⚠ ${
              t('Gateway install failed — run `slv gateway install` manually to retry.')
            }\n`,
          ),
        )
        return { gatewayReachable: false, mode: 'local' }
      }
    } else {
      console.log(
        colors.gray(
          `  ${t('Service unit already installed — starting it.')}`,
        ),
      )
    }

    try {
      await service.start()
    } catch (err) {
      console.log(
        colors.yellow(
          `  ⚠ ${t('Gateway start failed:')} ${errToString(err)}`,
        ),
      )
      console.log(
        colors.white(
          `    ${t('Run `slv gateway start` manually to retry.')}\n`,
        ),
      )
      return { gatewayReachable: false, mode: 'local' }
    }
  } else {
    console.log(
      colors.green(
        `  ✔ ${t('Gateway is already running.')}`,
      ),
    )
  }

  // Mode-switching used to live here; it's now split into two
  // explicit sections further up the onboard flow:
  //   1. `maybeSetupHttps` offers the Cloudflare-fronted HTTPS
  //      URL (preferred path — no LAN exposure required).
  //   2. `maybeEnableLanMode` is only asked when HTTPS was
  //      skipped, so users don't get badgered about opening 0.0.0.0
  //      when nginx is going to handle remote access anyway.
  const finalMode = await readCurrentGatewayMode()

  console.log(
    colors.green(
      `  ✔ ${
        t('Gateway running at http://127.0.0.1:{port}/ui/').replace(
          '{port}',
          String(GATEWAY_DEFAULT_PORT),
        )
      }\n`,
    ),
  )
  return { gatewayReachable: true, mode: finalMode }
}

/**
 * Read the gateway's current bind mode from ~/.slv/gateway/gateway.json.
 * Defaults to 'local' if the config doesn't exist yet — matches what
 * the gateway itself does on first run.
 */
const readCurrentGatewayMode = async (): Promise<'local' | 'lan'> => {
  try {
    const cfg = await loadGatewayConfig()
    return cfg.mode
  } catch {
    return 'local'
  }
}

/**
 * Determine the host URL a Discord reader on a different device
 * would actually hit. For lan mode we try to discover the public IP
 * (api.ipify.org → fallback to `hostname -I`). For local mode we
 * just say 127.0.0.1 plus an SSH-tunnel hint. Returns null on
 * unexpected failure so the caller can skip the notification
 * gracefully.
 */
const resolveBrowserUrl = async (
  mode: 'local' | 'lan',
): Promise<{ host: string; externallyReachable: boolean }> => {
  if (mode === 'local') return { host: '127.0.0.1', externallyReachable: false }
  // Try ipify first — the VPS almost always has direct outbound and
  // ipify returns the actual public IP even from behind NAT.
  try {
    const controller = new AbortController()
    const tid = setTimeout(() => controller.abort(), 3000)
    const res = await fetch('https://api.ipify.org', {
      signal: controller.signal,
    })
    clearTimeout(tid)
    if (res.ok) {
      const ip = (await res.text()).trim()
      if (/^[0-9a-fA-F.:]+$/.test(ip)) {
        return { host: ip, externallyReachable: true }
      }
    }
  } catch { /* try the local fallback */ }
  // Fallback: first address from `hostname -I` (Linux only). Good for
  // LAN-only deployments where ipify isn't reachable.
  try {
    const p = new Deno.Command('hostname', {
      args: ['-I'],
      stdout: 'piped',
      stderr: 'null',
    })
    const { stdout, success } = await p.output()
    if (success) {
      const first = new TextDecoder().decode(stdout).trim().split(/\s+/)[0]
      if (first && /^[0-9a-fA-F.:]+$/.test(first)) {
        return { host: first, externallyReachable: true }
      }
    }
  } catch { /* fall through */ }
  // Last resort: the literal hostname. Useful on hosts with DNS.
  try {
    return { host: Deno.hostname(), externallyReachable: true }
  } catch {
    return { host: '127.0.0.1', externallyReachable: false }
  }
}

/**
 * Offer lan mode — only called as a fallback when HTTPS has
 * already been offered and declined (or couldn't be set up). If
 * HTTPS is configured, the gateway should stay on loopback; nginx
 * handles the public-facing side.
 *
 * Returns the mode the gateway ended up in. Non-fatal on error.
 */
const maybeEnableLanMode = async (
  t: (key: string) => string,
): Promise<'local' | 'lan'> => {
  const currentMode = await readCurrentGatewayMode()
  if (currentMode === 'lan') return 'lan'
  let service
  try {
    service = pickGatewayService()
  } catch {
    return currentMode
  }

  console.log(
    colors.bold.yellow(
      `\n  ${t('Enable remote IP access (recommended for VPS)?')}`,
    ),
  )
  console.log(
    colors.white(
      `    ${
        t(
          'Binds the gateway to 0.0.0.0 so you can open http://<server-ip>:{port}/ui/ directly from your phone/laptop. Token auth still gates every chat action.',
        ).replace('{port}', String(GATEWAY_DEFAULT_PORT))
      }`,
    ),
  )
  console.log(
    colors.bold.rgb24(
      `    ⚠ ${
        t(
          'Next step: once onboard finishes, run `slv c` and ask SLV AI to help you set up the firewall (nftables) and WireGuard (with the app on your phone). Video walkthrough: coming soon.',
        )
      }`,
      0xffdf7a,
    ),
  )
  const enableLan = await Confirm.prompt({
    message: t('Enable remote IP access now?'),
    default: true,
  })
  if (!enableLan) {
    console.log(
      colors.rgb24(
        `  ${
          t(
            'Kept loopback-only. Run `slv gateway config set-mode lan` later to enable remote access.',
          )
        }\n`,
        0x888888,
      ),
    )
    return 'local'
  }
  try {
    const cfg = await loadGatewayConfig()
    await writeGatewayConfig({ ...cfg, mode: 'lan' })
    await service.restart()
    console.log(
      colors.green(
        `  ✔ ${t('Remote IP access enabled — gateway restarted.')}\n`,
      ),
    )
    return 'lan'
  } catch (err) {
    console.log(
      colors.yellow(
        `  ⚠ ${t('Failed to enable remote IP access:')} ${errToString(err)}`,
      ),
    )
    return 'local'
  }
}

/**
 * Post a completion message to the user's Discord webhook with the
 * browser chat URL + token + (for lan mode) a WireGuard hardening
 * reminder. All in the language the user picked at step 1. Silent
 * no-op when no webhook is configured or the gateway token isn't
 * readable — this runs at the tail of onboard and must not fail the
 * overall flow.
 */
const sendOnboardWebhook = async (opts: {
  t: (key: string) => string
  agentHome: string
  mode: 'local' | 'lan'
  /**
   * URL to show in the Discord message. When the onboard HTTPS
   * step registered the user's erpc.global subdomain and stood
   * up nginx, this is the Cloudflare-fronted `https://<slug>/`
   * so the user can click straight through from mobile. Null
   * falls back to the bare `http://<ip>:20026/` derived from
   * the gateway mode (lan → public IP, local → loopback+SSH).
   */
  httpsUrl: string | null
}): Promise<void> => {
  const { t, agentHome, mode, httpsUrl } = opts
  const apiYmlPath = `${agentHome}/.slv/api.yml`

  // Resolve webhook + token. Missing either means quiet skip — the
  // user either didn't set up notifications or deferred the gateway.
  let webhookUrl = ''
  try {
    const raw = await Deno.readTextFile(apiYmlPath)
    const parsed = parse(raw) as Record<string, unknown> | null
    const n = parsed?.notifications as { discord_webhook?: string } | undefined
    if (n?.discord_webhook) webhookUrl = n.discord_webhook.trim()
  } catch { /* no api.yml yet */ }
  if (!webhookUrl) return

  let token = ''
  try {
    const cfg = await loadGatewayConfig()
    token = cfg.token
  } catch { /* gateway not configured */ }
  if (!token) return

  // If the onboard HTTPS step succeeded, use the Cloudflare-
  // fronted URL verbatim — the user can click it from their
  // phone without worrying about SSH tunnels or WireGuard. If
  // the HTTPS step was skipped or failed, fall back to the bare
  // IP-based URL we had before, with mode-specific guidance
  // printed below.
  let url: string
  if (httpsUrl) {
    url = httpsUrl.endsWith('/ui/')
      ? httpsUrl
      : `${httpsUrl.replace(/\/$/, '')}/ui/`
  } else {
    const resolved = await resolveBrowserUrl(mode)
    url = `http://${resolved.host}:${GATEWAY_DEFAULT_PORT}/ui/`
  }

  const lines: string[] = []
  lines.push(`🎉 ${t('SLV AI setup complete!')}`)
  lines.push('')
  lines.push(`📱 ${t('Open SLV in your browser:')}`)
  lines.push(url)
  lines.push('')
  lines.push(`🔑 ${t('Gateway token (paste on first visit):')}`)
  lines.push('```')
  lines.push(token)
  lines.push('```')
  // Local mode needs an SSH tunnel to reach 127.0.0.1 from another
  // device — but only when there's no Cloudflare-fronted URL
  // already. The HTTPS path turns the local-mode gateway into a
  // remotely-clickable URL, so printing the SSH tunnel here would
  // just confuse the user.
  if (mode === 'local' && !httpsUrl) {
    lines.push('')
    lines.push(
      `ℹ️ ${
        t('Loopback-only mode — open the URL from elsewhere via SSH tunnel first:')
      }`,
    )
    lines.push('```')
    lines.push(
      `ssh -N -L ${GATEWAY_DEFAULT_PORT}:127.0.0.1:${GATEWAY_DEFAULT_PORT} <user>@<host>`,
    )
    lines.push('```')
  }
  // Hardening advisory — frame as something the user does INSIDE
  // the chat window they just got the link to. They're reading
  // this on their phone; telling them to "open a terminal and run
  // `slv c`" on the VPS defeats the whole purpose. Instead: "tap
  // the URL above, chat with SLV AI there, and it will walk you
  // through nftables + WireGuard."
  lines.push('')
  lines.push(
    `⚠️ ${
      t('Security: tap the URL above to open SLV AI in your browser, and ask it to help you set up the firewall (nftables) and WireGuard (with the app on your phone). The conversation happens right there — no terminal needed.')
    }`,
  )
  lines.push(`• ${t('Video walkthrough: coming soon.')}`)
  // If the user's VPS isn't an SLV VPS/BareMetal (http fallback),
  // the security advisory above is especially important AND they
  // should upgrade to get HTTPS. Point at the dashboard for
  // provisioning.
  if (!httpsUrl) {
    lines.push('')
    lines.push(
      `🏷 ${
        t('For automatic HTTPS + a free *.erpc.global subdomain, run SLV on an SLV VPS or BareMetal (provision via the dashboard):')
      }`,
    )
    lines.push(ERPC_DASHBOARD_URL)
  }

  const result = await notifyDiscordWebhook(webhookUrl, lines.join('\n'))
  switch (result.kind) {
    case 'ok':
      console.log(
        colors.green(
          `  ✔ ${t('Sent browser UI link to your Discord webhook.')}\n`,
        ),
      )
      return
    case 'http_error':
      console.log(
        colors.yellow(
          `  ⚠ ${t('Discord webhook post returned')} ${result.status}. ${
            t('Check the webhook URL in ~/.slv/api.yml.')
          }\n`,
        ),
      )
      return
    case 'network_error':
      console.log(
        colors.yellow(
          `  ⚠ ${t('Could not reach Discord webhook:')} ${result.message}\n`,
        ),
      )
      return
    case 'skipped_empty_url':
      return
  }
}

/**
 * Offer the Cloudflare-fronted HTTPS path: register the user's
 * free `<slug>.erpc.global` subdomain against this VPS and put
 * nginx in front of the gateway on port 80. Result: a clickable
 * `https://u-xxx.erpc.global/ui/` URL in the Discord completion
 * message that works from any phone/laptop with no SSH tunnel.
 *
 * Skipped silently when:
 *   - no SLV API key is configured (user still needs `slv login`)
 *   - we can't read DNS status (offline / API down)
 *   - the user's default slug is already set to an IP we can't
 *     confirm (we leave whatever they have alone rather than
 *     re-pointing without consent)
 *   - running on non-Linux (apt-based install only)
 *   - the user declines the Confirm prompt
 *
 * Returns the `https://...` URL on success so
 * `sendOnboardWebhook` can put it in the Discord message;
 * returns null on any skip-or-fail (always non-fatal — the user
 * can re-run `slv install nginx` manually).
 */
const maybeSetupHttps = async (
  t: (key: string) => string,
): Promise<string | null> => {
  // Platform gate — nginx-via-apt is Ubuntu/Debian-only. Silent
  // skip here is fine; macOS / BSD users aren't missing anything
  // they'd expect from this onboard step.
  if (Deno.build.os !== 'linux') return null

  // Always show the section header — even when we skip, the user
  // should see this path exists (and what to do to enable it
  // later). The previous silent-skip-on-missing-key made users
  // think the HTTPS feature didn't exist at all.
  console.log(
    colors.bold.rgb24(`\n│  ${t('Public HTTPS URL (optional)')}`, 0x14f195),
  )

  // FIX 1: re-read api.yml fresh (getApiKeyFromYml already bypasses
  // any cache). If it's still missing after the onboard SLV-key
  // step, offer to paste one now so HTTPS isn't blocked on a
  // single skipped prompt earlier in the flow.
  let apiKey = await readSlvKeyOrEmpty()
  if (!apiKey) {
    console.log(
      colors.white(
        `  ${
          t('An SLV API key lets us point your free erpc.global subdomain at this VPS for instant HTTPS.')
        }`,
      ),
    )
    const pasted = (await Secret.prompt({
      message: t('🔑 Paste your SLV API key here (Enter to skip HTTPS):'),
    })).trim()
    if (!pasted) {
      console.log(
        colors.rgb24(
          `  ${
            t('Skipped. Run `slv login` then `slv install nginx` later to enable HTTPS.')
          }\n`,
          0x888888,
        ),
      )
      return null
    }
    await persistSlvKey(pasted)
    apiKey = pasted
  }

  // Pre-flight DNS status check.
  const status = await getDnsStatus(apiKey)
  if (!status.ok) {
    console.log(
      colors.yellow(
        `  ⚠ ${
          t('Could not read DNS status — run `slv install nginx` later to retry.')
        }\n`,
      ),
    )
    return null
  }
  const def = status.data.default
  const fqdn = def.fqdn

  // FIX 4: detect existing-slug conflict. If the user's default
  // subdomain already points somewhere OTHER than this host, a
  // `/v3/dns/set` here would hijack their other VPS's URL —
  // exactly what we don't want. Branch into the 2nd-subdomain /
  // support-ticket flow.
  const thisHostIp = await resolvePublicIp()
  if (
    def.exists && def.ip &&
    thisHostIp && def.ip !== thisHostIp
  ) {
    return await handleSubdomainConflict(t, apiKey, fqdn, def.ip, thisHostIp)
  }

  console.log(
    colors.white(
      `  ${
        t('Point your free subdomain {fqdn} at this VPS and install nginx so SLV AI is reachable over HTTPS from your phone — no cert setup needed (Cloudflare handles TLS).')
          .replace('{fqdn}', fqdn)
      }`,
    ),
  )

  const ok = await Confirm.prompt({
    message: t('Set up HTTPS now?'),
    default: true,
  })
  if (!ok) {
    console.log(
      colors.rgb24(
        `  ${t('Skipped. Run `slv install nginx` later to enable HTTPS.')}\n`,
        0x888888,
      ),
    )
    return null
  }

  console.log(colors.cyan(`🌐 Registering ${fqdn} + installing nginx...`))
  const result = await runNginxFlow({
    apiKey,
    port: GATEWAY_DEFAULT_PORT,
    ip: thisHostIp ?? undefined,
  })
  if (!result.ok) {
    // FIX 3: ip_not_owned means the VPS isn't an SLV VPS/BareMetal.
    // Falling back to http://<ip>:20026 is unencrypted and exposed;
    // we print a loud warning + direct the user at Figaro (the
    // server-procurement specialist in `slv c`) for a proper
    // upgrade path, rather than pretending the http URL is fine.
    if (result.stage === 'dns_set' && result.error.includes('not registered')) {
      console.log(
        colors.bold.red(
          `\n  ${t('⚠ This VPS is NOT an SLV VPS / BareMetal.')}`,
        ),
      )
      console.log(
        colors.bold.yellow(
          `  ${
            t(
              'Falling back to plain HTTP (http://<ip>:20026/) — not encrypted. Treat this as dev-only. For production, provision an SLV VPS or BareMetal from the dashboard below; its IP gets registered automatically and HTTPS works on the next `slv install nginx`.',
            )
          }`,
        ),
      )
      console.log(
        colors.bold.white(`  👉  ${ERPC_DASHBOARD_URL}\n`),
      )
    } else {
      console.log(
        colors.yellow(
          `  ⚠ ${t('HTTPS setup failed ({stage}): {err}')}`
            .replace('{stage}', result.stage)
            .replace('{err}', result.error),
        ),
      )
      console.log(
        colors.white(
          `    ${t('You can retry later with `slv install nginx`.')}\n`,
        ),
      )
    }
    return null
  }
  console.log(
    colors.green(
      `  ✔ ${t('HTTPS is live at {url}').replace('{url}', result.httpsUrl)}\n`,
    ),
  )
  return result.httpsUrl
}

/**
 * Read the SLV API key from ~/.slv/api.yml without erroring out
 * when absent — the HTTPS step treats "missing" as a prompt trigger,
 * not a fatal.
 */
const readSlvKeyOrEmpty = async (): Promise<string> => {
  try {
    const k = await getApiKeyFromYml(true)
    return k ?? ''
  } catch {
    return ''
  }
}

/**
 * Write a pasted SLV API key back into ~/.slv/api.yml, preserving
 * whatever other fields (lang, notifications, ai, …) were already
 * there. Mirror of the write in the SLV-key onboard step.
 */
const persistSlvKey = async (apiKey: string): Promise<void> => {
  const home = resolveHome()
  const apiYmlPath = `${home}/.slv/api.yml`
  await Deno.mkdir(`${home}/.slv`, { recursive: true })
  let existing: Record<string, unknown> = {}
  try {
    const content = await Deno.readTextFile(apiYmlPath)
    existing = (parse(content) as Record<string, unknown>) ?? {}
  } catch { /* file doesn't exist yet */ }
  const slv = (existing.slv as Record<string, unknown> | undefined) ?? {}
  slv.api_key = apiKey
  existing.slv = slv
  await Deno.writeTextFile(apiYmlPath, stringify(existing))
  await Deno.chmod(apiYmlPath, 0o600)
}

/**
 * The user's free default subdomain is already pointing somewhere
 * else — typically an earlier SLV VPS they've already onboarded.
 * Overwriting it here would break the old host's URL, so give the
 * user three explicit options and take their pick.
 */
const handleSubdomainConflict = async (
  t: (key: string) => string,
  apiKey: string,
  fqdn: string,
  currentIp: string,
  thisHostIp: string,
): Promise<string | null> => {
  console.log(
    colors.bold.yellow(
      `  ${
        t('⚠ Your free subdomain {fqdn} is already pointing at {ip}.')
          .replace('{fqdn}', fqdn)
          .replace('{ip}', currentIp)
      }`,
    ),
  )
  console.log(
    colors.white(
      `  ${
        t('Re-pointing it here would break the other host. Each SLV account gets exactly one free subdomain; a second one requires the paid tier (coming soon) or a support ticket for edge cases.')
      }\n`,
    ),
  )

  const choice = await Select.prompt({
    message: t('What would you like to do?'),
    options: [
      {
        name: t('Skip HTTPS for this VPS — leave the existing subdomain alone'),
        value: 'skip',
      },
      {
        name: t('Create a support ticket to request a 2nd subdomain'),
        value: 'ticket',
      },
      {
        name: t(
          'Re-point anyway (breaks the other VPS — only choose if you know what you\'re doing)',
        ),
        value: 'repoint',
      },
    ],
    default: 'skip',
  })

  if (choice === 'skip') {
    console.log(
      colors.rgb24(
        `  ${t('Kept existing subdomain. You can run `slv install nginx` on the other VPS to reclaim if needed.')}\n`,
        0x888888,
      ),
    )
    return null
  }

  if (choice === 'ticket') {
    console.log(colors.cyan(`  ${t('Creating support ticket...')}`))
    const description =
      `Request: 2nd erpc.global subdomain\n\n` +
      `Current free subdomain: ${fqdn} → ${currentIp}\n` +
      `This new VPS IP: ${thisHostIp}\n` +
      `Use case: user is onboarding a second SLV host and wants an additional subdomain for it.`
    const ticket = await openSupportTicket(apiKey, {
      title: `Request 2nd erpc.global subdomain for ${thisHostIp}`,
      description,
    })
    if (!ticket.ok) {
      console.log(
        colors.yellow(
          `  ⚠ ${t('Ticket creation failed: {err}')}`
            .replace('{err}', ticket.error),
        ),
      )
      return null
    }
    console.log(
      colors.green(
        `  ✔ ${t('Ticket opened. Follow up here:')} ${ticket.link || '(see Discord notifications)'}\n`,
      ),
    )
    return null
  }

  // choice === 'repoint' — run the normal flow; the caller will
  // overwrite the old record.
  console.log(colors.cyan(`🌐 Re-pointing ${fqdn} at ${thisHostIp}...`))
  const result = await runNginxFlow({
    apiKey,
    port: GATEWAY_DEFAULT_PORT,
    ip: thisHostIp,
  })
  if (!result.ok) {
    console.log(
      colors.yellow(
        `  ⚠ ${t('HTTPS setup failed ({stage}): {err}')}`
          .replace('{stage}', result.stage)
          .replace('{err}', result.error),
      ),
    )
    return null
  }
  console.log(
    colors.green(
      `  ✔ ${t('HTTPS is live at {url}').replace('{url}', result.httpsUrl)}\n`,
    ),
  )
  return result.httpsUrl
}
