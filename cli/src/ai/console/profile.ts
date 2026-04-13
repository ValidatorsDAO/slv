import { parse } from '@std/yaml'

// Three primary user archetypes the main agent tailors its behaviour for.
// `mixed` is the fallback when signals point in several directions at once
// (e.g. a user with both a validator and a trade-bot).
export type PrimaryFocus = 'validator' | 'rpc' | 'app' | 'mixed'

export type TradeAppInventory = {
  name: string
  hasBinary: boolean
  hasWallet: boolean
}

export type UserProfile = {
  primary: PrimaryFocus
  // One or two short lines of evidence used to explain the classification to
  // the user in the opening greeting.
  signals: string[]
  // Present trade-app style projects under ~/slv/. Used to bias the greeting
  // and system prompt toward Setzer when non-empty.
  apps: TradeAppInventory[]
  // True when the user manually set focus via `/focus <role>` this session or
  // a previous one. Manual overrides beat heuristics.
  overridden: boolean
}

const FOCUS_FILE = '.slv/agent/focus'

const home = (): string => Deno.env.get('HOME') || ''

const readFocusOverride = async (): Promise<PrimaryFocus | null> => {
  try {
    const raw = await Deno.readTextFile(`${home()}/${FOCUS_FILE}`)
    const v = raw.trim().toLowerCase()
    if (v === 'validator' || v === 'rpc' || v === 'app' || v === 'mixed') {
      return v
    }
  } catch { /* absent */ }
  return null
}

export const writeFocusOverride = async (
  focus: PrimaryFocus,
): Promise<void> => {
  const path = `${home()}/${FOCUS_FILE}`
  await Deno.mkdir(path.replace(/\/focus$/, ''), { recursive: true }).catch(
    () => {},
  )
  await Deno.writeTextFile(path, focus + '\n')
}

export const clearFocusOverride = async (): Promise<void> => {
  try {
    await Deno.remove(`${home()}/${FOCUS_FILE}`)
  } catch { /* absent */ }
}

const scanTradeApps = async (): Promise<TradeAppInventory[]> => {
  const slvRoot = `${home()}/slv`
  const apps: TradeAppInventory[] = []
  try {
    for await (const entry of Deno.readDir(slvRoot)) {
      if (!entry.isDirectory || entry.name.startsWith('.')) continue
      const dir = `${slvRoot}/${entry.name}`
      let hasBinary = false
      let hasWallet = false
      try {
        await Deno.stat(`${dir}/target/release/trade-app`)
        hasBinary = true
      } catch { /* no binary */ }
      try {
        await Deno.stat(`${dir}/wallet.json`)
        hasWallet = true
      } catch { /* no wallet */ }
      apps.push({ name: entry.name, hasBinary, hasWallet })
    }
  } catch { /* ~/slv doesn't exist */ }
  return apps
}

type ConfigSkill = { name: string; enabled: boolean; agent?: string }

const readEnabledSkills = async (): Promise<ConfigSkill[]> => {
  try {
    const raw = await Deno.readTextFile(
      `${home()}/.slv/agent/config.yml`,
    )
    const cfg = parse(raw) as { skills?: ConfigSkill[] } | null
    return (cfg?.skills || []).filter((s) => s && s.enabled)
  } catch { /* not configured */ }
  return []
}

