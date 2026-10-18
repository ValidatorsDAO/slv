import { assert, assertEquals, assertStringIncludes } from '@std/assert'
import { stringify } from '@std/yaml'
import { getInventoryPath } from '@cmn/constants/path.ts'
import { registerBlsPubkey } from '/src/validator/registerBlsPubkey.ts'
import { registerBlsAfterDeploy } from '/src/validator/deploy/registerBlsAfterDeploy.ts'

// slv v register:bls and the registration that runs at the end of a deploy.
// Deno.Command, the inventory file and the console are replaced, so no process
// starts and no file of the person who runs the tests is read.

const read = (relative: string) =>
  Deno.readTextFile(new URL(`../../${relative}`, import.meta.url))

const HOME = '/home/operator'
const VOTE_A = 'VoteAccountAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'
const IDENTITY_A = 'IdentityAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'
const VOTE_B = 'VoteAccountBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB'
const KEYPAIR_A = `${HOME}/.slv/keys/${IDENTITY_A}.json`
const MAINNET_RPC = 'https://api.mainnet-beta.solana.com'

type Reply = { success?: boolean; stdout?: string } | 'cannot start'

const account = (bls: string | null): Reply => ({
  stdout: JSON.stringify({ blsPubkeyCompressed: bls }),
})

/**
 * The answers of solana: each read of a vote account gives the next entry of
 * `reads` (the last one again after that), every other call gives `send`.
 */
const solana = (reads: Array<string | null>, send: Reply) => {
  let next = 0
  return (args: string[]): Reply => {
    if (args[0] === 'vote-account') {
      return account(reads[Math.min(next++, reads.length - 1)])
    }
    return send
  }
}

const inventory = (hosts: Record<string, Record<string, string>>) =>
  stringify({ mainnet_validators: { hosts } })

const ONE_HOST = inventory({
  'val-a': { vote_account: VOTE_A, identity_account: IDENTITY_A },
})

