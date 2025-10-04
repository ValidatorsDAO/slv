export async function remotePingMinLatency(
  host: string,
  target: string,
  options?: {
    user?: string
    keyFile?: string
    port?: number
  },
): Promise<number> {
  const user = options?.user || 'solv'
  const userHost = options?.user ? `${user}@${host}` : host
  const keyFile = options?.keyFile || '~/.ssh/id_rsa'
  const port = options?.port || 22
  const args = [
    '-o',
    'StrictHostKeyChecking=no',
    '-o',
    'UserKnownHostsFile=/dev/null',
    '-o',
    'ConnectTimeout=5', // SSH接続タイムアウト5秒
    '-p',
    port.toString(),
    '-i',
    keyFile,
    userHost,
    'sudo',
    'ping',
    '-n',
    '-c',
    '3',
    '-W',
    '5', // ping応答タイムアウト5秒
    '-q',
    target,
  ]

  try {
    const cmd = new Deno.Command('ssh', {
      args,
      stdout: 'piped',
      stderr: 'piped',
    })

    // 全体のタイムアウトを15秒に設定（SSH接続5秒 + ping最大15秒）
    const result = await Promise.race([
      cmd.output(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('Timeout')), 15000)
      ),
    ])

    const { stdout, stderr, code } = result
    const text = new TextDecoder().decode(stdout) +
      new TextDecoder().decode(stderr)

    if (code !== 0) return 9999 // エラー時は9999ms

    // ping統計行から最小値を抽出
    // Linux: rtt min/avg/max/mdev = X/X/X/X ms
    // macOS: round-trip min/avg/max/stddev = X/X/X/X ms
    const match = text.match(
      /(?:rtt |round-trip )min\/avg\/max\/\w+ = ([\d.]+)\/([\d.]+)\/([\d.]+)/,
    )

    // パケットロスのチェック
    const lossMatch = text.match(/(\d+)% packet loss/)
    if (lossMatch && lossMatch[1] === '100') {
      return 9999 // 100%パケットロスの場合
    }

    return match ? parseFloat(match[1]) : 9999
  } catch (_error) {
    // タイムアウトやその他のエラー
    return 9999
  }
}
