import { assert, assertEquals } from '@std/assert'
import { encodeBase58 } from '/lib/secret/base58.ts'
import { findExecutable } from '/lib/secret/opCli.ts'
import {
  defaultSshSpawn,
  openSshSession,
  type SshSpawn,
} from '/lib/ssh/hardenedSsh.ts'
import { remoteCommands } from '/lib/ssh/remoteCommands.ts'
import { tryKey } from '/src/validator/keys/tryKey.ts'
import {
  captureIo,
  holdsKey,
  KEY_A,
  KEY_B,
  PARENT_ENV,
  refOf,
  scriptedOp,
  scriptedTty,
  setupDeps,
} from '/test/unit/_keylessFixtures.ts'

// keys:try with the real ssh executor: the configuration is checked by the real
// `ssh -G`, the pin is a real file, and the node is a stub that answers the
// fixed commands. The key is a canary, and has to be found nowhere but in the
// stdin of set-identity.

const SSH = await findExecutable('ssh', Deno.env.get('PATH'))

const ED_1 =
  'AAAAC3NzaC1lZDI1NTE5AAAAIJey4pRQbkl/YXPZyv2N/7zA86yiJjBKa87y5SxxyeL+'

const INVENTORY = [
  'testnet_validators:',
  '  hosts:',
  '    node-1:',
  '      ansible_host: 203.0.113.7',
  '      ansible_port: 2222',
  '      ansible_user: solv',
  '      ansible_ssh_private_key_file: ~/.ssh/node_ed25519',
  '      identity_account: HN7cABqLq46Es1jh92dQQisAq662SmxELLLsHHe4YWrH',
  '      validator_type: agave',
].join('\n')

Deno.test('with the real ssh executor the canary key is on the stdin of set-identity once and in no argument, environment, configuration, prompt or line of output, and every command is one of the fixed ones', async () => {
  assert(SSH !== null, 'ssh is needed for this test')
  const dir = await Deno.makeTempDir()
  try {
    const knownHosts = `${dir}/known_hosts`
    await Deno.writeTextFile(
      knownHosts,
      `[203.0.113.7]:2222 ssh-ed25519 ${ED_1}\n`,
    )

    let identity = KEY_A.pubkey
    const spawned: {
      args: string[]
      env: Record<string, string>
      stdinLength: number | null
    }[] = []
    const stdins: Uint8Array[] = []
    const configs: string[] = []
    const spawn: SshSpawn = async (command, args, options) => {
      spawned.push({
        args: [...args],
        env: { ...options.env },
        stdinLength: options.stdin === null ? null : options.stdin.length,
      })
      if (args.includes('-G')) {
        return await defaultSshSpawn(command, args, options)
      }
      configs.push(await Deno.readTextFile(args[1]))
      const remote = args[args.length - 1]
      let stdout = ''
      if (remote === remoteCommands.guardContactInfo) {
        stdout = `{"id": "${identity}"}`
      } else if (remote === remoteCommands.unstakedPubkey) {
        stdout = `${KEY_A.pubkey}\n`
      } else if (remote === remoteCommands.setIdentity('none')) {
        stdins.push(options.stdin!.slice())
        const key = JSON.parse(
          new TextDecoder().decode(options.stdin!),
        ) as number[]
        identity = encodeBase58(Uint8Array.from(key.slice(32)))
        stdout = `New validator identity: ${identity}\n`
      } else if (remote === remoteCommands.setUnstaked) {
        identity = KEY_A.pubkey
      } else if (remote !== remoteCommands.alive) {
        throw new Error(`a command that is not fixed: ${remote}`)
      }
      return {
        code: 0,
        stdout: new TextEncoder().encode(stdout),
        stderr: new Uint8Array(),
        timedOut: false,
      }
    }

    const op = scriptedOp((call) => ({
      success: true,
      stdout: call.args[2].endsWith('/pubkey') ? KEY_B.pubkey : KEY_B.canonical,
    }))
    const captured = captureIo()
    const terminal = scriptedTty(['node-1'])
    const result = await tryKey(
      { network: 'testnet', host: 'node-1', ref: refOf() },
      {
        setup: setupDeps(op.op),
        reader: {
          readText: () => Promise.resolve(INVENTORY),
          homeDir: '/home/op',
        },
        unused: {
          fetch: (_url, init) => {
            const method = JSON.parse(String(init.body)).method
            return Promise.resolve(
              new Response(JSON.stringify({
                jsonrpc: '2.0',
                id: 1,
                result: method === 'getClusterNodes'
                  ? []
                  : { current: [], delinquent: [] },
              })),
            )
          },
        },
        openSession: (target, network) =>
          openSshSession(target, network, {
            spawn,
            sshPath: SSH,
            knownHostsPath: knownHosts,
            parentEnv: (name) => PARENT_ENV[name],
          }),
        tty: terminal.tty,
        io: captured.io,
        sleep: () => Promise.resolve(),
      },
    )

    assertEquals(result, true, captured.error.join('\n'))
    assertEquals(identity, KEY_A.pubkey)

    // Positive control: the node got the key, once, on stdin.
    assertEquals(stdins.length, 1)
    assertEquals(new TextDecoder().decode(stdins[0]), KEY_B.canonical)

    // And nowhere else.
    const everything = JSON.stringify([
      spawned,
      configs,
      op.calls.map((call) => [call.command, call.args, call.env]),
      terminal.said,
      terminal.asked,
      captured.info,
      captured.error,
    ])
    assertEquals(holdsKey(everything, KEY_B), false)
    // The key's stdin was the only one the stub was given.
    assertEquals(
      spawned.filter((call) => call.stdinLength !== null).map((call) =>
        call.stdinLength
      ),
      [KEY_B.canonical.length],
    )
    // Every call to ssh is -G or the fixed form, with an environment without the secrets of the parent.
    for (const call of spawned) {
      if (call.args.includes('-G')) {
        assertEquals(call.args.slice(2), ['-G', 'target'])
      } else {
        assertEquals([call.args[0], ...call.args.slice(2, 5)], [
          '-F',
          '-T',
          'target',
          '--',
        ])
      }
      for (
        const name of [
          'SSH_AUTH_SOCK',
          'OP_SERVICE_ACCOUNT_TOKEN',
          'OP_SESSION_myaccount',
          'SLV_CANARY',
        ]
      ) {
        assertEquals(name in call.env, false, name)
      }
    }
  } finally {
    await Deno.remove(dir, { recursive: true })
  }
})