// Classify the user into one of the three primary roles.
//
// Priority (highest to lowest):
//   1. Manual override via `/focus <role>` (persisted in ~/.slv/agent/focus)
//   2. Live trade apps under ~/slv/ — if the user has a real trade-bot with
//      binary+wallet, they're clearly in app-dev mode regardless of what they
//      picked during onboard.
//   3. Enabled skills in ~/.slv/agent/config.yml.
//   4. Default to `validator` (the original SLV focus).
//
// Multiple strong signals across different roles → `mixed`.
export const detectProfile = async (): Promise<UserProfile> => {
  const override = await readFocusOverride()
  const apps = await scanTradeApps()
  const enabled = await readEnabledSkills()

  if (override) {
    return {
      primary: override,
      overridden: true,
      apps,
      signals: [
        `Manual focus override: ${override} (set via /focus)`,
      ],
    }
  }

  const signals: string[] = []

  const hasLiveTradeApp = apps.some((a) => a.hasBinary || a.hasWallet)
  if (hasLiveTradeApp) {
    signals.push(
      `Trade app(s) in ~/slv: ${
        apps.filter((a) => a.hasBinary || a.hasWallet).map((a) => a.name).join(', ')
      }`,
    )
  }

  const enabledNames = new Set(enabled.map((s) => s.name))
  const hasValidatorSkill = enabledNames.has('slv-validator')
  const hasRpcSkill = enabledNames.has('slv-rpc') ||
    enabledNames.has('slv-grpc-geyser')
  const hasAppSkill = enabledNames.has('slv-app')

  const roleScore = {
    validator: 0,
    rpc: 0,
    app: 0,
  }

  if (hasLiveTradeApp) roleScore.app += 3
  if (hasAppSkill) roleScore.app += 1
  if (hasValidatorSkill) roleScore.validator += 1
  if (hasRpcSkill) roleScore.rpc += 1

  if (hasValidatorSkill) signals.push('Validator skill enabled')
  if (hasRpcSkill) signals.push('RPC / gRPC skill enabled')
  if (hasAppSkill && !hasLiveTradeApp) signals.push('App skill enabled')

  const max = Math.max(roleScore.validator, roleScore.rpc, roleScore.app)

  let primary: PrimaryFocus
  if (max === 0) {
    primary = 'validator' // fallback — original SLV focus
    signals.push('No strong signal — defaulting to validator')
  } else {
    const leaders = (Object.entries(roleScore) as [PrimaryFocus, number][])
      .filter(([k, v]) => k !== 'mixed' && v === max)
      .map(([k]) => k)
    if (leaders.length === 1) {
      primary = leaders[0]
    } else {
      primary = 'mixed'
      signals.push(`Multiple strong signals: ${leaders.join(', ')}`)
    }
  }

  return { primary, overridden: false, apps, signals }
}

// Short human-readable summary for the opening greeting. One line only.
export const describeProfile = (profile: UserProfile): string => {
  const { primary, apps } = profile
  const appCount = apps.filter((a) => a.hasBinary || a.hasWallet).length

  switch (primary) {
    case 'app': {
      if (appCount === 0) {
        return "Focused on Solana App Development. Say 'new trade bot' when you're ready."
      }
      if (appCount === 1) {
        const a = apps.find((x) => x.hasBinary || x.hasWallet)!
        return `Focused on App Development. You have 1 trade app: ${a.name}.`
      }
      return `Focused on App Development. You have ${appCount} trade apps in ~/slv/.`
    }
    case 'validator':
      return 'Focused on Solana Validator Operations. Ask me about deploys, health, or upgrades.'
    case 'rpc':
      return 'Focused on RPC / gRPC Node Operations. Ask me about endpoint setup, health, or tuning.'
    case 'mixed':
      return 'Mixed focus — validator + app / rpc. Use /focus <validator|rpc|app> to narrow.'
  }
}

// Human-readable prompt-context block inserted into the main system prompt.
// Kept short to avoid bloating every turn.
export const profilePromptBlock = (profile: UserProfile): string => {
  const { primary, apps, signals, overridden } = profile
  const appCount = apps.filter((a) => a.hasBinary || a.hasWallet).length
  const appList = apps
    .filter((a) => a.hasBinary || a.hasWallet)
    .map((a) => `- ${a.name} (binary=${a.hasBinary}, wallet=${a.hasWallet})`)
    .join('\n')

  const roleGuidance: Record<PrimaryFocus, string> = {
    validator:
      'Bias proactive suggestions toward validator operations: health checks, upgrades, restart flows, backup schedule. Delegate unfamiliar app/RPC work to the right specialist but do not push it.',
    rpc:
      'Bias proactive suggestions toward RPC / gRPC / Geyser operations: endpoint lifecycle, IP registration, slot lag, geyser plugin health. Do not push validator or app topics.',
    app:
      'Bias proactive suggestions toward trade-app work: status, live config tuning via REST API, profit/loss, wallet protection, Discord notifications. Delegate unfamiliar validator/RPC work only when the user asks.',
    mixed:
      'The user spans multiple roles. Listen for intent before proactively suggesting anything; offer options rather than picking one role.',
  }

  return `## User Profile

- **Primary focus:** ${primary}${overridden ? ' (manual /focus override)' : ''}
- **Signals:** ${signals.join('; ') || 'none'}
${appCount > 0 ? `- **Trade apps in ~/slv:** ${appCount}\n${appList}\n` : ''}
### Routing preference
${roleGuidance[primary]}

The user can override this at any time with \`/focus validator\`, \`/focus rpc\`, \`/focus app\`, or \`/focus mixed\`. Always honor an explicit intent over the profile — the profile is a prior, not a gate.`
}
