export async function pingMinLatency(host: string): Promise<number | null> {
  const cmd = new Deno.Command('sudo', {
    args: [
      'ping',
      '-n', // 数値表示（名前解決抑制・ロケール影響低減）
      '-c',
      '3', // 3回
      '-q', // サマリのみ
      '-w',
      '3', // 全体タイムアウト(秒)
      host,
    ],
    stdout: 'piped',
    stderr: 'piped',
    env: {
      LC_ALL: 'C',
      LANG: 'C',
    },
  })

  const { code, stdout } = await cmd.output()
  if (code !== 0) return null

  const text = new TextDecoder().decode(stdout)

  // 1) サマリ行のパース (Linux iputils / macOS / BusyBox を網羅)
  //   - "rtt min/avg/max/mdev = a/b/c/d ms"
  //   - "round-trip min/avg/max/stddev = a/b/c/d ms"
  //   - "round-trip min/avg/max = a/b/c ms"
  const summaryRe =
    /(rtt|round-trip)[^=]*=\s*([\d.]+)\/([\d.]+)\/([\d.]+)(?:\/([\d.]+))?\s*ms/i
  const m = text.match(summaryRe)
  if (m) {
    const min = parseFloat(m[2])
    return Number.isFinite(min) ? min : null
  }

  // 2) フォールバック: 各行の "time=XX ms" を全部拾って最小を取る
  const timeRe = /time[=<]\s*([\d.]+)\s*ms/gi
  let match: RegExpExecArray | null
  const values: number[] = []
  while ((match = timeRe.exec(text)) !== null) {
    const v = parseFloat(match[1])
    if (Number.isFinite(v)) values.push(v)
  }
  if (values.length > 0) {
    return Math.min(...values)
  }

  return null
}
