import { z } from '@hono/zod-openapi'
import { AUTO_EXECUTE_NOTE } from '@/ai/console/keyMaterial.ts'

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
  auto_execute: z.boolean().default(false).describe(AUTO_EXECUTE_NOTE),
  mode: DeploymentModeSchema.default('remote'),
  notifications: z.object({
    discord_webhook: z.string().optional(),
  }).partial().passthrough().optional(),
}).passthrough()
export type AgentConfig = z.infer<typeof AgentConfigSchema>

export const AiProviderSchema = z.literal('slv')
export type AiProvider = z.infer<typeof AiProviderSchema>

export const AiConfigSchema = z.preprocess(
  (value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return value
    }
    const legacy = value as Record<string, unknown>
    // Never inspect or retain an old provider key. Old labels/models are
    // accepted solely to migrate them to the authenticated SLV service.
    return {
      provider: 'slv',
      model: 'SLV AI',
      migration_required: legacy.provider !== 'slv' ||
        legacy.model !== 'SLV AI' || Object.hasOwn(legacy, 'api_key'),
    }
  },
  z.object({
    provider: AiProviderSchema,
    model: z.literal('SLV AI'),
    migration_required: z.boolean(),
  }),
)
export type AiConfig = z.infer<typeof AiConfigSchema>

export const ApiConfigSchema = z.object({
  slv: z.object({
    api_key: z.string().nullable().default(null),
  }).passthrough().default({ api_key: null }),
  ai: AiConfigSchema.optional(),
  lang: z.string().optional(),
  agreed_slv_init_bot: z.boolean().optional(),
  sudoers_nopasswd_installed_at: z.string().optional(),
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
