import { parse, stringify } from '@std/yaml'
import { dirname } from '@std/path'
import { colors } from '@cliffy/colors'

export type AiProvider = 'openai' | 'anthropic' | 'slv'

export type AiConfig = {
  provider: AiProvider
  api_key: string
  model: string
}

type ApiYml = {
  slv: { api_key: string | null }
  ai?: AiConfig
}

const getApiYmlPath = (): string => {
  const home = Deno.env.get('HOME')
  if (!home) {
    console.log(colors.red('HOME environment variable not found'))
    Deno.exit(1)
  }
  return home + '/.slv/api.yml'
}

const readApiYml = async (): Promise<ApiYml> => {
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
    console.warn(colors.yellow('Warning: Failed to parse api.yml, using defaults'))
    return { slv: { api_key: null } }
  }
}

export const readAiConfig = async (): Promise<AiConfig | null> => {
  const yml = await readApiYml()
  if (!yml.ai) return null
  // Ensure api_key is always a string (may be omitted for provider: slv)
  return { ...yml.ai, api_key: yml.ai.api_key ?? '' }
}

export const writeAiConfig = async (config: AiConfig): Promise<void> => {
  const path = getApiYmlPath()
  await Deno.mkdir(dirname(path), { recursive: true })
  const yml = await readApiYml()

  // When provider is 'slv', omit api_key from the YAML (slv.api_key is used instead)
  if (config.provider === 'slv') {
    const { api_key: _unused, ...rest } = config
    yml.ai = { ...rest, api_key: '' } as AiConfig
    // Write YAML without the ai.api_key field
    const ymlObj = yml as Record<string, unknown>
    const aiObj = ymlObj.ai as Record<string, unknown>
    delete aiObj.api_key
    await Deno.writeTextFile(path, stringify(ymlObj))
  } else {
    yml.ai = config
    await Deno.writeTextFile(path, stringify(yml as Record<string, unknown>))
  }
  await Deno.chmod(path, 0o600)
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
