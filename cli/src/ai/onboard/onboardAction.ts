import { Input, Select } from '@cliffy/prompt'
import { colors } from '@cliffy/colors'
import { parse, stringify } from '@std/yaml'
import denoJson from '/deno.json' with { type: 'json' }
import {
  // ANTHROPIC_MODELS and OPENAI_MODELS available via manual ~/.slv/api.yml config
  hasLangSet,
  readAiConfig,
  readLang,
  writeAiConfig,
  writeLang,
  writeSudoersInstalledAt,
} from '@/ai/config.ts'
import {
  isSudoersTarget,
  promptAndInstallSudoers,
} from '@/ai/onboard/installSudoers.ts'
import { BUILTIN_LANGS, reloadI18n, t } from '@/ai/i18n/index.ts'
import {
  findUserApiAuth,
  isValidApiKey,
  mergeSlvCredentials,
  resolveHome,
} from '/lib/getApiKeyFromYml.ts'
import { AUTO_EXECUTE_NOTE } from '@/ai/console/keyMaterial.ts'
import { runDeviceLogin } from '@/login/index.ts'
import { Confirm } from '@cliffy/prompt'
import { ensureGatewayRunning } from '/src/gateway/ensureRunning.ts'
import { pickGatewayService } from '/src/gateway/service/pick.ts'
import { GATEWAY_DEFAULT_PORT } from '/src/gateway/paths.ts'
import { errToString } from '/lib/errToString.ts'
import { loadGatewayConfig, writeGatewayConfig } from '/src/gateway/config.ts'
import { notifyDiscordWebhook } from '/lib/notifyDiscordWebhook.ts'
import { ERPC_DASHBOARD_URL } from '@cmn/constants/url.ts'
import { getDnsStatus } from '/lib/userApi/dns.ts'
import { openSupportTicket } from '/lib/userApi/support.ts'
import { type UserApiAuth, userApiAuthFromSession } from '/lib/userApi/auth.ts'
import {
  hasStoredLogin,
  readSlvSection,
  updateApiYml,
} from '/lib/userApi/session.ts'
import { resolvePublicIp } from '/lib/publicIp.ts'
import { loadOnboardConfig, type OnboardConfig } from '@/ai/onboard/config.ts'
import { checkOnboardReadiness } from '@/ai/onboard/readiness.ts'
import { ensureProfileFile } from '@/ai/onboard/profileFiles.ts'
import { invalidateAgentContext } from '@/ai/agentConfig/loader.ts'
import {
  parseAgentProfile,
  parseUserProfile,
} from '@/ai/agentConfig/markdown.ts'

/**
 * Module-scoped config for the current onboard run. Set once at the
 * top of `onboardAction` from `--config <path>`; every prompt site
 * checks it first via the helpers below. Safe to leave at
 * module-scope because slv onboard is a single-user,
 * single-invocation CLI command — there's no concurrency to race.
 */
let currentCfg: OnboardConfig = {}

/**
 * True when the answers come from `--config <path>` (for example from
 * cloud-init). Such a run never starts a browser sign-in: nobody is there to
 * finish it, and the run would wait for up to 15 minutes.
 */
let fromConfigFile = false

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
  printWrapped(
    t('Security warning — please read.'),
    (s) => colors.bold.white(s),
  )
  console.log(line(''))
  printWrapped(
    t('SLV AI Console can execute commands on your system.'),
    (s) => colors.white(s),
  )
  printWrapped(
    t('A bad prompt can trick it into doing unsafe things.'),
    (s) => colors.white(s),
  )
  printWrapped(AUTO_EXECUTE_NOTE, (s) => colors.white(s))
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
  agentConfig?: Record<string, unknown>
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
    const profile = parseUserProfile(userMd)
    defaults.userName = profile.name
    defaults.callMe = profile.preferredName
  } catch { /* no USER.md */ }

  try {
    const soulMd = await Deno.readTextFile(`${agentDir}/SOUL.md`)
    defaults.agentName = parseAgentProfile(soulMd).name
  } catch { /* no SOUL.md */ }

  try {
    const raw = await Deno.readTextFile(`${agentDir}/config.yml`)
    const cfg = parse(raw)
    if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) {
      throw new Error(
        'Agent config must be a YAML mapping; it was left unchanged.',
      )
    }
    const config = cfg as Record<string, unknown>
    defaults.agentConfig = config
    if (config.mode === 'local' || config.mode === 'remote') {
      defaults.deployMode = config.mode
    }
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error
  }

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

