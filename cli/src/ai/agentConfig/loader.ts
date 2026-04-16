import { parse as parseYaml } from '@std/yaml'
import { resolveHome } from '/lib/getApiKeyFromYml.ts'
import {
  resolveAgentConfigPath,
  resolveApiYmlPath,
  resolveMemoryMdPath,
  resolveSkillMdPath,
  resolveSkillsDir,
  resolveSoulMdPath,
  resolveUserMdPath,
} from '@/ai/agentConfig/paths.ts'
import {
  type AgentConfig,
  AgentConfigSchema,
  type ApiConfig,
  ApiConfigSchema,
  type DeploymentMode,
  type SkillEntry,
} from '@/ai/agentConfig/schema.ts'
import {
  AGENT_REGISTRY,
  type AgentId,
  ALL_AGENT_IDS,
  isKnownAgentId,
  listAgentsByOrder,
} from '@/ai/agentConfig/registry.ts'
import {
  parseAgentProfile,
  type ParsedAgentProfile,
  parseUserProfile,
  type ParsedUserProfile,
} from '@/ai/agentConfig/markdown.ts'

export type ConfigWarningSource =
  | 'config.yml'
  | 'api.yml'
  | 'SOUL.md'
  | 'USER.md'
  | 'MEMORY.md'
  | 'skills'

export interface ConfigWarning {
  source: ConfigWarningSource
  message: string
  path?: string
}

export interface AgentContext {
  home: string
  skillsDir: string
  raw: {
    config: AgentConfig
    api: ApiConfig
  }
  soul: ParsedAgentProfile | null
  user: ParsedUserProfile | null
  memory: { raw: string } | null
  /** Specialist agents to expose in this session, with Figaro auto-merge
   *  already applied and unknown/duplicate ids filtered out. Ordered by
   *  registry order for display use. */
  enabledAgents: AgentId[]
  /** Skills grouped by agent, including registry-declared extraSkills. The
   *  values are skill names (not paths). Use `resolveSkillMdPath(name)` to
   *  resolve a specific file. */
  skillSourcesByAgent: Record<AgentId, string[]>
  mode: DeploymentMode
  autoExecute: boolean
  discordWebhookConfigured: boolean
  warnings: ConfigWarning[]
}

interface LoadOptions {
  force?: boolean
  /** Override home for tests. */
  home?: string
}

let cached: Promise<AgentContext> | null = null
let cachedHome: string | null = null

const safeReadText = async (
  path: string,
): Promise<string | null> => {
  try {
    return await Deno.readTextFile(path)
  } catch {
    return null
  }
}

const safeStat = async (path: string): Promise<boolean> => {
  try {
    await Deno.stat(path)
    return true
  } catch {
    return false
  }
}

const parseYamlSafe = (
  raw: string,
  source: ConfigWarningSource,
  path: string,
  warnings: ConfigWarning[],
): unknown => {
  try {
    return parseYaml(raw)
  } catch (err) {
    warnings.push({
      source,
      path,
      message: `Failed to parse YAML: ${
        err instanceof Error ? err.message : String(err)
      }`,
    })
    return null
  }
}

const loadAgentConfig = async (
  path: string,
  warnings: ConfigWarning[],
): Promise<AgentConfig> => {
  const raw = await safeReadText(path)
  if (raw === null) return AgentConfigSchema.parse({})
  const parsed = parseYamlSafe(raw, 'config.yml', path, warnings)
  if (parsed === null) return AgentConfigSchema.parse({})
  const result = AgentConfigSchema.safeParse(parsed)
  if (result.success) return result.data
  warnings.push({
    source: 'config.yml',
    path,
    message: `Schema validation failed: ${
      result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join(
        '; ',
      )
    }`,
  })
  return AgentConfigSchema.parse({})
}

const loadApiConfig = async (
  path: string,
  warnings: ConfigWarning[],
): Promise<ApiConfig> => {
  const raw = await safeReadText(path)
  if (raw === null) return ApiConfigSchema.parse({})
  const parsed = parseYamlSafe(raw, 'api.yml', path, warnings)
  if (parsed === null) return ApiConfigSchema.parse({})
  const result = ApiConfigSchema.safeParse(parsed)
  if (result.success) return result.data
  warnings.push({
    source: 'api.yml',
    path,
    message: `Schema validation failed: ${
      result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join(
        '; ',
      )
    }`,
  })
  return ApiConfigSchema.parse({})
}

/** Resolve the enabled agent set from config.yml skills plus registry-driven
 *  auto-enable rules (e.g. Figaro when slv-server-procurement skill exists). */
