import { findExecutable, firstLine } from '/lib/secret/opCli.ts'
import { defaultPolicyDeps, type PolicyDeps } from '/lib/secret/vaultPolicy.ts'
import { defaultTty, type Tty } from '/lib/secret/tty.ts'
import { pinsFor, SshRefusal } from '/lib/ssh/hardenedSsh.ts'
import {
  defaultInventoryReader,
  type InventoryReader,
  readSshTarget,
} from '/lib/ssh/inventoryTarget.ts'
import {
  findHostKeys,
  type HostKey,
  parseHostKey,
  parseScan,
  pinLines,
  PINS_PATH,
  revokedKeys,
  withPins,
} from '/lib/ssh/knownHosts.ts'
import { TargetError } from '/lib/ssh/sshTarget.ts'
import { defaultIo, describe, type Io } from '/src/validator/keys/io.ts'
import { readKeylessConfig } from '/lib/secret/vaultPolicy.ts'

// hosts:pin lets slv trust the key of one node. The key comes from the
// ~/.ssh/known_hosts of the person when that holds one for the node, and from
// ssh-keyscan when it does not; in both cases it is shown with its fingerprint
// and goes into ~/.slv/known_hosts only after `yes` is typed on the terminal.

type PinOptions = { network?: string; host?: string }

type PinDeps = {
  reader: InventoryReader
  /** The text of the ~/.ssh/known_hosts of the person, or null when there is none. */
  readUserKnownHosts: () => Promise<string | null>
  pins: Pick<PolicyDeps, 'readText' | 'writeText'>
  pinsPath: string
  /** What ssh-keyscan prints for the host and port. */
  scan: (host: string, port: number) => Promise<string>
  /** The ssh agent socket of keyless.yml, or null. */
  identityAgent: () => Promise<string | null>
  tty: Tty
  io: Io
}

const scanEnv = (): Record<string, string> => {
  const env: Record<string, string> = {}
  for (const name of ['HOME', 'PATH', 'USER', 'LANG', 'TMPDIR']) {
    const value = Deno.env.get(name)
    if (value !== undefined) env[name] = value
  }
  return env
}

/** The arguments of ssh-keyscan: the keys of one type, the type that is pinned. */
const scanArgs = (host: string, port: number): string[] => [
  '-T',
  '10',
  '-p',
  String(port),
  '-t',
  'ed25519',
  '--',
  host,
]

const defaultScan = async (host: string, port: number): Promise<string> => {
  const path = await findExecutable('ssh-keyscan', Deno.env.get('PATH'))
  if (path === null) {
    throw new Error('ssh-keyscan is not in an absolute directory of PATH')
  }
  const output = await new Deno.Command(path, {
    args: scanArgs(host, port),
    env: scanEnv(),
    clearEnv: true,
    stdin: 'null',
    stdout: 'piped',
    stderr: 'piped',
  }).output()
  if (!output.success) {
    throw new Error(`ssh-keyscan failed: ${firstLine(output.stderr)}`)
  }
  return new TextDecoder().decode(output.stdout)
}

const defaultPinDeps = (): PinDeps => {
  const home = Deno.env.get('HOME') ?? ''
  const policy = defaultPolicyDeps()
  return {
    reader: defaultInventoryReader(),
    readUserKnownHosts: () => policy.readText(`${home}/.ssh/known_hosts`),
    pins: policy,
    pinsPath: PINS_PATH,
    scan: defaultScan,
    identityAgent: async () => (await readKeylessConfig()).identityAgent,
    tty: defaultTty,
    io: defaultIo(),
  }
}

const listKeys = (keys: readonly HostKey[]): string =>
  keys.map((key) => `  ${key.keyType}  ${key.fingerprint}\n`).join('')