export type OnboardResult = { ready: boolean; cancelled?: boolean }

export const onboardAction = async (
  opts: { configPath?: string; advanced?: boolean } = {},
): Promise<OnboardResult> => {
  currentCfg = opts.configPath ? await loadOnboardConfig(opts.configPath) : {}
  fromConfigFile = Boolean(opts.configPath)
  const advanced = opts.advanced === true
  const home = resolveHome()
  const existing = await loadExistingDefaults(home)

  // Language changes take effect in this invocation; no restart is needed.
  if (currentCfg.lang !== undefined || !(await hasLangSet()) || advanced) {
    let language = currentCfg.lang
    if (language === undefined) {
      const saved = await readLang()
      const locale =
        (Deno.env.get('LC_ALL') || Deno.env.get('LANG') || '').split(/[_.-]/)[0]
      const suggested = await hasLangSet()
        ? saved
        : (BUILTIN_LANGS[locale] ? locale : 'en')
      language = await Select.prompt({
        message: 'Language / 言語',
        options: [
          { name: 'English', value: 'en' },
          { name: '日本語', value: 'ja' },
          { name: '中文', value: 'zh' },
          { name: 'Русский', value: 'ru' },
          { name: 'Tiếng Việt', value: 'vi' },
          { name: 'Other', value: '__other__' },
        ],
        default: BUILTIN_LANGS[suggested] ? suggested : '__other__',
      })
      if (language === '__other__') {
        language = (await Input.prompt({
          message: 'Your language',
          default: saved,
          validate: (v) => v.trim().length > 0 || 'Language is required',
        })).trim()
      }
    }
    await writeLang(language)
  }
  await reloadI18n()
  console.log(colors.bold.rgb24(`\nSLV  ${denoJson.version}`, 0x14f195))
  console.log(t('Build and operate Solana, through conversation.'))
  console.log(
    colors.green(`\n[1/3] ${t('Language ready')}: ${await readLang()}`),
  )
  console.log(
    t('SLV AI uses a cloud AI service. Commands that change your environment require confirmation.'),
  )
  console.log(t('Keep private keys and passwords out of the conversation.'))
  if (advanced) printSecurityWarning()

  const accepted = currentCfg.security_warning_accepted ??
    (existing.agentConfig?.onboard_version === 2 ? true : await Confirm.prompt({
      message: t('Continue with guided setup?'),
      default: true,
    }))
  if (!accepted) {
    console.log(t('Setup cancelled.'))
    return { ready: false, cancelled: true }
  }

  console.log(
    colors.bold.rgb24(`\n[2/3] ${t('Connect your account')}`, 0x14f195),
  )
  const configApiKey = currentCfg.slv_api_key?.trim()
  if (configApiKey && isValidApiKey(configApiKey)) {
    await mergeSlvCredentials({ api_key: configApiKey }, home)
  }
  const previousAi = await readAiConfig()
  const aiConfig = previousAi ??
    { provider: 'slv' as const, api_key: '', model: 'SLV AI' }
  // Refresh while checking readiness so a temporary OAuth outage is reported
  // accurately instead of being treated as a missing login.
  let auth = aiConfig.provider === 'slv' &&
      hasStoredLogin(await readSlvSection(home))
    ? userApiAuthFromSession(home)
    : null
  let accountName: string | undefined
  if (aiConfig.provider === 'slv' && !auth && !fromConfigFile) {
    const signIn = await Confirm.prompt({
      message: t('Sign in to ERPC now?'),
      default: true,
    })
    if (signIn) {
      const result = await runDeviceLogin()
      if (result.ok) {
        accountName = result.username ?? undefined
        auth = await findUserApiAuth(home)
        if (!BUILTIN_LANGS[await readLang()]) await reloadI18n()
      } else {
        for (const line of result.lines) console.log(colors.yellow(line))
      }
    }
  }
  await writeAiConfig(aiConfig)

  let ready = aiConfig.provider !== 'slv' && aiConfig.api_key.trim().length > 0
  if (auth) {
    const check = await checkOnboardReadiness(auth)
    if (check.kind === 'ready') {
      ready = true
      console.log(
        colors.green(
          `  ✔ ${
            t('ERPC connected. AI balance: {count} tokens.').replace(
              '{count}',
              check.remainingTokens.toLocaleString(),
            )
          }`,
        ),
      )
    } else if (check.kind === 'empty') {
      console.log(
        colors.yellow(
          t('ERPC connected, but no AI tokens are available. Run `slv ai product` to review your options.'),
        ),
      )
    } else if (check.kind === 'activation_required') {
      console.log(colors.yellow(
        t('Complete account activation in the ERPC dashboard before using SLV AI.'),
      ))
      console.log(ERPC_DASHBOARD_URL)
    } else {
      console.log(
        colors.yellow(
          t('Could not verify your account is ready for AI. Your settings will be saved.'),
        ),
      )
      console.log(colors.yellow(`  ${check.message}`))
    }
  } else if (aiConfig.provider === 'slv') {
    console.log(
      colors.yellow(
        t('Settings can be saved now. Run `slv login` before starting SLV AI.'),
      ),
    )
  } else {
    console.log(
      t('Keeping your existing AI provider: {provider}.').replace(
        '{provider}',
        aiConfig.provider,
      ),
    )
  }

  // Quick setup supplies useful defaults. Personalization stays optional.
  const defaultName = existing.userName ?? accountName ??
    Deno.env.get('USER') ?? 'You'
  const userName = currentCfg.user_name ??
    (advanced
      ? await Input.prompt({ message: t('Your name'), default: defaultName })
      : defaultName)
  const callMe = currentCfg.call_me_name ??
    (advanced
      ? await Input.prompt({
        message: t('What should the AI call you?'),
        default: existing.callMe ?? userName,
      })
      : existing.callMe ?? userName)
  const agentName = currentCfg.agent_name ??
    (advanced
      ? await Input.prompt({
        message: t('Name your main AI agent'),
        default: existing.agentName ?? 'SLV',
      })
      : existing.agentName ?? 'SLV')
  const deployMode = currentCfg.deploy_mode ?? (advanced
    ? await Select.prompt({
      message: t('Deployment mode'),
      default: existing.deployMode ?? 'remote',
      options: [
        {
          name: t('Remote — deploy to remote servers via SSH'),
          value: 'remote',
        },
        { name: t('Local — deploy to this machine'), value: 'local' },
      ],
    })
    : existing.deployMode ?? 'remote')
  const agentDir = `${home}/.slv/agent`
  await Deno.mkdir(agentDir, { recursive: true })
  const userFields: Record<string, string> = {}
  if (
    currentCfg.user_name !== undefined ||
    (advanced && userName !== existing.userName)
  ) userFields.name = userName
  if (
    currentCfg.call_me_name !== undefined ||
    (advanced && callMe !== existing.callMe)
  ) userFields.preferred_name = callMe
  await ensureProfileFile(
    `${agentDir}/USER.md`,
    `# USER.md\n- **Name:** ${userName}\n- **Call me:** ${callMe}\n`,
    userFields,
  )
  const soul = `# SOUL.md — Main Agent
- **Name:** ${agentName}
- **Role:** SLV assistant — helps with Solana and routes tasks to specialists

## Specialists
- Cecil — Solana validators
- Tina — RPC and gRPC
- Cid — benchmarks and connectivity
- Setzer — Solana applications
- Figaro — server resources

## Behavior
- Use the user's preferred name and language.
- Follow the current request; available skills do not define the user's intent.
- Ask for the target machine before deployment. Do not assume this machine is the target.
- Explain the result and the next useful step.
`
  await ensureProfileFile(
    `${agentDir}/SOUL.md`,
    soul,
    currentCfg.agent_name !== undefined ||
      (advanced && agentName !== existing.agentName)
      ? { name: agentName }
      : undefined,
  )
  await ensureProfileFile(
    `${agentDir}/MEMORY.md`,
    '# MEMORY.md\nSession history and important notes.\n',
  )

  const prior = existing.agentConfig ?? {}
  const priorSkills = Array.isArray(prior.skills)
    ? prior.skills.filter((s): s is Record<string, unknown> =>
      !!s && typeof s === 'object' && !Array.isArray(s)
    )
    : []
  const selectedOps = currentCfg.selected_ops ?? Object.keys(SKILL_MAP)
  const knownNames = new Set(
    Object.values(SKILL_MAP).map((skill) => skill.name),
  )
  const skills = Object.entries(SKILL_MAP).map(([op, skill]) => ({
    ...priorSkills.find((old) => old.name === skill.name),
    name: skill.name,
    enabled: selectedOps.includes(op),
    agent: skill.agent,
  }))
  const configData = {
    ...prior,
    skills: [
      ...skills,
      ...priorSkills.filter((s) => !knownNames.has(String(s.name))),
    ],
    auto_execute: false,
    mode: deployMode,
    focus_source: 'request',
    onboard_version: 2,
  }
  await Deno.writeTextFile(
    `${agentDir}/config.yml`,
    `# auto_execute: ${AUTO_EXECUTE_NOTE}\n` + stringify(configData),
  )
  invalidateAgentContext()

  // Notifications, privilege changes and browser access are deferred. An
  // explicit config-file option still works for automated server setup.
  let discordWebhook = currentCfg.discord_webhook
  if (discordWebhook === undefined && advanced) {
    discordWebhook = await Input.prompt({
      message: t('Discord Webhook URL for notifications (Enter to skip)'),
      default: existing.discordWebhook ?? '',
    })
  }
  if (discordWebhook?.trim()) {
    await updateApiYml(home, (yml) => {
      const notifications =
        yml.notifications && typeof yml.notifications === 'object' &&
          !Array.isArray(yml.notifications)
          ? yml.notifications
          : {}
      yml.notifications = {
        ...notifications,
        discord_webhook: discordWebhook!.trim(),
      }
    })
  }
  if (
    (advanced || currentCfg.sudoers_install === true) && await isSudoersTarget()
  ) {
    const result = await promptAndInstallSudoers({
      t,
      preset: currentCfg.sudoers_install,
    })
    if (result.state === 'installed' || result.state === 'already_installed') {
      await writeSudoersInstalledAt(new Date().toISOString())
    } else if (result.state === 'failed') {
      console.log(
        colors.yellow(`${t('Sudoers install failed:')} ${result.err}`),
      )
    } else if (result.state === 'foreign_file_exists') {
      console.log(
        colors.yellow(
          t('Existing sudoers file at {path} was not installed by slv — leaving it alone.')
            .replace('{path}', result.path),
        ),
      )
    }
  }
  const wantsGateway = currentCfg.install_gateway ??
    (currentCfg.enable_https === true || currentCfg.enable_lan_mode === true ||
      (advanced &&
        await Confirm.prompt({
          message: t('Enable browser chat on this machine?'),
          default: false,
        })))
  if (wantsGateway) {
    const gateway = await maybeInstallGateway(t)
    if (gateway.gatewayReachable) {
      const httpsUrl = await maybeSetupHttps(t, gateway.port)
      const mode = httpsUrl
        ? gateway.mode
        : await maybeEnableLanMode(t, gateway.port)
      await sendOnboardWebhook({
        t,
        agentHome: home,
        mode,
        port: gateway.port,
        httpsUrl,
      })
    }
  }

  console.log(
    colors.bold.rgb24(
      `\n[3/3] ${ready ? t('Ready to chat') : t('Settings saved')}`,
      0x14f195,
    ),
  )
  const count =
    new Set(skills.filter((s) => s.enabled).map((s) => s.agent)).size
  console.log(
    colors.green(
      `  ✔ ${
        t('{count} specialist agents are available. SLV chooses the right one for your request.')
          .replace('{count}', String(count))
      }`,
    ),
  )
  console.log(
    t('Personalization, notifications and browser access: `slv onboard --advanced`.'),
  )
  if (ready) {
    console.log(
      t('Try asking: "What subscriptions do I have?" or "Help me prepare a testnet validator."'),
    )
    console.log(
      colors.green(`\n  ${t('Start a conversation with `slv ai`.')}\n`),
    )
  } else {
    console.log(
      colors.yellow(
        t('Finish signing in or checking your AI balance, then run `slv ai`.'),
      ),
    )
  }
  return { ready }
}

