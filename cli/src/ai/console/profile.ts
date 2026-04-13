import { parse } from '@std/yaml'
import { dirname, join } from '@std/path'
import { t } from '@/ai/i18n/index.ts'

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

// Location of the manual /focus override, relative to $HOME.
// `focus.txt` is explicit about being a plain-text single-value marker and
// sits alongside the other agent files (SOUL.md, USER.md, MEMORY.md,
// config.yml). The older location `focus` (no extension) is still read for
// one release so users mid-session don't lose their override after upgrade.
const FOCUS_FILE_REL = '.slv/agent/focus.txt'
const LEGACY_FOCUS_FILE_REL = '.slv/agent/focus'

const requireHome = (): string => {
  const h = Deno.env.get('HOME')
  if (!h) {
    throw new Error(
      'HOME environment variable is not set — cannot locate ~/.slv',
    )
  }
  return h
}

const focusFilePath = (): string => join(requireHome(), FOCUS_FILE_REL)
const legacyFocusFilePath = (): string =>
  join(requireHome(), LEGACY_FOCUS_FILE_REL)

const parseFocusValue = (raw: string): PrimaryFocus | null => {
  const v = raw.trim().toLowerCase()
  if (v === 'validator' || v === 'rpc' || v === 'app' || v === 'mixed') {
    return v
  }
  return null
}

// Discriminated result from readFocusOverride so detectProfile can tell the
// difference between "no override file" (ignore silently) and "override file
// exists but contents are garbage" (mention it in signals so the user can
// spot their typo).
type FocusReadResult =
  | { kind: 'none' }
  | { kind: 'valid'; focus: PrimaryFocus }
  | { kind: 'invalid'; raw: string; path: string }

const tryReadFocusFile = async (
  path: string,
): Promise<string | null> => {
  try {
    return await Deno.readTextFile(path)
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return null
    throw err
  }
}

const readFocusOverride = async (): Promise<FocusReadResult> => {
  const primary = await tryReadFocusFile(focusFilePath())
  if (primary !== null) {
    const parsed = parseFocusValue(primary)
    if (parsed) return { kind: 'valid', focus: parsed }
    return { kind: 'invalid', raw: primary.trim(), path: focusFilePath() }
  }
  // Fall back to the legacy location so existing users don't lose their
  // override after this release. writeFocusOverride migrates on next set.
  const legacy = await tryReadFocusFile(legacyFocusFilePath())
  if (legacy !== null) {
    const parsed = parseFocusValue(legacy)
    if (parsed) return { kind: 'valid', focus: parsed }
    return {
      kind: 'invalid',
      raw: legacy.trim(),
      path: legacyFocusFilePath(),
    }
  }
  return { kind: 'none' }
}

export const writeFocusOverride = async (
  focus: PrimaryFocus,
): Promise<void> => {
  const path = focusFilePath()
  await Deno.mkdir(dirname(path), { recursive: true })
  await Deno.writeTextFile(path, focus + '\n')
  // Remove the legacy location so readFocusOverride's fallback never wins
  // after a successful migration. Missing is fine; anything else bubbles.
  try {
    await Deno.remove(legacyFocusFilePath())
  } catch (err) {
    if (!(err instanceof Deno.errors.NotFound)) throw err
  }
}

export const clearFocusOverride = async (): Promise<void> => {
  for (const p of [focusFilePath(), legacyFocusFilePath()]) {
    try {
      await Deno.remove(p)
    } catch (err) {
      // Only swallow NotFound — permission errors or other issues should
      // surface so the caller knows the override is still in place.
      if (!(err instanceof Deno.errors.NotFound)) throw err
    }
  }
}

const scanTradeApps = async (): Promise<TradeAppInventory[]> => {
  // NOTE: `~/slv/` holds user-scaffolded bot projects (created by
  // `slv bot init`). It is NOT the same as `~/.slv/`, which holds the SLV
  // CLI config (agent/, skills/, api.yml, …). The two are adjacent in the
  // home dir and the name similarity is a trap for future maintainers.
  const slvRoot = join(requireHome(), 'slv')
  const apps: TradeAppInventory[] = []
  try {
    for await (const entry of Deno.readDir(slvRoot)) {
      if (!entry.isDirectory || entry.name.startsWith('.')) continue
      const dir = join(slvRoot, entry.name)
      let hasBinary = false
      let hasWallet = false
      try {
        await Deno.stat(join(dir, 'target/release/trade-app'))
        hasBinary = true
      } catch { /* no binary */ }
      try {
        await Deno.stat(join(dir, 'wallet.json'))
        hasWallet = true
      } catch { /* no wallet */ }
      apps.push({ name: entry.name, hasBinary, hasWallet })
    }
  } catch (err) {
    // Only swallow NotFound — other errors (permission, etc.) should bubble
    // so the top-level catch in detectProfile() can log them cleanly.
    if (!(err instanceof Deno.errors.NotFound)) throw err
  }
  return apps
}

type ConfigSkill = { name: string; enabled: boolean; agent?: string }

const readEnabledSkills = async (): Promise<ConfigSkill[]> => {
  try {
    const raw = await Deno.readTextFile(
      join(requireHome(), '.slv/agent/config.yml'),
    )
    const cfg = parse(raw) as { skills?: ConfigSkill[] } | null
    return (cfg?.skills || []).filter((s) => s && s.enabled)
  } catch (err) {
    if (!(err instanceof Deno.errors.NotFound)) throw err
  }
  return []
}

