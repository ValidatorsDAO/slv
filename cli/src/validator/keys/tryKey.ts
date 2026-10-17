import {
  IdentityRefError,
  parseIdentityRef,
  pubkeyFieldRef,
} from '/lib/secret/identityRef.ts'
import {
  readPubkeyField,
  ResolveError,
  resolveIdentity,
} from '/lib/secret/resolveIdentity.ts'
import {
  defaultSecretSetupDeps,
  prepareSecretSetup,
  SecretRefusal,
  type SecretSetup,
  type SecretSetupDeps,
} from '/lib/secret/setup.ts'
import { defaultTty, type Tty } from '/lib/secret/tty.ts'
import { type UnusedDeps, whyNotUnused } from '/lib/secret/unusedPubkey.ts'
import { checkRefVault, PolicyError } from '/lib/secret/vaultPolicy.ts'
import { SshRefusal, type SshSession } from '/lib/ssh/hardenedSsh.ts'
import {
  defaultInventoryReader,
  type InventoryReader,
  readSshTarget,
} from '/lib/ssh/inventoryTarget.ts'
import {
  readRunningId,
  readUnstakedPubkey,
  withStderr,
} from '/lib/ssh/nodeReadings.ts'
import { defaultOpenSession } from '/lib/ssh/openSession.ts'
import { AGAVE_FAMILY } from '/lib/ssh/remoteCommands.ts'
import { type SshTarget, TargetError } from '/lib/ssh/sshTarget.ts'
import { defaultIo, describe, type Io } from '/src/validator/keys/io.ts'

// keys:try puts a throwaway identity of 1Password on one testnet node for a
// moment and puts the node back on its unstaked identity. The key is read after
// the person has typed the name of the node, goes to the node on the stdin of
// set-identity, and is wiped. Whatever happens after it was sent, the node is
// set back and the identity it runs is read to prove it.

type TryOptions = { network?: string; host?: string; ref?: string }

type TryDeps = {
  setup: SecretSetupDeps
  reader: InventoryReader
  unused: UnusedDeps
  openSession: (target: SshTarget, network: string) => Promise<SshSession>
  tty: Tty
  io: Io
  sleep: (ms: number) => Promise<void>
}

