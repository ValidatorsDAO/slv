import { parse as parseYaml } from '@std/yaml'
import {
  AgentProfileFrontmatterSchema,
  UserProfileFrontmatterSchema,
} from '@/ai/agentConfig/schema.ts'

/**
 * Markdown profile parsing for SOUL.md and USER.md.
 *
 * Supports two formats:
 *
 *   1. YAML frontmatter (preferred for new files)
 *      ---
 *      name: EL
 *      role: Commander
 *      ---
 *      # Free-form markdown below…
 *
 *   2. Bullet-list style (the format used by the current onboarding template)
 *      - **Name:** EL
 *      - **Call me:** K
 *
 * The fallback regex strips optional list markers (`- `/`* `), markdown
 * emphasis (`**`), and tolerates both ASCII `:` and full-width `：` colons.
 * It fixes two bugs that existed in the previous inline regex:
 *   - `**Name:** EL` used to capture `** EL` (asterisks leaked into value).
 *   - USER.md only matched `preferred_name:`; real files use `Call me:`,
 *     so `preferredName` was always empty.
 */

export interface ParsedAgentProfile {
  name?: string
  role?: string
  /** Original file contents (for embedding into the system prompt). */
  raw: string
}

export interface ParsedUserProfile {
  name?: string
  preferredName?: string
  raw: string
}

const FRONTMATTER_OPEN = '---\n'

const extractFrontmatter = (raw: string): Record<string, unknown> | null => {
  if (!raw.startsWith(FRONTMATTER_OPEN)) return null
  const rest = raw.slice(FRONTMATTER_OPEN.length)
  // Accept both '\n---\n' and trailing '\n---' (no newline at EOF).
  const endIdx = rest.search(/\n---(?:\n|$)/)
  if (endIdx === -1) return null
  const yamlBlock = rest.slice(0, endIdx)
  try {
    const parsed = parseYaml(yamlBlock)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
  } catch {
    // fall through to bullet-list parsing
  }
  return null
}

// Bullet-list field matcher. Captures (key) and (value), stripping:
//   - leading "- " or "* " bullet marker (optional)
//   - surrounding `**` markdown emphasis on both key and value
//   - leading/trailing whitespace (handled by .trim() post-match)
const BULLET_FIELD = new RegExp(
  [
    '^\\s*[-*]?\\s*', // optional bullet marker
    '\\*{0,2}', // opening emphasis on key
    '([\\w][\\w\\s\\-/]*?)', // key (1): word/hyphen/slash/space
    '\\*{0,2}', // closing emphasis on key
    '\\s*[:：]\\s*', // ASCII or full-width colon
    '\\*{0,2}', // opening emphasis on value
    '(.+?)', // value (2), non-greedy
    '\\*{0,2}', // closing emphasis on value
    '\\s*$',
  ].join(''),
  'gm',
)

const normalizeKey = (key: string): string =>
  key.toLowerCase().replace(/[\s_-]+/g, ' ').trim()

const parseBulletList = (raw: string): Record<string, string> => {
  const out: Record<string, string> = {}
  BULLET_FIELD.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = BULLET_FIELD.exec(raw)) !== null) {
    const key = normalizeKey(match[1])
    const value = match[2].trim().replace(/^\*+|\*+$/g, '').trim()
    if (!key || !value) continue
    if (out[key] !== undefined) continue // first match wins
    out[key] = value
  }
  return out
}

export const parseAgentProfile = (raw: string): ParsedAgentProfile => {
  const result: ParsedAgentProfile = { raw }
  if (!raw.trim()) return result

  const fm = extractFrontmatter(raw)
  if (fm) {
    const parsed = AgentProfileFrontmatterSchema.safeParse(fm)
    if (parsed.success) {
      if (parsed.data.name) result.name = parsed.data.name
      if (parsed.data.role) result.role = parsed.data.role
      return result
    }
  }

  const bullets = parseBulletList(raw)
  const name = bullets['name']
  const role = bullets['role']
  if (name) result.name = name
  if (role) result.role = role
  return result
}

export const parseUserProfile = (raw: string): ParsedUserProfile => {
  const result: ParsedUserProfile = { raw }
  if (!raw.trim()) return result

  const fm = extractFrontmatter(raw)
  if (fm) {
    const parsed = UserProfileFrontmatterSchema.safeParse(fm)
    if (parsed.success) {
      if (parsed.data.name) result.name = parsed.data.name
      const pref = parsed.data.preferred_name ?? parsed.data.call_me
      if (pref) result.preferredName = pref
      return result
    }
  }

  const bullets = parseBulletList(raw)
  if (bullets['name']) result.name = bullets['name']
  const pref = bullets['call me'] ?? bullets['preferred name'] ??
    bullets['preferred_name']
  if (pref) result.preferredName = pref
  return result
}
