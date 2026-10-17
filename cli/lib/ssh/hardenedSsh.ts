import { join } from '@std/path'
import { firstLine } from '/lib/secret/opCli.ts'
import {
  remoteCommands,
  type SetIdentityFlag,
} from '/lib/ssh/remoteCommands.ts'
import type { SshTarget } from '/lib/ssh/sshTarget.ts'
import { zero } from '/lib/secret/keypairBytes.ts'

// The only way slv talks to a node when a key goes with it. It runs ssh itself,
// by its absolute path and without a shell, against a configuration that it
// writes for the one host and checks with `ssh -G` before it connects. The
// commands it can run are the fixed ones of remoteCommands. A key is given to a
// command on its stdin and wiped as soon as the call is over; it is never in an
// argument, in the environment or in a file.

type SshSpawnOptions = {
  /** What to write to the stdin of the process, or null for none. */
  stdin: Uint8Array | null
  env: Record<string, string>
  timeoutMs: number
}

type SshSpawnResult = {
  code: number | null
  stdout: Uint8Array
  stderr: Uint8Array
  timedOut: boolean
}

type SshSpawn = (
  command: string,
  args: string[],
  options: SshSpawnOptions,
) => Promise<SshSpawnResult>

const defaultSshSpawn: SshSpawn = async (command, args, options) => {
  const child = new Deno.Command(command, {
    args,
    env: options.env,
    clearEnv: true,
    stdin: options.stdin === null ? 'null' : 'piped',
    stdout: 'piped',
    stderr: 'piped',
  }).spawn()
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    try {
      child.kill('SIGKILL')
    } catch (_error) {
      // It has ended.
    }
  }, options.timeoutMs)
  try {
    if (options.stdin !== null) {
      try {
        const writer = child.stdin.getWriter()
        try {
          await writer.write(options.stdin)
        } finally {
          await writer.close()
        }
      } catch (_error) {
        // The process stopped before it read its input; its status says so.
      }
    }
    const { code, stdout, stderr } = await child.output()
    return { code, stdout, stderr, timedOut }
  } finally {
    clearTimeout(timer)
  }
}

class SshRefusal extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SshRefusal'
  }
}

const SAFE_PATH = /^\/[A-Za-z0-9._/-]+$/

const SSH_TIMEOUT_MS = 20_000
const SSH_CHECK_TIMEOUT_MS = 10_000

/** The ssh configuration for one host, as the text of a file. */
const buildSshConfig = (target: SshTarget, knownHostsPath: string): string => {
  for (
    const path of [target.identityFile, knownHostsPath, target.identityAgent]
  ) {
    if (path !== null && !SAFE_PATH.test(path)) {
      throw new SshRefusal(
        `the path ${path} cannot go into the ssh configuration: it has to be absolute, of letters, digits, . _ - and /`,
      )
    }
  }
  return [
    'Host target',
    `  HostName ${target.host}`,
    `  Port ${target.port}`,
    `  User ${target.user}`,
    `  HostKeyAlias ${target.alias}`,
    '  CheckHostIP no',
    `  IdentityFile ${target.identityFile}`,
    `  IdentityAgent ${target.identityAgent ?? 'none'}`,
    '  IdentitiesOnly yes',
    '  ForwardAgent no',
    '  ClearAllForwardings yes',
    '  ControlMaster no',
    '  ControlPath none',
    '  ControlPersist no',
    '  PermitLocalCommand no',
    '  ProxyCommand none',
    '  ProxyJump none',
    '  RequestTTY no',
    '  EscapeChar none',
    '  BatchMode yes',
    '  PasswordAuthentication no',
    '  KbdInteractiveAuthentication no',
    '  StrictHostKeyChecking yes',
    `  UserKnownHostsFile ${knownHostsPath}`,
    '  GlobalKnownHostsFile /dev/null',
    '  UpdateHostKeys no',
    '  LogLevel ERROR',
    '  ConnectTimeout 10',
    '',
  ].join('\n')
}

const asBoolean = (value: string): string =>
  value === 'true' || value === 'yes'
    ? 'yes'
    : value === 'false' || value === 'no'
    ? 'no'
    : value

