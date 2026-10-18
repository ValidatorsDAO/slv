import { parse, stringify } from '@std/yaml'
import {
  parseAgentProfile,
  parseUserProfile,
} from '@/ai/agentConfig/markdown.ts'

type ProfileDocument = {
  fields: Record<string, unknown>
  body: string
}

function readProfileDocument(
  raw: string,
  path: string,
  updates: Record<string, string>,
): ProfileDocument {
  const opening = /^(?:\uFEFF)?---[ \t]*(?:\r?\n|$)/.exec(raw)
  if (opening) {
    const rest = raw.slice(opening[0].length)
    const closing = /^---[ \t]*(?:\r?\n|$)/m.exec(rest)
    if (!closing) {
      throw new Error(`Cannot update ${path}: YAML frontmatter is not closed.`)
    }
    const yaml = rest.slice(0, closing.index)
    let fields: unknown
    try {
      fields = parse(yaml)
    } catch (cause) {
      throw new Error(`Cannot update ${path}: invalid YAML frontmatter.`, {
        cause,
      })
    }
    // An empty or comment-only block is a valid empty mapping. Explicit
    // scalars, sequences and other YAML types must not be silently discarded.
    if (
      fields == null &&
      yaml.split('\n').every((line) =>
        !line.trim() || line.trim().startsWith('#')
      )
    ) {
      fields = {}
    }
    if (
      fields === null || typeof fields !== 'object' ||
      Array.isArray(fields) ||
      Object.getPrototypeOf(fields) !== Object.prototype
    ) {
      throw new Error(
        `Cannot update ${path}: YAML frontmatter must be a mapping.`,
      )
    }
    return {
      fields: fields as Record<string, unknown>,
      body: rest.slice(closing.index + closing[0].length),
    }
  }

  // The profile parsers prefer frontmatter once it exists. Carry their
  // existing bullet-list values forward so adding one field does not hide
  // other existing identity fields. Keep the original Markdown intact.
  const agent = parseAgentProfile(raw)
  const user = parseUserProfile(raw)
  const fields: Record<string, unknown> = {}
  if (user.name ?? agent.name) fields.name = user.name ?? agent.name
  if (agent.role) fields.role = agent.role
  if (user.preferredName) {
    const preferenceKey = Object.hasOwn(updates, 'call_me') &&
        !Object.hasOwn(updates, 'preferred_name')
      ? 'call_me'
      : 'preferred_name'
    fields[preferenceKey] = user.preferredName
  }
  return { fields, body: raw }
}

/**
 * Create a default profile once. Explicit updates change only supplied
 * frontmatter keys; personal Markdown and unrelated metadata survive.
 */
export async function ensureProfileFile(
  path: string,
  initialContent: string,
  fields?: Record<string, string>,
): Promise<void> {
  let raw: string
  try {
    raw = await Deno.readTextFile(path)
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error
    // Avoid replacing a profile created between the read and the write.
    try {
      await Deno.writeTextFile(path, initialContent, { createNew: true })
    } catch (writeError) {
      if (!(writeError instanceof Deno.errors.AlreadyExists)) throw writeError
      return await ensureProfileFile(path, initialContent, fields)
    }
    return
  }
  if (!fields || Object.keys(fields).length === 0) return

  const existing = readProfileDocument(raw, path, fields)
  const frontmatter = stringify({ ...existing.fields, ...fields })
  await Deno.writeTextFile(path, `---\n${frontmatter}---\n${existing.body}`)
}
