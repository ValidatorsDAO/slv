// Shared helpers for the tests of the keyless verbs. Not collected as a test
// file (the leading underscore keeps it out of `deno test`).
//
// The two keys are the test vectors of RFC 8032, section 7.1: they are public,
// and the tests use them as canaries, strings that must never turn up in an
// argument, an environment, a log or a prompt.

import { encodeBase58 } from '/lib/secret/base58.ts'
import { KEYPAIR_BYTES, keypairText } from '/lib/secret/keypairBytes.ts'
import type { OpSpawn } from '/lib/secret/opCli.ts'
import type { SecretSetupDeps } from '/lib/secret/setup.ts'
import type { Tty } from '/lib/secret/tty.ts'
import type { Io } from '/src/validator/keys/io.ts'

export const hex = (text: string): Uint8Array =>
  Uint8Array.from(text.match(/../g)!.map((pair) => parseInt(pair, 16)))

export type TestKey = {
  keypair: Uint8Array
  pubkey: string
  /** The text `[n,n,...]` that is stored in the item. */
  canonical: string
  /** Every spelling of the secret half that a leak could have. */
  spellings: string[]
}

const testKey = (seedHex: string, publicHex: string): TestKey => {
  const seed = hex(seedHex)
  const publicBytes = hex(publicHex)
  const keypair = new Uint8Array(KEYPAIR_BYTES)
  keypair.set(seed, 0)
  keypair.set(publicBytes, 32)
  const canonical = new TextDecoder().decode(keypairText(keypair))
  return {
    keypair,
    pubkey: encodeBase58(publicBytes),
    canonical,
    spellings: [
      canonical,
      [...seed].slice(0, 12).join(','),
      [...seed].slice(0, 12).join(', '),
      seedHex,
      btoa(String.fromCharCode(...seed)),
      encodeBase58(seed),
    ],
  }
}

/** RFC 8032, test 1. */
export const KEY_A = testKey(
  '9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60',
  'd75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a',
)
/** RFC 8032, test 2. */
export const KEY_B = testKey(
  '4ccd089b28ff96da9db6c346ec114e0f5b8a319f35aba624da8cf6ed4fb8a6fb',
  '3d4017c3e843895a92b70aa74d1b7ebc9c982ccf2ec4968cc0cd55f12af4660c',
)

/** True when `text` holds the secret half of `key` in any of its spellings. */
export const holdsKey = (text: string, key: TestKey): boolean =>
  key.spellings.some((spelling) => text.includes(spelling))

export const VAULT = 'abcdefghijklmnopqrstuvwxyz'
export const OTHER_VAULT = 'zyxwvutsrqponmlkjihgfedcba'
export const ITEM = 'a1b2c3d4e5f6g7h8i9j0k1l2m3'
export const refOf = (vault = VAULT, item = ITEM, field = 'keypair'): string =>
  `op://${vault}/${item}/${field}`

export const OP_PATH = '/usr/bin/op'
export const TOKEN = 'ops_token_from_the_file_1234567890'

/** What the parent process has in its environment: the child of op must get none of the names marked below. */
export const PARENT_ENV: Record<string, string> = {
  HOME: '/home/op',
  PATH: '/usr/bin:/bin',
  USER: 'op',
  LANG: 'C.UTF-8',
  TMPDIR: '/tmp',
  // The parent likes a cache; the child of op gets none.
  OP_CACHE: 'true',
  OP_SESSION_myaccount: 'session-canary',
  OP_SERVICE_ACCOUNT_TOKEN: 'ops_token_of_the_parent',
  SSH_AUTH_SOCK: '/tmp/ssh-agent.sock',
  SLV_CANARY: 'canary',
}

export type OpCall = {
  command: string
  args: string[]
  env: Record<string, string>
  stdinLength: number | null
  /** A copy of the stdin, taken at the call; only when the script asks for it. */
  stdin: Uint8Array | null
  /** What the call asked for its stdout: piped when it did not say. */
  stdout: 'piped' | 'null'
  /** The buffer the call was given itself, not a copy, to look at it after the verb has wiped it; only when the script asks for it. */
  stdinRef: Uint8Array | null
}

export type OpAnswer = {
  success: boolean
  stdout?: Uint8Array | string
  stderr?: string
}

/** An `op` that answers from a script and writes down every call. */
export const scriptedOp = (
  answer: (call: OpCall) => OpAnswer,
  options: { recordStdin?: boolean; keepStdin?: boolean } = {},
): { op: OpSpawn; calls: OpCall[] } => {
  const calls: OpCall[] = []
  return {
    calls,
    op: (command, args, spawnOptions) => {
      const call: OpCall = {
        command,
        args: [...args],
        env: { ...spawnOptions.env },
        stdinLength: spawnOptions.stdin === null
          ? null
          : spawnOptions.stdin.length,
        stdin: options.recordStdin && spawnOptions.stdin !== null
          ? spawnOptions.stdin.slice()
          : null,
        stdout: spawnOptions.stdout ?? 'piped',
        stdinRef: options.keepStdin && spawnOptions.stdin !== null
          ? spawnOptions.stdin
          : null,
      }
      calls.push(call)
      const reply = answer(call)
      // A call that asked for no stdout gets none, as from the real spawner.
      const stdout = spawnOptions.stdout === 'null'
        ? new Uint8Array()
        : typeof reply.stdout === 'string'
        ? new TextEncoder().encode(reply.stdout)
        : reply.stdout ?? new Uint8Array()
      return Promise.resolve({
        success: reply.success,
        stdout,
        stderr: new TextEncoder().encode(reply.stderr ?? ''),
      })
    },
  }
}

/** Where a person at a terminal is: nothing refuses, and the network has its vault and no token. */
export const setupDeps = (
  op: OpSpawn,
  overrides: Partial<SecretSetupDeps> = {},
): SecretSetupDeps => ({
  readConfig: () =>
    Promise.resolve({
      networks: { testnet: { vaultId: VAULT, tokenFile: null } },
      identityAgent: null,
    }),
  context: {
    env: () => undefined,
    envNames: () => [],
    exists: () => Promise.resolve(false),
    canOpenTty: () => Promise.resolve(true),
  },
  policy: {
    readText: () => Promise.resolve(null),
    lstat: () => Promise.reject(new Error('no token file is read')),
    uid: () => 1000,
  },
  op,
  findOp: () => Promise.resolve(OP_PATH),
  parentEnv: (name) => PARENT_ENV[name],
  readFile: () => Promise.reject(new Error('no file is read')),
  ...overrides,
})

/** The lines a verb writes and the exit code it sets. */
export const captureIo = (): {
  io: Io
  info: string[]
  error: string[]
  exitCode: () => number | undefined
} => {
  const info: string[] = []
  const error: string[] = []
  let code: number | undefined
  return {
    info,
    error,
    exitCode: () => code,
    io: {
      info: (line) => info.push(line),
      error: (line) => error.push(line),
      setExitCode: (value) => {
        code = value
      },
    },
  }
}

/** A terminal that answers each question from a list, and writes down what it was told and asked. */
export const scriptedTty = (answers: string[]): {
  tty: Tty
  said: string[]
  asked: string[]
} => {
  const said: string[] = []
  const asked: string[] = []
  const queue = [...answers]
  return {
    said,
    asked,
    tty: {
      say: (text) => {
        said.push(text)
        return Promise.resolve()
      },
      ask: (prompt) => {
        asked.push(prompt)
        return Promise.resolve(queue.shift() ?? '')
      },
    },
  }
}
