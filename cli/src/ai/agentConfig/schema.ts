import { z } from '@hono/zod-openapi'

/**
 * Zod schemas for all agent-configuration files under ~/.slv/.
 *
 * Design notes:
 *  - Every field uses `.default()` or `.optional()` so missing/empty configs
 *    parse successfully (schema-driven defaults replace the scattered try/catch
 *    fallbacks that existed before).
 *  - All object schemas use `.passthrough()` so unknown/new fields survive
 *    round-trips and future additions stay backward-compatible.
 *  - Invalid field types never throw — the loader uses `.safeParse()` and
 *    surfaces errors through the warnings channel, then falls back to defaults.
 */

export const DeploymentModeSchema = z.enum(['remote', 'local'])
export type DeploymentMode = z.infer<typeof DeploymentModeSchema>

export const SkillEntrySchema = z.object({
  name: z.string().min(1),
  enabled: z.boolean().default(true),
  agent: z.string().min(1),
}).passthrough()
export type SkillEntry = z.infer<typeof SkillEntrySchema>

export const AgentConfigSchema = z.object({
  skills: z.array(SkillEntrySchema).default([]),
  auto_execute: z.boolean().default(true),
  mode: DeploymentModeSchema.default('remote'),
  notifications: z.object({
    discord_webhook: z.string().optional(),
  }).partial().passthrough().optional(),
}).passthrough()
export type AgentConfig = z.infer<typeof AgentConfigSchema>

export const AiProviderSchema = z.enum(['openai', 'anthropic', 'slv'])
export type AiProvider = z.infer<typeof AiProviderSchema>

export const AiConfigSchema = z.object({
  provider: AiProviderSchema,
  api_key: z.string().default(''),
  model: z.string(),
}).passthrough()
export type AiConfig = z.infer<typeof AiConfigSchema>

export const ApiConfigSchema = z.object({
  slv: z.object({
    api_key: z.string().nullable().default(null),
  }).passthrough().default({ api_key: null }),
  ai: AiConfigSchema.optional(),
  lang: z.string().optional(),
  agreed_slv_init_bot: z.boolean().optional(),
  notifications: z.object({
    discord_webhook: z.string().optional(),
  }).partial().passthrough().optional(),
}).passthrough()
export type ApiConfig = z.infer<typeof ApiConfigSchema>

/** Frontmatter shape for SOUL.md / USER.md when authors opt-in to YAML. */
export const AgentProfileFrontmatterSchema = z.object({
  name: z.string().optional(),
  role: z.string().optional(),
}).passthrough()

export const UserProfileFrontmatterSchema = z.object({
  name: z.string().optional(),
  preferred_name: z.string().optional(),
  call_me: z.string().optional(),
}).passthrough()