// `mixed` is a derived classification — never a direct signal source — so
// the scoring map only holds the three concrete roles.
type ScoredRole = Exclude<PrimaryFocus, 'mixed'>
const SCORED_ROLES: readonly ScoredRole[] = ['validator', 'rpc', 'app']

// Classify the user into one of the three primary roles.
//
// Priority (highest to lowest):
//   1. Manual override via `/focus <role>` (persisted in
//      ~/.slv/agent/focus.txt). An invalid file is ignored but surfaced in
//      signals so the user can spot their typo.
//   2. Live trade apps under ~/slv/ — if the user has a real trade-bot with
//      binary+wallet, they're clearly in app-dev mode regardless of what they
//      picked during onboard.
//   3. Enabled skills in ~/.slv/agent/config.yml.
//   4. Default to `validator` (the original SLV focus).
//
// Multiple strong signals across different roles → `mixed`.
export const detectProfile = async (): Promise<UserProfile> => {
  const overrideResult = await readFocusOverride()
  const apps = await scanTradeApps()
  const enabled = await readEnabledSkills()

  if (overrideResult.kind === 'valid') {
    return {
      primary: overrideResult.focus,
      overridden: true,
      apps,
      signals: [
        `Manual focus override: ${overrideResult.focus} (set via /focus)`,
      ],
    }
  }

  const signals: string[] = []

  // If the override file exists but has a garbage value, surface it so the
  // user can spot the typo and fix it — but continue to auto-detection so
  // the session isn't blocked by a bad edit.
  if (overrideResult.kind === 'invalid') {
    signals.push(
      `Invalid focus override in ${overrideResult.path}: ${
        JSON.stringify(overrideResult.raw)
      } — expected one of validator / rpc / app / mixed. Ignoring.`,
    )
  }

  const liveApps = apps.filter((a) => a.hasBinary || a.hasWallet)
  const hasLiveTradeApp = liveApps.length > 0
  if (hasLiveTradeApp) {
    signals.push(
      `Trade app(s) in ~/slv: ${liveApps.map((a) => a.name).join(', ')}`,
    )
  }

  const enabledNames = new Set(enabled.map((s) => s.name))
  const hasValidatorSkill = enabledNames.has('slv-validator')
  const hasRpcSkill = enabledNames.has('slv-rpc') ||
    enabledNames.has('slv-grpc-geyser')
  const hasAppSkill = enabledNames.has('slv-app')

  const roleScore: Record<ScoredRole, number> = {
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

  const max = Math.max(...SCORED_ROLES.map((r) => roleScore[r]))

  let primary: PrimaryFocus
  if (max === 0) {
    primary = 'validator' // fallback — original SLV focus
    signals.push('No strong signal — defaulting to validator')
  } else {
    const leaders = SCORED_ROLES.filter((r) => roleScore[r] === max)
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
// Uses the i18n dictionary so non-English users see this in their language.
// The translations for each key live in cli/src/ai/i18n/messages/<lang>.ts.
export const describeProfile = (profile: UserProfile): string => {
  const { primary, apps } = profile
  const liveApps = apps.filter((a) => a.hasBinary || a.hasWallet)
  const appCount = liveApps.length

  switch (primary) {
    case 'app': {
      if (appCount === 0) {
        return t(
          "Focused on Solana App Development. Say 'new trade bot' when you're ready.",
        )
      }
      if (appCount === 1) {
        return t('Focused on App Development. You have 1 trade app: {name}.')
          .replace('{name}', liveApps[0].name)
      }
      return t(
        'Focused on App Development. You have {count} trade apps in ~/slv/.',
      ).replace('{count}', String(appCount))
    }
    case 'validator':
      return t(
        'Focused on Solana Validator Operations. Ask me about deploys, health, or upgrades.',
      )
    case 'rpc':
      return t(
        'Focused on RPC / gRPC Node Operations. Ask me about endpoint setup, health, or tuning.',
      )
    case 'mixed':
      return t(
        'Mixed focus — validator + app / rpc. Use /focus <validator|rpc|app> to narrow.',
      )
  }
}

// Human-readable prompt-context block inserted into the main system prompt.
// Kept short to avoid bloating every turn. The content is English regardless
// of `lang` because the model reasons in English internally — translation is
// only applied to user-facing output.
export const profilePromptBlock = (profile: UserProfile): string => {
  const { primary, apps, signals, overridden } = profile
  const liveApps = apps.filter((a) => a.hasBinary || a.hasWallet)
  const appCount = liveApps.length
  const appList = liveApps
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

  const lines: string[] = [
    '## User Profile',
    '',
    `- **Primary focus:** ${primary}${
      overridden ? ' (manual /focus override)' : ''
    }`,
    `- **Signals:** ${signals.join('; ') || 'none'}`,
  ]
  if (appCount > 0) {
    lines.push(`- **Trade apps in ~/slv:** ${appCount}`)
    lines.push(appList)
  }
  lines.push('')
  lines.push('### Routing preference')
  lines.push(roleGuidance[primary])
  lines.push('')
  lines.push(
    "The user can override this at any time with `/focus validator`, `/focus rpc`, `/focus app`, or `/focus mixed`. Always honor an explicit intent over the profile — the profile is a prior, not a gate.",
  )
  return lines.join('\n')
}