const resolveEnabledAgents = async (
  config: AgentConfig,
  home: string,
  warnings: ConfigWarning[],
): Promise<{ agents: AgentId[]; sources: Record<AgentId, string[]> }> => {
  const configuredEnabled = new Map<AgentId, SkillEntry[]>()
  const configuredDisabled = new Set<AgentId>()

  for (const skill of config.skills) {
    if (!isKnownAgentId(skill.agent)) {
      warnings.push({
        source: 'config.yml',
        message:
          `Unknown agent "${skill.agent}" for skill "${skill.name}" — ignoring`,
      })
      continue
    }
    if (skill.enabled) {
      const list = configuredEnabled.get(skill.agent) ?? []
      list.push(skill)
      configuredEnabled.set(skill.agent, list)
    } else {
      configuredDisabled.add(skill.agent)
    }
  }

  // Apply registry auto-enable rules. Explicit disable wins.
  for (const id of ALL_AGENT_IDS) {
    const meta = AGENT_REGISTRY[id]
    if (!meta.autoEnableIfSkillPresent) continue
    if (configuredEnabled.has(id)) continue
    if (configuredDisabled.has(id)) continue
    const path = resolveSkillMdPath(meta.autoEnableIfSkillPresent, home)
    if (await safeStat(path)) {
      configuredEnabled.set(id, [
        { name: meta.autoEnableIfSkillPresent, enabled: true, agent: id },
      ])
    }
  }

  // Warn if explicitly enabled but skill file missing.
  for (const [id, skills] of configuredEnabled) {
    for (const skill of skills) {
      const present = await safeStat(resolveSkillMdPath(skill.name, home))
      if (!present) {
        warnings.push({
          source: 'skills',
          message: `Agent ${id} enabled via skill "${skill.name}" but ${
            resolveSkillMdPath(skill.name, home)
          } is missing`,
        })
      }
    }
  }

  const sources = {} as Record<AgentId, string[]>
  for (const id of ALL_AGENT_IDS) sources[id] = []
  for (const [id, skills] of configuredEnabled) {
    const set = new Set<string>(skills.map((s) => s.name))
    for (const extra of AGENT_REGISTRY[id].extraSkills ?? []) set.add(extra)
    sources[id] = [...set]
  }

  const agents = listAgentsByOrder([...configuredEnabled.keys()]).map((m) =>
    m.id
  )
  return { agents, sources }
}

const detectDiscordWebhook = (
  agentConfig: AgentConfig,
  apiConfig: ApiConfig,
): boolean => {
  const hook = apiConfig.notifications?.discord_webhook ??
    agentConfig.notifications?.discord_webhook
  return typeof hook === 'string' && hook.trim().length > 0
}

const buildContext = async (
  home: string,
): Promise<AgentContext> => {
  const warnings: ConfigWarning[] = []

  const configPath = resolveAgentConfigPath(home)
  const apiPath = resolveApiYmlPath(home)
  const soulPath = resolveSoulMdPath(home)
  const userPath = resolveUserMdPath(home)
  const memoryPath = resolveMemoryMdPath(home)

  const [config, api, soulRaw, userRaw, memoryRaw] = await Promise.all([
    loadAgentConfig(configPath, warnings),
    loadApiConfig(apiPath, warnings),
    safeReadText(soulPath),
    safeReadText(userPath),
    safeReadText(memoryPath),
  ])

  const { agents, sources } = await resolveEnabledAgents(
    config,
    home,
    warnings,
  )

  return {
    home,
    skillsDir: resolveSkillsDir(home),
    raw: { config, api },
    soul: soulRaw !== null ? parseAgentProfile(soulRaw) : null,
    user: userRaw !== null ? parseUserProfile(userRaw) : null,
    memory: memoryRaw !== null ? { raw: memoryRaw } : null,
    enabledAgents: agents,
    skillSourcesByAgent: sources,
    mode: config.mode,
    autoExecute: config.auto_execute,
    discordWebhookConfigured: detectDiscordWebhook(config, api),
    warnings,
  }
}

/** Load and memoize the agent context. Subsequent calls in the same session
 *  return the cached result. Pass `{ force: true }` to re-read files, or
 *  call `invalidateAgentContext()` after writing to any config file. */
export const loadAgentContext = (
  opts: LoadOptions = {},
): Promise<AgentContext> => {
  const home = opts.home ?? resolveHome()
  if (!opts.force && cached && cachedHome === home) return cached
  cached = buildContext(home)
  cachedHome = home
  return cached
}

export const invalidateAgentContext = (): void => {
  cached = null
  cachedHome = null
}
