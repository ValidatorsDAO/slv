import { parse, stringify } from '@std/yaml'
import { dirname } from '@std/path'
import { colors } from '@cliffy/colors'

import {
  invalidateAgentContext,
  loadAgentContext,
} from '@/ai/agentConfig/loader.ts'
import { resolveApiYmlPath } from '@/ai/agentConfig/paths.ts'

export type AiProvider = 'openai' | 'anthropic' | 'slv'

export type AiConfig = {
  provider: AiProvider
  api_key: string
  model: string
}

type ApiYml = {
  slv: { api_key: string | null }
  ai?: AiConfig
  lang?: string
  agreed_slv_init_bot?: boolean
  // ISO timestamp of when `slv onboard` installed the NOPASSWD sudoers
  // drop-in on this machine. Absent = never offered or user declined.
  sudoers_nopasswd_installed_at?: string
}

const getApiYmlPath = (): string => {
  try {
    return resolveApiYmlPath()
  } catch {
    console.log(colors.red('HOME environment variable not found'))
    Deno.exit(1)
  }
}

// Read side delegates to loadAgentContext so we parse api.yml once per session.
// Write side reads+stringifies directly (the loader is read-only) and then
// invalidates the cache so subsequent loads see the updated values.

const readApiYmlForWrite = async (): Promise<ApiYml> => {
  const path = getApiYmlPath()
  try {
    await Deno.stat(path)
  } catch {
    return { slv: { api_key: null } }
  }
  const content = await Deno.readTextFile(path)
  try {
    return parse(content) as ApiYml
  } catch {
    console.warn(
      colors.yellow('Warning: Failed to parse api.yml, using defaults'),
    )
    return { slv: { api_key: null } }
  }
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

export const writeAiConfig = async (config: AiConfig): Promise<void> => {
  const path = getApiYmlPath()
  await Deno.mkdir(dirname(path), { recursive: true })
  const yml = await readApiYmlForWrite()

  // When provider is 'slv', omit api_key from the YAML (slv.api_key is used instead)
  if (config.provider === 'slv') {
    const { api_key: _unused, ...rest } = config
    yml.ai = { ...rest, api_key: '' } as AiConfig
    const ymlObj = yml as Record<string, unknown>
    const aiObj = ymlObj.ai as Record<string, unknown>
    delete aiObj.api_key
    await Deno.writeTextFile(path, stringify(ymlObj))
  } else {
    yml.ai = config
    await Deno.writeTextFile(path, stringify(yml as Record<string, unknown>))
  }
  await Deno.chmod(path, 0o600)
  invalidateAgentContext()
}

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

export const writeLang = async (lang: string): Promise<void> => {
  const path = getApiYmlPath()
  await Deno.mkdir(dirname(path), { recursive: true })
  const yml = await readApiYmlForWrite()
  yml.lang = lang
  await Deno.writeTextFile(path, stringify(yml as Record<string, unknown>))
  await Deno.chmod(path, 0o600)
  invalidateAgentContext()
}

export const readBotAgreement = async (): Promise<boolean> => {
  const ctx = await loadAgentContext()
  return ctx.raw.api.agreed_slv_init_bot === true
}

export const writeBotAgreement = async (agreed: boolean): Promise<void> => {
  const path = getApiYmlPath()
  await Deno.mkdir(dirname(path), { recursive: true })
  const yml = await readApiYmlForWrite()
  yml.agreed_slv_init_bot = agreed
  await Deno.writeTextFile(path, stringify(yml as Record<string, unknown>))
  await Deno.chmod(path, 0o600)
  invalidateAgentContext()
}

export const readSudoersInstalledAt = async (): Promise<string | null> => {
  const ctx = await loadAgentContext()
  const ts = ctx.raw.api.sudoers_nopasswd_installed_at
  return typeof ts === 'string' && ts.trim() ? ts : null
}

export const writeSudoersInstalledAt = async (
  iso: string,
): Promise<void> => {
  const path = getApiYmlPath()
  await Deno.mkdir(dirname(path), { recursive: true })
  const yml = await readApiYmlForWrite()
  yml.sudoers_nopasswd_installed_at = iso
  await Deno.writeTextFile(path, stringify(yml as Record<string, unknown>))
  await Deno.chmod(path, 0o600)
  invalidateAgentContext()
}

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
