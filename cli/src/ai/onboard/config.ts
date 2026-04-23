import { parse } from '@std/yaml'

/**
 * Pre-filled answers for `slv onboard`, loaded from a single YAML
 * file via `--config <path>`. Every field is optional: a present
 * value skips the corresponding interactive prompt, an absent one
 * falls back to the normal Select/Input/Confirm.
 *
 * This is the contract a future HTTP API (`POST /v3/ai/onboard`)
 * will encode — generate the yaml server-side, scp it to the host,
 * run `slv onboard --config <path>`, and the flow terminates
 * without asking a single question.
 */
export type OnboardConfig = {
  // --- Step 1: language ---
  lang?: string

  // --- Step 2: security warning ---
  /** When true, skips the "I understand this is risky" Select. */
  security_warning_accepted?: boolean

  // --- Step 3: SLV API key ---
  /** Pre-populates ~/.slv/api.yml slv.api_key. Skipped if absent. */
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

  // --- Step 8: gateway install is always auto-yes ---

  // --- Step 9: HTTPS via erpc ---
  enable_https?: boolean

  // --- Step 10: LAN mode (fallback if HTTPS declined) ---
  enable_lan_mode?: boolean
}

/**
 * Load an OnboardConfig from `path`. Missing file is NOT an error —
 * we just return an empty object so the caller runs the usual
 * interactive flow. Malformed YAML or a schema-foreign object IS an
 * error, because silently dropping the operator's intent would
 * produce a worse UX than the bare prompt.
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
  // Shape-check: only surface recognized keys, but don't reject
  // unknown ones — callers (future API versions) may ship extra
  // fields this CLI doesn't read yet, and we want a stale binary
  // to still consume the subset it understands.
  return parsed as OnboardConfig
}
