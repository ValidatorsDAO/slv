// How slv runs the 1Password CLI (`op`): by its absolute path, without a shell,
// with nothing read from a terminal, and with an environment that holds only
// what op needs. What the parent has in its environment (a session of
// 1Password, an ssh agent, a service account token of another run) never goes to
// the child; the service account token of keyless.yml does, and only there.
// Caching is off for every call: by default op keeps what it has read in a cache
// under /tmp/com.agilebits.op.<uid> and in a background process, and a key that
// was read is not to be left there.

type OpSpawnOptions = {
  env: Record<string, string>
  /** What to write to the stdin of op, or null for no stdin at all. */
  stdin: Uint8Array | null
  /**
   * `null` for a call whose output nobody reads (`op item create` prints the
   * item it made): the output is not collected at all. `piped` is the default.
   */
  stdout?: 'piped' | 'null'
}

type OpSpawnResult = {
  success: boolean
  stdout: Uint8Array
  stderr: Uint8Array
}

type OpSpawn = (
  command: string,
  args: string[],
  options: OpSpawnOptions,
) => Promise<OpSpawnResult>

/** The variables of the parent that op is given, when the parent has them. */
const OP_ENV_FROM_PARENT = [
  'HOME',
  'PATH',
  'USER',
  'LANG',
  'TMPDIR',
  'OP_ACCOUNT',
] as const

/**
 * The variables that slv sets itself, whatever the parent has: op does not cache
 * (`op --help`: "Can also be set with the OP_CACHE environment variable").
 */
const OP_ENV_FIXED: Readonly<Record<string, string>> = { OP_CACHE: 'false' }

const buildOpEnv = (
  parent: (name: string) => string | undefined,
  token: string | null,
): Record<string, string> => {
  const env: Record<string, string> = {}
  for (const name of OP_ENV_FROM_PARENT) {
    const value = parent(name)
    if (value !== undefined) env[name] = value
  }
  Object.assign(env, OP_ENV_FIXED)
  if (token !== null) env.OP_SERVICE_ACCOUNT_TOKEN = token
  return env
}

const collect = async (
  stream: ReadableStream<Uint8Array>,
): Promise<Uint8Array> =>
  new Uint8Array(await new Response(stream).arrayBuffer())

const defaultOpSpawn: OpSpawn = async (command, args, options) => {
  const discard = options.stdout === 'null'
  const child = new Deno.Command(command, {
    args,
    env: options.env,
    clearEnv: true,
    stdin: options.stdin === null ? 'null' : 'piped',
    stdout: discard ? 'null' : 'piped',
    stderr: 'piped',
  }).spawn()
  if (options.stdin !== null) {
    try {
      const writer = child.stdin.getWriter()
      try {
        await writer.write(options.stdin)
      } finally {
        await writer.close()
      }
    } catch (_error) {
      // op stopped before it read its input; its status says so.
    }
  }
  if (discard) {
    // Its output goes nowhere, so nothing of it is held here; its errors are still read.
    const [status, stderr] = await Promise.all([
      child.status,
      collect(child.stderr),
    ])
    return { success: status.success, stdout: new Uint8Array(), stderr }
  }
  const { success, stdout, stderr } = await child.output()
  return { success, stdout, stderr }
}

/**
 * The first absolute path where `name` is an executable file in the directories
 * of `pathVariable`, or null. A relative directory in the path is skipped.
 */
const findExecutable = async (
  name: string,
  pathVariable: string | undefined,
  isExecutable: (path: string) => Promise<boolean> = defaultIsExecutable,
): Promise<string | null> => {
  for (const directory of (pathVariable ?? '').split(':')) {
    if (!directory.startsWith('/')) continue
    const candidate = `${directory.replace(/\/+$/, '')}/${name}`
    if (await isExecutable(candidate)) return candidate
  }
  return null
}

const defaultIsExecutable = async (path: string): Promise<boolean> => {
  try {
    const info = await Deno.stat(path)
    return info.isFile && info.mode !== null && (info.mode & 0o111) !== 0
  } catch (_error) {
    return false
  }
}

/** The first line of what a command wrote to stderr, with the secrets and anything that looks like part of a key taken out, and cut short. */
const firstLine = (stderr: Uint8Array, secrets: string[] = []): string => {
  // The first line with a word in it: ssh opens some messages with a row of @.
  let line = new TextDecoder().decode(stderr).split('\n')
    .map((l) => l.trim()).find((l) => /[A-Za-z0-9]/.test(l)) ?? ''
  for (const secret of secrets) {
    if (secret !== '') line = line.split(secret).join('[removed]')
  }
  // A terminal reads the controls of C0 and C1 as commands.
  // deno-lint-ignore no-control-regex
  line = line.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')
  // A run of integers is what a part of a key looks like in a message.
  line = line.replace(/\d{1,3}(?:\s*,\s*\d{1,3}){3,}/g, '[removed]')
  return line.length > 200 ? `${line.slice(0, 200)}...` : line
}

export {
  buildOpEnv,
  defaultOpSpawn,
  findExecutable,
  firstLine,
  OP_ENV_FIXED,
  OP_ENV_FROM_PARENT,
}
export type { OpSpawn, OpSpawnOptions, OpSpawnResult }