/** The settings in the output of `ssh -G`: the lower-case name, and each value of it. */
const parseEffectiveConfig = (output: string): Map<string, string[]> => {
  const settings = new Map<string, string[]>()
  for (const line of output.split('\n')) {
    const space = line.indexOf(' ')
    if (space < 1) continue
    const name = line.slice(0, space).toLowerCase()
    settings.set(name, [
      ...(settings.get(name) ?? []),
      line.slice(space + 1).trim(),
    ])
  }
  return settings
}

/** What `ssh -G` has to say for each setting that the configuration gives, in the spelling of any OpenSSH. */
const expectedSettings = (
  target: SshTarget,
  knownHostsPath: string,
): [string, string][] => [
  ['hostname', target.host],
  ['port', String(target.port)],
  ['user', target.user],
  ['hostkeyalias', target.alias],
  ['checkhostip', 'no'],
  ['identityfile', target.identityFile],
  ['identityagent', target.identityAgent ?? 'none'],
  ['identitiesonly', 'yes'],
  ['forwardagent', 'no'],
  ['clearallforwardings', 'yes'],
  ['controlmaster', 'no'],
  ['controlpersist', 'no'],
  ['permitlocalcommand', 'no'],
  ['requesttty', 'no'],
  ['escapechar', 'none'],
  ['batchmode', 'yes'],
  ['passwordauthentication', 'no'],
  ['kbdinteractiveauthentication', 'no'],
  ['stricthostkeychecking', 'yes'],
  ['userknownhostsfile', knownHostsPath],
  ['globalknownhostsfile', '/dev/null'],
  ['updatehostkeys', 'no'],
  ['loglevel', 'ERROR'],
  ['connecttimeout', '10'],
]

/** Settings that `ssh -G` prints only when something is set, and that must not be. */
const FORBIDDEN_SETTINGS = [
  'proxycommand',
  'proxyjump',
  'controlpath',
  'localcommand',
  'localforward',
  'remoteforward',
  'dynamicforward',
  'knownhostscommand',
  'remotecommand',
  'setenv',
  'sendenv',
]

/** What differs between the output of `ssh -G` and the configuration that was meant; empty when it is the same. */
const verifyEffectiveConfig = (
  output: string,
  target: SshTarget,
  knownHostsPath: string,
): string[] => {
  const settings = parseEffectiveConfig(output)
  const differences: string[] = []
  for (const [name, expected] of expectedSettings(target, knownHostsPath)) {
    const values = settings.get(name) ?? []
    if (values.length !== 1 || asBoolean(values[0]) !== expected) {
      differences.push(
        values.length === 0
          ? `${name} is not set`
          : `${name} is not ${expected}`,
      )
    }
  }
  for (const name of FORBIDDEN_SETTINGS) {
    if (settings.has(name)) differences.push(`${name} is set`)
  }
  return differences
}

/** The pin of a host in the file of pins: the lines that key it by `alias`. Empty when there is none. */
const pinsFor = (knownHostsText: string, alias: string): string[] => {
  const lines: string[] = []
  for (const line of knownHostsText.split('\n')) {
    const fields = line.trim().split(/\s+/)
    if (fields.length < 3 || fields[0].startsWith('#')) continue
    if (fields[0].startsWith('@')) {
      if (fields[1] === alias) {
        throw new SshRefusal(
          `the file of pins has a marker (${fields[0]}) for ${alias}`,
        )
      }
      continue
    }
    if (fields[0] === alias) lines.push(line.trim())
  }
  return lines
}

type SshDeps = {
  spawn: SshSpawn
  /** The absolute path of the ssh executable. */
  sshPath: string
  /** The file of pins: ~/.slv/known_hosts. */
  knownHostsPath: string
  parentEnv: (name: string) => string | undefined
}

type SshRunName =
  | 'alive'
  | 'guardContactInfo'
  | 'unstakedPubkey'
  | 'setIdentity'
  | 'setUnstaked'
  | 'authorizedVoterAdd'

type SshRunResult = {
  outcome: 'ok' | 'failed' | 'timeout'
  code: number | null
  stdout: string
  /** The first line of what ssh wrote to stderr. */
  stderrLine: string
}

type SshSession = {
  target: SshTarget
  /**
   * Runs one of the fixed commands on the node. A buffer given as `stdin` is
   * wiped when the call is over, whatever the call came to.
   */
  run: (
    name: SshRunName,
    options?: { stdin?: Uint8Array; flag?: SetIdentityFlag },
  ) => Promise<SshRunResult>
  /** Removes the files of the session. */
  close: () => Promise<void>
}