const strip = (text: string) =>
  // deno-lint-ignore no-control-regex
  text.replace(/\x1b\[[0-9;]*m/g, '')

type Setup = {
  /** The text of the mainnet inventory that the registration reads. */
  inventory: string
  solana: (args: string[]) => Reply
  limit?: string
  /** Whether the caller asks for exit codes, as slv v register:bls does. */
  exitCodes?: boolean
}

/** Runs the registration on mainnet and says what it did and printed. */
const register = async (setup: Setup) => {
  const calls: string[][] = []
  const out = {
    log: [] as string[],
    warn: [] as string[],
    error: [] as string[],
  }
  const exitCodes: number[] = []
  const inventoryPath = getInventoryPath('mainnet_validators')
  const originalCommand = Deno.Command
  const originalReadTextFile = Deno.readTextFile
  const originalConsole = {
    log: console.log,
    warn: console.warn,
    error: console.error,
  }
  const originalHome = Deno.env.get('HOME')
  const encode = (text: string) => new TextEncoder().encode(text)
  class FakeCommand {
    #call: string[]
    constructor(command: string | URL, options?: Deno.CommandOptions) {
      this.#call = [String(command), ...(options?.args ?? [])]
    }
    output() {
      calls.push(this.#call)
      const reply = setup.solana(this.#call.slice(1))
      if (reply === 'cannot start') {
        return Promise.reject(
          new Deno.errors.NotFound('No such file or directory (os error 2)'),
        )
      }
      const success = reply.success ?? true
      return Promise.resolve({
        success,
        code: success ? 0 : 1,
        stdout: encode(reply.stdout ?? ''),
        stderr: encode(''),
      })
    }
  }
  const replaced = Deno as unknown as Record<string, unknown>
  try {
    Deno.env.set('HOME', HOME)
    replaced.Command = FakeCommand
    replaced.readTextFile = (path: string | URL, ...rest: unknown[]) =>
      String(path) === inventoryPath
        ? Promise.resolve(setup.inventory)
        : (originalReadTextFile as (...a: unknown[]) => Promise<string>)(
          path,
          ...rest,
        )
    for (const level of ['log', 'warn', 'error'] as const) {
      console[level] = (...args: unknown[]) => {
        out[level].push(strip(args.map(String).join(' ')))
      }
    }
    const result = await registerBlsPubkey(
      'mainnet',
      setup.limit,
      setup.exitCodes === false
        ? {}
        : { setExitCode: (code: number) => exitCodes.push(code) },
    )
    return { result, calls, out, exitCodes }
  } finally {
    replaced.Command = originalCommand
    replaced.readTextFile = originalReadTextFile
    console.log = originalConsole.log
    console.warn = originalConsole.warn
    console.error = originalConsole.error
    if (originalHome === undefined) Deno.env.delete('HOME')
    else Deno.env.set('HOME', originalHome)
  }
}

const sends = (calls: string[][]) =>
  calls.filter(([, subcommand]) => subcommand !== 'vote-account')

// What no output of a registration says on mainnet, where SIMD-0387 is active.
const INACTIVE_CLAIM =
  /not active|inactive|likely not|after activation|may not/i

Deno.test('the registration is sent with the identity key as the authorized voter, the new voter and the fee payer, so solana needs no default keypair', async () => {
  const run = await register({
    inventory: ONE_HOST,
    solana: solana([null, 'BLSKEY'], {}),
  })
  assertEquals(run.result, true)
  assertEquals(sends(run.calls), [[
    'solana',
    'vote-authorize-voter-checked',
    VOTE_A,
    KEYPAIR_A,
    KEYPAIR_A,
    '--fee-payer',
    KEYPAIR_A,
    '--use-v2-instruction',
    '--url',
    MAINNET_RPC,
  ]])
  assertEquals(run.exitCodes, [])
  assertEquals(run.out.error, [])
  assertEquals(run.out.warn, [])
  assert(
    run.out.log.some((line) => line.includes('✔︎ val-a: BLS public key set')),
  )
})

Deno.test('a vote account that has its BLS public key is not sent the registration again', async () => {
  const run = await register({
    inventory: ONE_HOST,
    solana: solana(['BLSKEY'], {}),
  })
  assertEquals(run.result, true)
  assertEquals(sends(run.calls), [])
  assertEquals(run.exitCodes, [])
  assertEquals(run.out.error, [])
})

Deno.test('a send that fails is an error with exit code 1 that says what to check, and it does not say that SIMD-0387 may not be active', async () => {
  const run = await register({
    inventory: ONE_HOST,
    solana: solana([null], { success: false }),
  })
  assertEquals(run.result, false)
  assertEquals(run.exitCodes, [1])
  assertEquals(run.out.warn, [])
  const error = run.out.error.join('\n')
  for (
    const fact of [
      'val-a',
      VOTE_A,
      'was not registered',
      'authorized voter',
      'authorized withdrawer',
      KEYPAIR_A,
      '4.3.0',
      `identity ${IDENTITY_A} has SOL`,
      'fee',
      'one voter change is accepted per epoch',
      'slv v register:bls -n mainnet -p val-a',
    ]
  ) {
    assertStringIncludes(error, fact)
  }
  const everything = [...run.out.log, ...run.out.warn, ...run.out.error]
  for (const line of everything) {
    assert(!INACTIVE_CLAIM.test(line), line)
  }
})

Deno.test('a transaction that was sent but leaves the vote account without a BLS public key is an error with exit code 1, and it does not say that SIMD-0387 may not be active', async () => {
  const run = await register({
    inventory: ONE_HOST,
    solana: solana([null, null], {}),
  })
  assertEquals(run.result, false)
  assertEquals(run.exitCodes, [1])
  assertEquals(run.out.warn, [])
  const error = run.out.error.join('\n')
  for (
    const fact of [
      'val-a',
      'the transaction was sent',
      'does not show a BLS public key',
      'slv v register:bls -n mainnet -p val-a',
    ]
  ) {
    assertStringIncludes(error, fact)
  }
  for (const line of [...run.out.log, ...run.out.warn, ...run.out.error]) {
    assert(!INACTIVE_CLAIM.test(line), line)
  }
  assert(!run.out.log.some((line) => line.includes('BLS public key set')))
})

Deno.test('solana that cannot be started is an error with exit code 1 that says to install 4.3.0 or later, and it does not throw', async () => {
  const run = await register({
    inventory: ONE_HOST,
    solana: () => 'cannot start',
  })
  assertEquals(run.result, false)
  assertEquals(run.exitCodes, [1])
  const error = run.out.error.join('\n')
  for (
    const fact of [
      'val-a',
      'could not run solana',
      'No such file or directory',
      '4.3.0 or later',
      'PATH',
      'slv v register:bls -n mainnet -p val-a',
    ]
  ) {
    assertStringIncludes(error, fact)
  }
})

Deno.test('a host that the inventory does not have, or has no accounts for, fails the run even when another host is registered', async () => {
  const run = await register({
    inventory: inventory({
      'val-a': { vote_account: VOTE_A, identity_account: IDENTITY_A },
      'val-b': { vote_account: VOTE_B },
    }),
    limit: 'val-a,val-b,val-c',
    solana: solana([null, 'BLSKEY'], {}),
  })
  assertEquals(run.result, false)
  assertEquals(run.exitCodes, [1])
  assertEquals(sends(run.calls).length, 1)
  assertEquals(run.out.warn, [])
  const error = run.out.error.join('\n')
  assertStringIncludes(error, 'Host not found in inventory: val-c')
  assertStringIncludes(
    error,
    'val-b: missing vote_account/identity_account — its BLS public key is not registered',
  )
  assert(
    run.out.log.some((line) => line.includes('✔︎ val-a: BLS public key set')),
  )
})

Deno.test('a caller that does not ask for exit codes, as the deploy does not, gets the result and the error lines and no exit code', async () => {
  const run = await register({
    inventory: ONE_HOST,
    solana: solana([null], { success: false }),
    exitCodes: false,
  })
  assertEquals(run.result, false)
  assertEquals(run.exitCodes, [])
  assertEquals(run.out.error.length > 0, true)
})

Deno.test('slv v register:bls sets exit code 1 for a registration that failed', async () => {
  const index = await read('src/validator/index.ts')
  const start = index.indexOf("validatorCmd.command('register:bls')")
  assert(start > 0, 'register:bls is not in index.ts')
  const block = index.slice(
    start,
    index.indexOf('validatorCmd.command(', start + 1),
  )
  assertStringIncludes(block, 'registerBlsPubkey(network, options.pubkey, {')
  assertStringIncludes(block, 'Deno.exitCode = code')
})

Deno.test('the registration after a deploy asks for no exit code, so one that does not happen leaves the exit code of the deploy alone', async () => {
  const asked: unknown[][] = []
  const before = Deno.exitCode
  await registerBlsAfterDeploy('testnet', 'val-a', {
    readHosts: () => Promise.resolve([]),
    keyFileExists: () => Promise.resolve(true),
    registerBls: (...args: unknown[]) => {
      asked.push(args)
      return Promise.resolve(false)
    },
    warn: () => {},
  })
  assertEquals(asked, [['testnet', 'val-a']])
  assertEquals(Deno.exitCode, before)

  // The step runs the registration itself, not a wrapper that adds the exit
  // code, and both deploys go through the step.
  assertStringIncludes(
    await read('src/validator/deploy/registerBlsAfterDeploy.ts'),
    'registerBls: registerBlsPubkey,',
  )
  for (
    const [file, call] of [
      [
        'src/validator/deploy/deployValidatorMainnet.ts',
        "registerBlsAfterDeploy('mainnet', limit)",
      ],
      [
        'src/validator/deploy/deployValidatorTestnet.ts',
        "registerBlsAfterDeploy('testnet', limit)",
      ],
    ]
  ) {
    assertStringIncludes(await read(file), call)
  }
})
