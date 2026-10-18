import { parse } from '@std/yaml'
import { z } from '@hono/zod-openapi'
import { isValidApiKey } from '/lib/getApiKeyFromYml.ts'

/**
 * Pre-filled answers for `slv onboard`, loaded from a single YAML
 * file via `--config <path>`. Every field is optional: a present
 * value overrides a default. Quick setup only asks for language, sign-in
 * and confirmation. Personalization and server settings are optional.
 *
 * To avoid prompts, supply lang and security_warning_accepted. Config runs
 * never start browser sign-in or chat. Enabling browser access can require
 * additional HTTPS or LAN answers.
 */
export type OnboardConfig = {
  // --- Step 1: language ---
  lang?: string

  // --- Step 2: security warning ---
  /** When present, supplies the guided-setup confirmation answer. */
  security_warning_accepted?: boolean

  // --- Step 3: API key for RPC ---
  /**
   * Saved as ~/.slv/api.yml slv.api_key when it is a UUID. It is the API key
   * for the RPC endpoints only and is not used for the ERPC account: SLV AI
   * and the HTTPS step need an ERPC login (`slv login`), which a `--config`
   * run does not start.
   */
  slv_api_key?: string

  // --- Step 4/5: agent setup ---
  user_name?: string
  call_me_name?: string
  agent_name?: string
  selected_ops?: string[]
  deploy_mode?: 'local' | 'remote'

  // --- Step 6: Discord webhook ---
  discord_webhook?: string

  // --- Step 7: sudoers (linux) ---
  sudoers_install?: boolean

  // --- Optional browser service (off in quick setup) ---
  install_gateway?: boolean

  // --- Step 9: HTTPS via erpc ---
  enable_https?: boolean

  // --- Step 10: LAN mode (fallback if HTTPS declined) ---
  enable_lan_mode?: boolean
}

export const ONBOARD_OPERATIONS = [
  'Solana Validator Operations',
  'Index RPC Node Operations',
  'gRPC Geyser Streaming',
  'Benchmark & Connectivity Testing',
  'Solana App Development',
  'Server Procurement',
] as const

const onboardConfigSchema = z.object({
  lang: z.string().trim().min(1).optional(),
  security_warning_accepted: z.boolean().optional(),
  slv_api_key: z.string().trim().refine(
    (v) => v === '' || isValidApiKey(v),
    'must be a UUID or empty',
  ).optional(),
  user_name: z.string().trim().min(1).optional(),
  call_me_name: z.string().optional(),
  agent_name: z.string().optional(),
  selected_ops: z.array(z.enum(ONBOARD_OPERATIONS)).optional(),
  deploy_mode: z.enum(['local', 'remote']).optional(),
  discord_webhook: z.string().optional(),
  sudoers_install: z.boolean().optional(),
  install_gateway: z.boolean().optional(),
  enable_https: z.boolean().optional(),
  enable_lan_mode: z.boolean().optional(),
})

/**
 * Load and validate pre-filled answers before any onboarding side effects.
 * Missing files, malformed YAML and invalid known fields are errors.
 * Unknown fields are ignored for compatibility with newer config producers.
 */
export const loadOnboardConfig = async (
  path: string,
): Promise<OnboardConfig> => {
  let raw: string
  try {
    raw = await Deno.readTextFile(path)
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) {
      throw new Error(`onboard config not found: ${path}`)
    }
    throw err
  }
  let parsed: unknown
  try {
    parsed = parse(raw)
  } catch (err) {
    throw new Error(
      `onboard config is not valid YAML: ${
        err instanceof Error ? err.message : String(err)
      }`,
    )
  }
  if (parsed === null || parsed === undefined) return {}
  if (typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(
      `onboard config must be a YAML mapping, got ${typeof parsed}`,
    )
  }
  const result = onboardConfigSchema.safeParse(parsed)
  if (!result.success) {
    // Name invalid fields without echoing credentials from the input.
    const fields = result.error.issues.map((issue) => issue.path.join('.'))
    throw new Error(`onboard config has invalid fields: ${fields.join(', ')}`)
  }
  return result.data
}