const sshEnv = (
  parent: (name: string) => string | undefined,
): Record<string, string> => {
  const env: Record<string, string> = {}
  for (const name of ['HOME', 'PATH', 'USER', 'LANG', 'TMPDIR']) {
    const value = parent(name)
    if (value !== undefined) env[name] = value
  }
  return env
}

const commandFor = (name: SshRunName, flag: SetIdentityFlag): string => {
  switch (name) {
    case 'alive':
      return remoteCommands.alive
    case 'guardContactInfo':
      return remoteCommands.guardContactInfo
    case 'unstakedPubkey':
      return remoteCommands.unstakedPubkey
    case 'setIdentity':
      return remoteCommands.setIdentity(flag)
    case 'setUnstaked':
      return remoteCommands.setUnstaked
    case 'authorizedVoterAdd':
      return remoteCommands.authorizedVoterAdd
  }
}

/**
 * Writes the configuration of the host, has ssh say what it would do with it
 * (`ssh -G`, which makes no connection), refuses unless that is what was meant,
 * and refuses unless the host is pinned. `network` only names the command in the
 * message that asks for a pin.
 */
const openSshSession = async (
  target: SshTarget,
  network: string,
  deps: SshDeps,
): Promise<SshSession> => {
  const config = buildSshConfig(target, deps.knownHostsPath)
  const env = sshEnv(deps.parentEnv)
  const dir = await Deno.makeTempDir({ prefix: 'slv-ssh-' })
  const remove = async () => {
    await Deno.remove(dir, { recursive: true }).catch(() => undefined)
  }
  try {
    await Deno.chmod(dir, 0o700)
    const configPath = join(dir, 'ssh_config')
    await Deno.writeTextFile(configPath, config, {
      mode: 0o600,
      createNew: true,
    })

    const checked = await deps.spawn(
      deps.sshPath,
      ['-F', configPath, '-G', 'target'],
      { stdin: null, env, timeoutMs: SSH_CHECK_TIMEOUT_MS },
    )
    if (checked.code !== 0 || checked.timedOut) {
      throw new SshRefusal(
        `ssh could not read the configuration it was given: ${
          firstLine(checked.stderr)
        }`,
      )
    }
    const differences = verifyEffectiveConfig(
      new TextDecoder().decode(checked.stdout),
      target,
      deps.knownHostsPath,
    )
    if (differences.length > 0) {
      throw new SshRefusal(
        `ssh would not connect as it was configured to: ${
          differences.join('; ')
        }`,
      )
    }

    let pins: string[] = []
    try {
      pins = pinsFor(await Deno.readTextFile(deps.knownHostsPath), target.alias)
    } catch (error) {
      if (error instanceof SshRefusal) throw error
      // No file of pins is no pin.
    }
    if (pins.length === 0) {
      throw new SshRefusal(
        `${target.name} (${target.alias}) is not pinned. Pin it first: slv v hosts:pin -n ${network} -p ${target.name}`,
      )
    }
    return {
      target,
      run: async (name, options = {}) => {
        const stdin = options.stdin ?? null
        try {
          const result = await deps.spawn(
            deps.sshPath,
            [
              '-F',
              configPath,
              '-T',
              'target',
              '--',
              commandFor(name, options.flag ?? 'none'),
            ],
            { stdin, env, timeoutMs: SSH_TIMEOUT_MS },
          )
          return {
            outcome: result.timedOut
              ? 'timeout'
              : result.code === 0
              ? 'ok'
              : 'failed',
            code: result.code,
            stdout: new TextDecoder().decode(result.stdout).slice(0, 65536),
            stderrLine: firstLine(result.stderr),
          }
        } finally {
          zero(stdin)
        }
      },
      close: remove,
    }
  } catch (error) {
    await remove()
    throw error
  }
}

export {
  buildSshConfig,
  defaultSshSpawn,
  openSshSession,
  parseEffectiveConfig,
  pinsFor,
  SSH_TIMEOUT_MS,
  SshRefusal,
  verifyEffectiveConfig,
}
export type {
  SshDeps,
  SshRunName,
  SshRunResult,
  SshSession,
  SshSpawn,
  SshSpawnOptions,
  SshSpawnResult,
}