/** Returns true when the node is pinned, or already was, with the key that is shown. */
const pinHost = async (
  options: PinOptions,
  overrides: Partial<PinDeps> = {},
): Promise<boolean> => {
  const deps: PinDeps = { ...defaultPinDeps(), ...overrides }
  const refuse = (message: string): false => {
    deps.io.error(`❌ ${message}`)
    deps.io.setExitCode(1)
    return false
  }

  const network = options.network
  if (network !== 'testnet' && network !== 'mainnet') {
    return refuse(
      `hosts:pin supports -n testnet or -n mainnet, got ${
        network === undefined ? 'no network' : `"${network}"`
      }.`,
    )
  }
  if (options.host === undefined || options.host === '') {
    return refuse('hosts:pin needs -p <inventory name of the host>.')
  }

  let identityAgent: string | null
  try {
    identityAgent = await deps.identityAgent()
  } catch (error) {
    return refuse(describe(error))
  }
  let target
  try {
    ;({ target } = await readSshTarget(
      network,
      options.host,
      { identityAgent },
      deps.reader,
    ))
  } catch (error) {
    if (error instanceof TargetError) return refuse(error.message)
    return refuse(`cannot read the inventory: ${describe(error)}`)
  }

  // A node that is pinned is left as it is. A key that changed is not
  // something to replace here: it is the thing that pinning is there to notice.
  let pinsText: string | null
  try {
    pinsText = await deps.pins.readText(deps.pinsPath)
  } catch (error) {
    return refuse(`cannot read ${deps.pinsPath}: ${describe(error)}`)
  }
  let existing: string[]
  try {
    existing = pinsFor(pinsText ?? '', target.alias)
  } catch (error) {
    if (error instanceof SshRefusal) return refuse(error.message)
    throw error
  }
  if (existing.length > 0) {
    const keys: HostKey[] = []
    for (const line of existing) {
      const fields = line.split(/\s+/)
      const key = await parseHostKey(fields[1], fields[2])
      if (key !== null) keys.push(key)
    }
    deps.io.info(
      `✅ ${target.name} (${target.alias}) is pinned already:\n${
        listKeys(keys)
      }` +
        `   To pin a different key, remove its line from ${deps.pinsPath} first.`,
    )
    return true
  }

  // Where the key comes from.
  let keys: HostKey[] = []
  let source: string
  let revoked = new Set<string>()
  try {
    const known = await deps.readUserKnownHosts()
    if (known !== null) {
      revoked = revokedKeys(known)
      keys = await findHostKeys(known, target.host, target.port)
    }
  } catch (error) {
    return refuse(`cannot read your ~/.ssh/known_hosts: ${describe(error)}`)
  }
  if (keys.length > 0) {
    source =
      `Your ~/.ssh/known_hosts already holds these keys for ${target.alias}:`
  } else {
    try {
      keys = await parseScan(await deps.scan(target.host, target.port))
    } catch (error) {
      return refuse(`cannot scan ${target.alias}: ${describe(error)}`)
    }
    if (keys.length === 0) {
      return refuse(
        `ssh-keyscan returned no ssh-ed25519 key for ${target.alias}, and slv pins ssh-ed25519 host keys only. Is the node up, is port ${target.port} its ssh port, and has it an ed25519 host key?`,
      )
    }
    source =
      `${target.alias} is not in your ~/.ssh/known_hosts. ssh-keyscan returns these keys, and nothing proves they are the keys of the node; compare a fingerprint with the node itself (ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub there) or the console of the provider:`
  }
  // A key that the person has revoked is not pinned, whichever way it came.
  const offered = keys.filter((key) => revoked.has(key.base64))
  if (offered.length > 0) {
    return refuse(
      `${target.alias} offers a key that your ~/.ssh/known_hosts revokes: ${
        offered.map((key) => key.fingerprint).join(', ')
      }. Nothing was pinned.`,
    )
  }

  let typed: string
  try {
    await deps.tty.say(`${source}\n${listKeys(keys)}`)
    typed = (await deps.tty.ask(
      `Type yes to trust ${
        keys.length === 1 ? 'this key' : 'these keys'
      } for ${target.name} (${target.alias}), anything else stops here: `,
    )).trim()
  } catch (_error) {
    return refuse(
      'hosts:pin asks you on /dev/tty and cannot run without a terminal.',
    )
  }
  if (typed !== 'yes') {
    return refuse(`Not pinned: ${target.name} is not trusted yet.`)
  }

  try {
    await deps.pins.writeText(
      deps.pinsPath,
      withPins(pinsText, pinLines(target.alias, keys)),
    )
  } catch (error) {
    return refuse(`cannot write ${deps.pinsPath}: ${describe(error)}`)
  }
  deps.io.info(
    `✅ Pinned ${target.name} (${target.alias}) in ${deps.pinsPath}:\n${
      listKeys(keys)
    }`,
  )
  return true
}

export { defaultPinDeps, defaultScan, pinHost, scanArgs }
export type { PinDeps, PinOptions }
