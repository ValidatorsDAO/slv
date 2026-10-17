// How slv runs the 1Password CLI (`op`): by its absolute path, without a shell,
// with nothing read from a terminal, and with an environment that holds only
// what op needs. What the parent has in its environment (a session of
// 1Password, an ssh agent, a service account token of another run) never goes to
// the child; the service account token of keyless.yml does, and only there.

type OpSpawnOptions = {
  env: Record<string, string>
  /** What to write to the stdin of op, or null for no stdin at all. */
  stdin: Uint8Array | null
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

const buildOpEnv = (
  parent: (name: string) => string | undefined,
  token: string | null,
): Record<string, string> => {
  const env: Record<string, string> = {}
  for (const name of OP_ENV_FROM_PARENT) {
    const value = parent(name)
    if (value !== undefined) env[name] = value
  }
  if (token !== null) env.OP_SERVICE_ACCOUNT_TOKEN = token
  return env
}

const defaultOpSpawn: OpSpawn = async (command, args, options) => {
  const child = new Deno.Command(command, {
    args,
    env: options.env,
    clearEnv: true,
    stdin: options.stdin === null ? 'null' : 'piped',
    stdout: 'piped',
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
  OP_ENV_FROM_PARENT,
}
export type { OpSpawn, OpSpawnOptions, OpSpawnResult }