const defaultTryDeps = (): TryDeps => ({
  setup: defaultSecretSetupDeps(),
  reader: defaultInventoryReader(),
  unused: { fetch: (url, init) => fetch(url, init) },
  openSession: defaultOpenSession,
  tty: defaultTty,
  io: defaultIo(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
})

/** How often the node is told to go back to its unstaked identity before it is given up on. */
const REVERT_ATTEMPTS = 3
const REVERT_PAUSE_MS = 2000

/** Sets the node back on its unstaked identity and reads the identity to prove it. */
const putBack = async (
  session: SshSession,
  unstaked: string,
  deps: TryDeps,
): Promise<{ ok: boolean; note: string }> => {
  let note = ''
  for (let attempt = 1; attempt <= REVERT_ATTEMPTS; attempt++) {
    let said = ''
    try {
      const run = await session.run('setUnstaked')
      if (run.outcome !== 'ok') {
        said = withStderr(`set-identity ${run.outcome}`, run.stderrLine)
      }
    } catch (error) {
      said = describe(error)
    }
    const reading = await readRunningId(session)
    if (reading.id === unstaked) return { ok: true, note: '' }
    note = reading.id === null
      ? `${said ? `${said}; ` : ''}${reading.note}`
      : `${said ? `${said}; ` : ''}the node runs ${reading.id}`
    if (attempt < REVERT_ATTEMPTS) await deps.sleep(REVERT_PAUSE_MS)
  }
  return { ok: false, note }
}

/**
 * Tries the key of a reference on one testnet node. Returns true when the node
 * ran the key and is back on its unstaked identity, both read from the node.
 */
const tryKey = async (
  options: TryOptions,
  overrides: Partial<TryDeps> = {},
): Promise<boolean> => {
  const deps: TryDeps = { ...defaultTryDeps(), ...overrides }
  const refuse = (message: string): false => {
    deps.io.error(`❌ ${message}`)
    deps.io.setExitCode(1)
    return false
  }

  const network = options.network
  if (network === 'mainnet') {
    return refuse('keys:try runs on testnet and devnet only, never on mainnet.')
  }
  if (network === 'devnet') {
    return refuse(
      'devnet has no validator inventory, so there is no node to try a key on.',
    )
  }
  if (network !== 'testnet') {
    return refuse(
      `keys:try supports -n testnet, got ${
        network === undefined ? 'no network' : `"${network}"`
      }.`,
    )
  }
  const hostName = options.host
  if (hostName === undefined || hostName === '') {
    return refuse('keys:try needs -p <inventory name of the node>.')
  }
  if (options.ref === undefined || options.ref === '') {
    return refuse('keys:try needs --ref <reference of the key>.')
  }

  let ref
  try {
    ref = parseIdentityRef(options.ref, { homeDir: '/' }).ref
  } catch (error) {
    if (error instanceof IdentityRefError) return refuse(error.message)
    throw error
  }
  if (ref.kind !== 'op') {
    return refuse(
      'keys:try takes a 1Password reference: op://<vault id>/<item id>/keypair.',
    )
  }

  // Nothing is read, spawned or asked before these hold.
  let setup: SecretSetup
  try {
    setup = await prepareSecretSetup(network, deps.setup)
    checkRefVault(ref, setup.policy, network)
  } catch (error) {
    if (error instanceof SecretRefusal || error instanceof PolicyError) {
      return refuse(error.message)
    }
    return refuse(`keys:try stopped: ${describe(error)}`)
  }

  let target: SshTarget
  let accounts: string[]
  try {
    ;({ target, accounts } = await readSshTarget(
      network,
      hostName,
      { identityAgent: setup.config.identityAgent },
      deps.reader,
    ))
  } catch (error) {
    if (error instanceof TargetError) return refuse(error.message)
    return refuse(`cannot read the inventory: ${describe(error)}`)
  }
  if (!AGAVE_FAMILY.includes(target.validatorType)) {
    return refuse(
      `${target.name} has validator_type "${target.validatorType}": keys:try sets the identity with agave-validator and handles ${
        AGAVE_FAMILY.join(', ')
      } hosts only (it does not handle Firedancer).`,
    )
  }

  let session: SshSession
  try {
    session = await deps.openSession(target, network)
  } catch (error) {
    if (error instanceof SshRefusal) return refuse(error.message)
    return refuse(`cannot prepare ssh: ${describe(error)}`)
  }

  try {
    // 1. The node answers, runs its unstaked identity, and that file is not a staked one.
    const alive = await session.run('alive')
    if (alive.outcome !== 'ok') {
      return refuse(
        withStderr(
          `cannot run a command on ${target.name} (${alive.outcome})`,
          alive.stderrLine,
        ),
      )
    }
    const running = await readRunningId(session)
    if (running.id === null) {
      return refuse(
        `cannot read the identity that ${target.name} runs (${running.note}). Nothing was changed.`,
      )
    }
    const unstaked = await readUnstakedPubkey(session)
    if (unstaked === null) {
      return refuse(
        `cannot read the public key of /home/solv/unstaked-identity.json on ${target.name}. Nothing was changed.`,
      )
    }
    if (running.id !== unstaked) {
      return refuse(
        `${target.name} runs ${running.id}, not its unstaked identity ${unstaked}. Nothing was changed.`,
      )
    }
    if (accounts.includes(unstaked)) {
      return refuse(
        `/home/solv/unstaked-identity.json on ${target.name} holds ${unstaked}, which the inventory names as an identity or vote account. Nothing was changed.`,
      )
    }

    // 2. The key is new. Its public key is read from the item's pubkey field:
    // the key itself is not read yet.
    let pubkey: string
    try {
      pubkey = await readPubkeyField(pubkeyFieldRef(ref)!, setup.resolve)
    } catch (error) {
      if (error instanceof ResolveError) return refuse(error.message)
      throw error
    }
    const used = await whyNotUnused(network, pubkey, accounts, deps.unused)
    if (used !== null) return refuse(`${used}. Nothing was changed.`)

    // 3. A person says which node.
    let typed: string
    try {
      await deps.tty.say(
        [
          `keys:try puts a throwaway identity on a ${network} node, then puts the node back on its unstaked identity.`,
          `  host      ${target.name}  ${target.host}:${target.port}`,
          `  runs now  ${unstaked}  (its unstaked identity)`,
          `  tries     ${pubkey}`,
          `  ref       ${ref.text}`,
          '',
        ].join('\n'),
      )
      typed = (await deps.tty.ask(
        `Type the name of the host (${target.name}) to go on, anything else stops here: `,
      )).trim()
    } catch (_error) {
      return refuse(
        'keys:try asks you on /dev/tty and cannot run without a terminal.',
      )
    }
    if (typed !== target.name) {
      return refuse('That is not the name of the host. Nothing was changed.')
    }

    // 4. The key is read, proved to be the key of that public key, and the node
    // is looked at once more, because a person took the time in between.
    let key
    try {
      key = await resolveIdentity(
        ref,
        { expectedPubkey: pubkey },
        setup.resolve,
      )
    } catch (error) {
      if (error instanceof ResolveError) {
        return refuse(`${error.message}. Nothing was changed.`)
      }
      throw error
    }
    try {
      const again = await readRunningId(session)
      if (again.id !== unstaked) {
        return refuse(
          again.id === null
            ? `cannot read the identity that ${target.name} runs (${again.note}). Nothing was changed.`
            : `${target.name} runs ${again.id} now, not its unstaked identity ${unstaked}. Nothing was changed.`,
        )
      }

      deps.io.info(
        `   sending the key to ${target.name}. If this stops now, run: slv v set:unstaked -n ${network} -p ${target.name}`,
      )
      const report = {
        set: 'not run',
        seen: null as string | null,
        problem: null as string | null,
      }
      try {
        const set = await session.run('setIdentity', {
          stdin: key.canonical,
          flag: 'none',
        })
        report.set = set.outcome
        if (set.outcome !== 'ok') {
          report.problem = withStderr(
            `set-identity ${set.outcome}`,
            set.stderrLine,
          )
        }
        const after = await readRunningId(session)
        report.seen = after.id
        if (after.id !== pubkey && report.problem === null) {
          report.problem = after.id === null
            ? `cannot read the identity after set-identity (${after.note})`
            : `${target.name} runs ${after.id}, not ${pubkey}`
        }
      } catch (error) {
        report.problem ??= `stopped: ${describe(error)}`
      } finally {
        key.wipe()
      }

      // 5. Back, whatever the above came to.
      const back = await putBack(session, unstaked, deps)

      const lines = [
        `   host      ${target.name}  ${target.host}:${target.port}`,
        `   tried     ${pubkey}`,
        `   set       ${report.set}`,
        `   seen      ${report.seen ?? 'unknown'}`,
        `   back on   ${back.ok ? unstaked : 'NOT CONFIRMED'}`,
      ]
      if (report.problem === null && back.ok) {
        deps.io.info(
          `✅ ${target.name} ran ${pubkey} and is back on its unstaked identity ${unstaked}.`,
        )
        for (const line of lines) deps.io.info(line)
        return true
      }
      const problems = [
        report.problem,
        back.ok
          ? null
          : `${target.name} was not shown to be back on its unstaked identity (${back.note})`,
      ].filter((problem): problem is string => problem !== null)
      for (const line of lines) deps.io.info(line)
      return refuse(
        `keys:try did not go through: ${problems.join('; ')}.${
          back.ok
            ? ''
            : ` Set it back yourself now: slv v set:unstaked -n ${network} -p ${target.name}`
        }`,
      )
    } finally {
      key.wipe()
    }
  } catch (error) {
    return refuse(`keys:try stopped: ${describe(error)}`)
  } finally {
    await session.close()
  }
}

export { defaultTryDeps, tryKey }
export type { TryDeps, TryOptions }
