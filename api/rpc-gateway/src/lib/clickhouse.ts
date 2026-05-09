// Minimal ClickHouse HTTP client.  HTTP only — no native protocol — keeps
// the dependency surface to Deno's built-in fetch.

export type ClickHouseConfig = {
  url: string
  database?: string
  username?: string
  password?: string
  timeoutMs?: number
}

export class ClickHouseClient {
  private base: URL
  private headers: HeadersInit
  private timeoutMs: number

  constructor(cfg: ClickHouseConfig) {
    this.base = new URL(cfg.url)
    if (cfg.database) this.base.searchParams.set('database', cfg.database)
    this.timeoutMs = cfg.timeoutMs ?? 30_000
    this.headers = {}
    if (cfg.username) {
      const auth = btoa(`${cfg.username}:${cfg.password ?? ''}`)
      ;(this.headers as Record<string, string>).Authorization = `Basic ${auth}`
    }
  }

  /**
   * Execute a SQL query and return parsed rows.  Always appends `FORMAT
   * JSONEachRow` if the caller didn't include a FORMAT clause already.
   */
  async query<T = Record<string, unknown>>(sql: string): Promise<T[]> {
    const finalSql = /\bFORMAT\s+\w+\s*$/i.test(sql.trim())
      ? sql
      : `${sql.trimEnd()} FORMAT JSONEachRow`

    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs)
    try {
      const res = await fetch(this.base.toString(), {
        method: 'POST',
        headers: this.headers,
        body: finalSql,
        signal: ctrl.signal,
      })
      if (!res.ok) {
        const body = await res.text().catch(() => '')
        throw new Error(`ClickHouse HTTP ${res.status}: ${body.slice(0, 300)}`)
      }
      const text = await res.text()
      if (!text.trim()) return []
      // JSONEachRow returns one JSON object per line.
      const rows: T[] = []
      for (const line of text.split('\n')) {
        if (!line) continue
        rows.push(JSON.parse(line))
      }
      return rows
    } finally {
      clearTimeout(timer)
    }
  }

  /** Fire a query and return the first row, or null. */
  async queryOne<T = Record<string, unknown>>(sql: string): Promise<T | null> {
    const rows = await this.query<T>(sql)
    return rows[0] ?? null
  }
}

/** Minimal SQL escaper for string literals.  Only safe for identifiers and
 * literal substitution where input is already restricted to known shapes
 * (e.g. base58 addresses, hex strings, integers).  Do NOT use for arbitrary
 * user input. */
export function quoteString(s: string): string {
  return `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`
}
