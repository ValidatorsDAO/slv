import { colors } from '@cliffy/colors'

export type KeyValueField = {
  label: string
  value: string
}

const DEFAULT_WIDTH = 80
const MIN_WIDTH = 40
const DEFAULT_INDENT = '  '

export function getTerminalWidth(fallback = DEFAULT_WIDTH): number {
  try {
    const columns = Deno.consoleSize().columns
    return Number.isFinite(columns) ? Math.max(columns, MIN_WIDTH) : fallback
  } catch {
    return fallback
  }
}

export function clampWidth(width: number, min = MIN_WIDTH): number {
  return Math.max(width, min)
}

export function wrapText(
  text: string,
  width: number,
  indent = '',
  continuationIndent = indent,
): string {
  const safeWidth = Math.max(width, 12)
  const sourceLines = String(text).split('\n')
  const wrapped: string[] = []

  for (const sourceLine of sourceLines) {
    const line = sourceLine.trim()

    if (!line) {
      wrapped.push(indent.trimEnd())
      continue
    }

    let remaining = line
    let prefix = indent

    while (remaining.length > 0) {
      const available = Math.max(safeWidth - prefix.length, 8)
      if (remaining.length <= available) {
        wrapped.push(prefix + remaining)
        break
      }

      const slice = remaining.slice(0, available + 1)
      let breakAt = Math.max(slice.lastIndexOf(' '), slice.lastIndexOf('/'))
      if (breakAt <= 0) {
        breakAt = available
      }

      const chunk = remaining.slice(0, breakAt).trimEnd()
      wrapped.push(prefix + chunk)
      remaining = remaining.slice(breakAt).trimStart()
      prefix = continuationIndent
    }
  }

  return wrapped.join('\n')
}

export function formatBulletList(
  items: string[],
  width: number,
  indent = DEFAULT_INDENT,
): string {
  return items.map((item) =>
    wrapText(item, width, `${indent}• `, `${indent}  `)
  ).join('\n')
}

export function formatKeyValueFields(
  fields: KeyValueField[],
  width: number,
  indent = DEFAULT_INDENT,
): string {
  return fields.map(({ label, value }) => {
    const labelText = `${label}: `
    return wrapText(
      value,
      width,
      `${indent}${colors.blue(labelText)}`,
      `${indent}${' '.repeat(labelText.length)}`,
    )
  }).join('\n')
}

export function divider(width: number): string {
  return colors.gray('  ' + '─'.repeat(Math.max(Math.min(width - 2, 48), 16)))
}

export function formatLink(label: string, url: string, width: number): string {
  return wrapText(url, Math.min(width, 88), `  ${colors.blue(label)}: `, '    ')
}