type GatewayResult = {
  gatewayReachable: boolean
  mode: 'local' | 'lan'
  port: number
}

/**
 * Install and start the gateway daemon, waiting for its health endpoint.
 * Reuses the console startup path, including config creation before launch.
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

  // Share the startup path with the console: create config before launching,
  // then wait until the daemon accepts connections before offering access.
  const result = await ensureGatewayRunning({ quiet: true }).catch((err) => ({
    ok: false as const,
    reason: errToString(err),
  }))
  if (!result.ok) {
    console.log(colors.yellow(
      `  ⚠ ${result.reason}. ${
        t('Run `slv gateway start` manually to retry.')
      }\n`,
    ))
    return {
      gatewayReachable: false,
      mode: 'local',
      port: GATEWAY_DEFAULT_PORT,
    }
  }

  console.log(
    colors.green(
      `  ✔ ${
        t('Gateway running at http://127.0.0.1:{port}/ui/').replace(
          '{port}',
          String(result.config.port),
        )
      }\n`,
    ),
  )
  return {
    gatewayReachable: true,
    mode: result.config.mode,
    port: result.config.port,
  }
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
  port: number,
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
        ).replace('{port}', String(port))
      }`,
    ),
  )
  console.log(
    colors.bold.rgb24(
      `    ⚠ ${
        t(
          'Next step: once onboard finishes, run `slv c` and ask SLV AI to help you set up the firewall. Video walkthrough: coming soon.',
        )
      }`,
      0xffdf7a,
    ),
  )
  const enableLan = currentCfg.enable_lan_mode !== undefined
    ? currentCfg.enable_lan_mode
    : await Confirm.prompt({
      message: t('Enable remote IP access now?'),
      default: false,
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
 * browser chat URL and access guidance in the selected language.
 * Credentials are never included. No-op when no webhook is configured;
 * notification failures must not fail the overall setup.
 */
