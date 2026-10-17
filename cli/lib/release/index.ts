/** Immutable GitHub Release discovery and the trusted release-engine bridge.
 *
 * Metadata here is only a display hint. Mutations go through engine.py, which
 * repeats release identity, provenance, manifest, tag, digest, and archive
 * checks before touching a destination.
 */
export const RELEASE_REPOSITORY = 'ValidatorsDAO/slv'
export const RELEASE_WORKFLOW = '.github/workflows/slv-remote-build.yml'

const validCalVer = (value: string): boolean => {
  const match = /^(\d{4})\.(\d{1,2})\.(\d{1,2})\.(\d{4})$/.exec(value)
  if (!match || match[2].startsWith('0') || match[3].startsWith('0')) {
    return false
  }
  const [year, month, day, clock] = match.slice(1).map(Number)
  if (month < 1 || month > 12 || day < 1 || clock > 2359) return false
  const hour = Math.floor(clock / 100)
  const minute = clock % 100
  if (hour > 23 || minute > 59) return false
  const instant = new Date(Date.UTC(year, month - 1, day, hour, minute))
  return instant.getUTCFullYear() === year &&
    instant.getUTCMonth() === month - 1 &&
    instant.getUTCDate() === day
}

export type ReleaseMetadata = { version: string; tag: string }

export const compareCalVer = (a: string, b: string): number => {
  if (!validCalVer(a) || !validCalVer(b)) throw new Error('invalid CalVer')
  const aa = a.split('.').map(Number)
  const bb = b.split('.').map(Number)
  for (let i = 0; i < 4; i++) if (aa[i] !== bb[i]) return aa[i] - bb[i]
  return 0
}

export const latestRelease = async (): Promise<ReleaseMetadata> => {
  const response = await fetch(
    `https://api.github.com/repos/${RELEASE_REPOSITORY}/releases/latest`,
    {
      headers: { accept: 'application/vnd.github+json' },
      signal: AbortSignal.timeout(15_000),
    },
  )
  if (!response.ok) {
    throw new Error(`release discovery failed: HTTP ${response.status}`)
  }
  const value: unknown = await response.json()
  if (!value || typeof value !== 'object') {
    throw new Error('release discovery returned invalid JSON')
  }
  const release = value as Record<string, unknown>
  const tag = release.tag_name
  if (
    release.immutable !== true ||
    release.draft !== false ||
    release.prerelease !== false ||
    typeof tag !== 'string' ||
    !tag.startsWith('v') ||
    !validCalVer(tag.slice(1))
  ) {
    throw new Error(
      'latest release is not an immutable published strict-CalVer release',
    )
  }
  return { version: tag.slice(1), tag }
}

export const releaseAssetUrl = (tag: string, name: string): string => {
  if (
    !tag.startsWith('v') || !validCalVer(tag.slice(1)) ||
    !/^[A-Za-z0-9._-]+$/.test(name)
  ) {
    throw new Error('unsafe release asset identity')
  }
  return `https://github.com/${RELEASE_REPOSITORY}/releases/download/${tag}/${name}`
}

const releaseEngineUrl = new URL('./engine.py', import.meta.url)

const minimalEnv = (): Record<string, string> => {
  const home = Deno.env.get('HOME')
  if (!home) throw new Error('HOME is required to run the SLV release engine')
  const env: Record<string, string> = {
    HOME: home,
    PATH: Deno.env.get('PATH') || '/usr/bin:/bin',
  }
  const temp = Deno.env.get('TMPDIR')
  if (temp) env.TMPDIR = temp
  return env
}

export const releaseEngineText = async (): Promise<string> =>
  await Deno.readTextFile(releaseEngineUrl)

export const runReleaseEngine = async (
  args: readonly string[],
): Promise<string> => {
  const engine = await releaseEngineText()
  const child = new Deno.Command('python3', {
    args: ['-I', '-', ...args],
    clearEnv: true,
    env: minimalEnv(),
    stdin: 'piped',
    stdout: 'piped',
    stderr: 'piped',
  }).spawn()
  const writer = child.stdin.getWriter()
  try {
    await writer.write(new TextEncoder().encode(engine))
  } finally {
    await writer.close()
  }
  const result = await child.output()
  const stdout = new TextDecoder().decode(result.stdout)
  if (!result.success) {
    const stderr = new TextDecoder().decode(result.stderr).trim()
    throw new Error(
      stderr || `SLV release engine failed with exit code ${result.code}`,
    )
  }
  return stdout
}
