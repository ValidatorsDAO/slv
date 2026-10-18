import {
  invalidateAgentContext,
  loadAgentContext,
} from '@/ai/agentConfig/loader.ts'
import { resolveHome } from '/lib/getApiKeyFromYml.ts'
import { updateApiYml } from '/lib/userApi/session.ts'

export type AiConfig = {
  provider: 'slv'
  model: 'SLV AI'
  migratedFromLegacy?: boolean
}

export const DEFAULT_AI_CONFIG: AiConfig = { provider: 'slv', model: 'SLV AI' }
export const SLV_OAUTH_MIGRATION_MESSAGE =
  'SLV AI now uses ERPC OAuth only. Personal Claude/OpenAI API keys are no longer used. Run `slv login` to connect your ERPC account.'

// Sections of ~/.slv/api.yml written here: ai, lang, agreed_slv_init_bot and
// sudoers_nopasswd_installed_at (ISO timestamp of when `slv onboard`
// installed the NOPASSWD sudoers drop-in on this machine; absent = never
// offered or the user declined).

// Read side delegates to loadAgentContext so we parse api.yml once per session.
// Write side goes through updateApiYml: under the api.yml lock it reads the
// file again and changes only its own section, so the ERPC login in `slv:`
// (whose refresh token another process may have just rotated) is never
// written back from an old copy. Then the cache is invalidated so subsequent
// loads see the updated values.

const writeSection = async (
  change: (yml: Record<string, unknown>) => void,
): Promise<void> => {
  await updateApiYml(resolveHome(), change)
  invalidateAgentContext()
}

export const readAiConfig = async (): Promise<AiConfig | null> => {
  const ctx = await loadAgentContext()
  const ai = ctx.raw.api.ai
  if (!ai) return null
  if (ai.migration_required) {
    // The schema keeps only a migration flag, never the old key. Rewrite only
    // the AI section under the existing credential lock; OAuth stays intact.
    await writeAiConfig(DEFAULT_AI_CONFIG)
    return { ...DEFAULT_AI_CONFIG, migratedFromLegacy: true }
  }
  return { ...DEFAULT_AI_CONFIG }
}

export const writeAiConfig = (
  _config: AiConfig = DEFAULT_AI_CONFIG,
): Promise<void> =>
  writeSection((yml) => {
    // An explicit allowlist prevents runtime callers from persisting a key or
    // re-enabling a removed provider, even if they bypass TypeScript types.
    yml.ai = { provider: 'slv', model: 'SLV AI' }
  })

export const readLang = async (): Promise<string> => {
  const ctx = await loadAgentContext()
  const lang = ctx.raw.api.lang
  return lang && lang.trim().length > 0 ? lang.trim() : 'en'
}

export const hasLangSet = async (): Promise<boolean> => {
  const ctx = await loadAgentContext()
  const lang = ctx.raw.api.lang
  return typeof lang === 'string' && lang.trim().length > 0
}

export const writeLang = (lang: string): Promise<void> =>
  writeSection((yml) => {
    yml.lang = lang
  })

export const readBotAgreement = async (): Promise<boolean> => {
  const ctx = await loadAgentContext()
  return ctx.raw.api.agreed_slv_init_bot === true
}

export const writeBotAgreement = (agreed: boolean): Promise<void> =>
  writeSection((yml) => {
    yml.agreed_slv_init_bot = agreed
  })

export const readSudoersInstalledAt = async (): Promise<string | null> => {
  const ctx = await loadAgentContext()
  const ts = ctx.raw.api.sudoers_nopasswd_installed_at
  return typeof ts === 'string' && ts.trim() ? ts : null
}

export const writeSudoersInstalledAt = (iso: string): Promise<void> =>
  writeSection((yml) => {
    yml.sudoers_nopasswd_installed_at = iso
  })

export const DEFAULT_MAX_TOKENS = 8192
