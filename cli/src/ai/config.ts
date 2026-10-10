import {
  invalidateAgentContext,
  loadAgentContext,
} from '@/ai/agentConfig/loader.ts'
import { resolveHome } from '/lib/getApiKeyFromYml.ts'
import { updateApiYml } from '/lib/userApi/session.ts'

export type AiProvider = 'openai' | 'anthropic' | 'slv'

export type AiConfig = {
  provider: AiProvider
  api_key: string
  model: string
}

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
  // Ensure api_key is always a string (may be omitted for provider: slv)
  return {
    provider: ai.provider,
    api_key: ai.api_key ?? '',
    model: ai.model,
  }
}

export const writeAiConfig = (config: AiConfig): Promise<void> =>
  writeSection((yml) => {
    // When provider is 'slv', omit api_key from the YAML (the ERPC login from `slv login` is used instead)
    if (config.provider === 'slv') {
      const { api_key: _unused, ...rest } = config
      yml.ai = rest
    } else {
      yml.ai = config
    }
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

export const OPENAI_MODELS: string[] = [
  'gpt-4o',
  'gpt-4o-mini',
  'o3-mini',
  'o3',
  'o4-mini',
  'Custom (enter model name)',
]

export const ANTHROPIC_MODELS: string[] = [
  'claude-opus-4-6',
  'claude-sonnet-4-6',
  'claude-haiku-4-5',
  'claude-opus-4-20250514',
  'claude-sonnet-4-20250514',
  'claude-haiku-4-5-20251001',
  'Custom (enter model name)',
]

export const SLV_AI_MODELS: string[] = [
  'SLV AI',
]