const sendOnboardWebhook = async (opts: {
  t: (key: string) => string
  agentHome: string
  mode: 'local' | 'lan'
  port: number
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
  const { t, agentHome, mode, port, httpsUrl } = opts
  const apiYmlPath = `${agentHome}/.slv/api.yml`

  // Missing webhook means the user deferred notifications.
  let webhookUrl = ''
  try {
    const raw = await Deno.readTextFile(apiYmlPath)
    const parsed = parse(raw) as Record<string, unknown> | null
    const n = parsed?.notifications as { discord_webhook?: string } | undefined
    if (n?.discord_webhook) webhookUrl = n.discord_webhook.trim()
  } catch { /* no api.yml yet */ }
  if (!webhookUrl) return

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
    const host = resolved.host.includes(':')
      ? `[${resolved.host}]`
      : resolved.host
    url = `http://${host}:${port}/ui/`
  }

  // Send access guidance without putting gateway credentials in a notification.
  const msg1Lines: string[] = [
    `🎉 ${t('SLV AI setup complete!')}`,
    '',
    `📱 ${t('Open SLV in your browser:')}`,
    url,
  ]

  const msg3Lines: string[] = []
  // Local-mode SSH tunnel hint only applies when no HTTPS URL was
  // set up. With HTTPS, browser chat needs no SSH tunnel. Commands that
  // change firewall settings still need confirmation in the terminal console.
  if (mode === 'local' && !httpsUrl) {
    msg3Lines.push(
      `ℹ️ ${
        t('Loopback-only mode — open the URL from elsewhere via SSH tunnel first:')
      }`,
      '```',
      `ssh -N -L ${port}:127.0.0.1:${port} <user>@<host>`,
      '```',
      '',
    )
  }
  msg3Lines.push(
    `⚠️ ${
      t('Security: ask SLV AI to help you set up the firewall. Run `slv c` to start.')
    }`,
    `• ${t('Video walkthrough: coming soon.')}`,
  )
  if (!httpsUrl) {
    msg3Lines.push(
      '',
      `🏷 ${
        t('For automatic HTTPS + a free *.erpc.global subdomain, run SLV on an SLV VPS or BareMetal (provision via the dashboard):')
      }`,
      ERPC_DASHBOARD_URL,
    )
  }

  // Send in order, stop on first failure. Small delay between posts
  // so the channel renders them in the right order; Discord will
  // occasionally reorder messages sent within the same tens of ms.
  const messages = [
    msg1Lines.join('\n'),
    msg3Lines.join('\n'),
  ]
  type Aggregate =
    | { kind: 'ok' }
    | { kind: 'http_error'; status: number }
    | { kind: 'network_error'; message: string }
  let result: Aggregate = { kind: 'ok' }
  for (let i = 0; i < messages.length; i++) {
    const r = await notifyDiscordWebhook(webhookUrl, messages[i])
    if (r.kind === 'ok') {
      if (i < messages.length - 1) {
        await new Promise((res) => setTimeout(res, 250))
      }
      continue
    }
    if (r.kind === 'http_error') {
      result = { kind: 'http_error', status: r.status }
    } else if (r.kind === 'network_error') {
      result = { kind: 'network_error', message: r.message }
    } else {
      // skipped_empty_url — webhookUrl went empty mid-loop,
      // shouldn't happen but bail out safely.
    }
    break
  }
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
 *   - running from `--config` without an ERPC login (no browser sign-in
 *     there — the user runs `slv login` later)
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
  port: number,
): Promise<string | null> => {
  // Platform gate — nginx-via-apt is Ubuntu/Debian-only. Silent
  // skip here is fine; macOS / BSD users aren't missing anything
  // they'd expect from this onboard step.
  if (Deno.build.os !== 'linux' || currentCfg.enable_https === false) {
    return null
  }

  // Always show the section header — even when we skip, the user
  // should see this path exists (and what to do to enable it
  // later). The previous silent-skip-on-missing-key made users
  // think the HTTPS feature didn't exist at all.
  console.log(
    colors.bold.rgb24(`\n│  ${t('Public HTTPS URL (optional)')}`, 0x14f195),
  )

  // FIX 1: re-read api.yml fresh (findUserApiAuth already bypasses
  // any cache). If there is still no ERPC login after the onboard
  // login step, offer to sign in now so HTTPS isn't blocked on a
  // single skipped prompt earlier in the flow.
  let auth = await readSlvAuthOrNull()
  if (!auth && !fromConfigFile) {
    console.log(
      colors.white(
        `  ${
          t('Signing in to ERPC lets us point your free erpc.global subdomain at this VPS for instant HTTPS.')
        }`,
      ),
    )
    const signIn = await Confirm.prompt({
      message: t('Sign in to ERPC now?'),
      default: true,
    })
    if (signIn && await signInToErpc(t)) auth = await readSlvAuthOrNull()
  }
  if (!auth) {
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

  // Pre-flight DNS status check.
  const status = await getDnsStatus(auth)
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
  if (!thisHostIp) {
    console.log(colors.yellow(
      '  Could not determine this host IP. DNS was left unchanged; retry with `slv install nginx --ip <address>`.',
    ))
    return null
  }
  if (
    def.exists && def.ip &&
    def.ip !== thisHostIp
  ) {
    if (fromConfigFile) {
      console.log(colors.yellow(
        `  ${fqdn} already points to another host. DNS was left unchanged; run onboard interactively to review.`,
      ))
      return null
    }
    return await handleSubdomainConflict(
      t,
      auth,
      fqdn,
      def.ip,
      thisHostIp,
      port,
    )
  }

  console.log(
    colors.white(
      `  ${
        t('Point your free subdomain {fqdn} at this VPS and install nginx so SLV AI is reachable over HTTPS from your phone — no cert setup needed (Cloudflare handles TLS).')
          .replace('{fqdn}', fqdn)
      }`,
    ),
  )

  const ok = currentCfg.enable_https !== undefined
    ? currentCfg.enable_https
    : await Confirm.prompt({
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
    auth,
    port,
    ip: thisHostIp,
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
 * Sign in to ERPC in the browser (the `slv login` flow) from inside the
 * onboard. A failure is reported and the onboard goes on without the login.
 */
const signInToErpc = async (t: (key: string) => string): Promise<boolean> => {
  const result = await runDeviceLogin()
  if (!result.ok) {
    for (const line of result.lines) console.log(colors.yellow(`  ${line}`))
    return false
  }
  console.log(colors.green(`  ✔ ${t('Signed in to ERPC.')}\n`))
  return true
}

/**
 * Read the ERPC login from ~/.slv/api.yml without erroring out when
 * absent — the HTTPS step treats "missing" as a prompt trigger, not a
 * fatal.
 */
const readSlvAuthOrNull = async (): Promise<UserApiAuth | null> => {
  try {
    return await findUserApiAuth()
  } catch {
    return null
  }
}

/**
 * The user's free default subdomain is already pointing somewhere
 * else — typically an earlier SLV VPS they've already onboarded.
 * Overwriting it here would break the old host's URL, so give the
 * user three explicit options and take their pick.
 */
const handleSubdomainConflict = async (
  t: (key: string) => string,
  auth: UserApiAuth,
  fqdn: string,
  currentIp: string,
  thisHostIp: string,
  port: number,
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
          "Re-point anyway (breaks the other VPS — only choose if you know what you're doing)",
        ),
        value: 'repoint',
      },
    ],
    default: 'skip',
  })

  if (choice === 'skip') {
    console.log(
      colors.rgb24(
        `  ${
          t('Kept existing subdomain. You can run `slv install nginx` on the other VPS to reclaim if needed.')
        }\n`,
        0x888888,
      ),
    )
    return null
  }

  if (choice === 'ticket') {
    console.log(colors.cyan(`  ${t('Creating support ticket...')}`))
    const description = `Request: 2nd erpc.global subdomain\n\n` +
      `Current free subdomain: ${fqdn} → ${currentIp}\n` +
      `This new VPS IP: ${thisHostIp}\n` +
      `Use case: user is onboarding a second SLV host and wants an additional subdomain for it.`
    const ticket = await openSupportTicket(auth, {
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
        `  ✔ ${t('Ticket opened. Follow up here:')} ${
          ticket.link || '(see Discord notifications)'
        }\n`,
      ),
    )
    return null
  }

  // choice === 'repoint' — run the normal flow; the caller will
  // overwrite the old record.
  console.log(colors.cyan(`🌐 Re-pointing ${fqdn} at ${thisHostIp}...`))
  const result = await runNginxFlow({
    auth,
    port,
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
