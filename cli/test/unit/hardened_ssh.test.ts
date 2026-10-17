import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from '@std/assert'
import { findExecutable } from '/lib/secret/opCli.ts'
import {
  buildSshConfig,
  defaultSshSpawn,
  openSshSession,
  parseEffectiveConfig,
  pinsFor,
  SshNotPinned,
  SshRefusal,
  type SshSpawn,
  verifyEffectiveConfig,
} from '/lib/ssh/hardenedSsh.ts'
import { remoteCommands } from '/lib/ssh/remoteCommands.ts'
import type { SshTarget } from '/lib/ssh/sshTarget.ts'

// These tests run the real `ssh -G`, which prints the settings ssh would use
// and makes no connection. Everything after that is a stub.

const SSH = await findExecutable('ssh', Deno.env.get('PATH'))

const ED_1 =
  'AAAAC3NzaC1lZDI1NTE5AAAAIJey4pRQbkl/YXPZyv2N/7zA86yiJjBKa87y5SxxyeL+'
const ALIAS = '[203.0.113.7]:2222'

const TARGET: SshTarget = {
  name: 'node-1',
  host: '203.0.113.7',
  port: 2222,
  user: 'solv',
  identityFile: '/home/op/.ssh/node_ed25519',
  identityAgent: null,
  alias: ALIAS,
  identityAccount: '586Z7H2vpX9qNhN2T4e9Utugie3ogjbxzGaMtM3E6HR5',
  validatorType: 'agave',
}

const PARENT: Record<string, string> = {
  HOME: '/home/op',
  PATH: '/usr/bin:/bin',
  USER: 'op',
  LANG: 'C.UTF-8',
  TMPDIR: '/tmp',
  // What ssh must never get from the parent.
  SSH_AUTH_SOCK: '/tmp/ssh-agent.sock',
  OP_SERVICE_ACCOUNT_TOKEN: 'ops_token_of_the_parent',
  ANSIBLE_CONFIG: '/tmp/ansible.cfg',
  LD_PRELOAD: '/tmp/evil.so',
  SSH_ASKPASS: '/tmp/askpass',
}

type Spawned = {
  args: string[]
  env: Record<string, string>
  stdinLength: number | null
  stdin: Uint8Array | null
}

/** Real ssh for `-G` (its output can be changed on the way), the given stub for everything else. */
const spawnOf = (
  run: (spawned: Spawned) => ReturnType<SshSpawn>,
  options: { tamper?: (output: string) => string; copyStdin?: boolean } = {},
): { spawn: SshSpawn; spawned: Spawned[]; checks: Spawned[] } => {
  const spawned: Spawned[] = []
  const checks: Spawned[] = []
  const spawn: SshSpawn = async (command, args, spawnOptions) => {
    const record: Spawned = {
      args: [...args],
      env: { ...spawnOptions.env },
      stdinLength: spawnOptions.stdin === null
        ? null
        : spawnOptions.stdin.length,
      stdin: options.copyStdin && spawnOptions.stdin !== null
        ? spawnOptions.stdin.slice()
        : null,
    }
    if (args.includes('-G')) {
      checks.push(record)
      const real = await defaultSshSpawn(command, args, spawnOptions)
      if (options.tamper === undefined) return real
      return {
        ...real,
        stdout: new TextEncoder().encode(
          options.tamper(new TextDecoder().decode(real.stdout)),
        ),
      }
    }
    spawned.push(record)
    return run(record)
  }
  return { spawn, spawned, checks }
}

const answer = (
  code: number | null,
  stdout = '',
  stderr = '',
  timedOut = false,
) =>
  Promise.resolve({
    code,
    stdout: new TextEncoder().encode(stdout),
    stderr: new TextEncoder().encode(stderr),
    timedOut,
  })

/** A temp dir with a file of pins in it, for the aliases given. */
const withPinsFile = async <T>(
  lines: string[],
  body: (knownHosts: string) => Promise<T>,
): Promise<T> => {
  const dir = await Deno.makeTempDir()
  try {
    const knownHosts = `${dir}/known_hosts`
    await Deno.writeTextFile(knownHosts, lines.map((l) => `${l}\n`).join(''))
    return await body(knownHosts)
  } finally {
    await Deno.remove(dir, { recursive: true })
  }
}

const open = (
  spawn: SshSpawn,
  knownHostsPath: string,
  target: SshTarget = TARGET,
) => {
  assert(SSH !== null, 'ssh is needed for this test')
  return openSshSession(target, 'testnet', {
    spawn,
    sshPath: SSH,
    knownHostsPath,
    parentEnv: (name) => PARENT[name],
  })
}

Deno.test('the configuration that is written is what real ssh -G says it would use, with the key file or with an agent socket, and the forced differences are all found', async () => {
  assert(SSH !== null, 'ssh is needed for this test')
  const dir = await Deno.makeTempDir()
  try {
    const knownHosts = `${dir}/known_hosts`
    const effective = async (config: string): Promise<string> => {
      const path = `${dir}/ssh_config`
      await Deno.writeTextFile(path, config)
      const out = await defaultSshSpawn(
        SSH,
        ['-F', path, '-G', 'target'],
        { stdin: null, env: { PATH: '/usr/bin:/bin' }, timeoutMs: 10000 },
      )
      assertEquals(out.code, 0)
      return new TextDecoder().decode(out.stdout)
    }

    const written = buildSshConfig(TARGET, knownHosts)
    const output = await effective(written)
    assertEquals(verifyEffectiveConfig(output, TARGET, knownHosts), [])
    const settings = parseEffectiveConfig(output)
    assertEquals(settings.get('hostkeyalias'), [ALIAS])
    assertEquals(settings.get('identityfile'), [TARGET.identityFile])
    assertEquals(settings.get('userknownhostsfile'), [knownHosts])
    assertEquals(settings.get('globalknownhostsfile'), ['/dev/null'])
    // The host key of one type only: the type that hosts:pin pins, and that the person checked.
    assertEquals(settings.get('hostkeyalgorithms'), ['ssh-ed25519'])
    assertEquals(settings.get('identityagent'), ['none'])
    assertEquals(settings.get('forwardagent'), ['no'])
    assertEquals(settings.has('proxycommand'), false)

    const agent = { ...TARGET, identityAgent: '/home/op/.1password/agent.sock' }
    assertEquals(
      verifyEffectiveConfig(
        await effective(buildSshConfig(agent, knownHosts)),
        agent,
        knownHosts,
      ),
      [],
    )

    // Positive control: the same checks find each setting that is made different.
    const forced = written
      .replace('ControlMaster no', 'ControlMaster auto')
      .replace('ForwardAgent no', 'ForwardAgent yes')
      .replace('StrictHostKeyChecking yes', 'StrictHostKeyChecking no')
      .replace('ProxyCommand none', 'ProxyCommand nc %h %p')
      .replace('IdentitiesOnly yes', 'IdentitiesOnly no')
      .replace('ClearAllForwardings yes', 'ClearAllForwardings no')
      .replace(
        'HostKeyAlgorithms ssh-ed25519',
        'HostKeyAlgorithms ssh-ed25519,ecdsa-sha2-nistp256',
      ) +
      'LocalForward 8000 127.0.0.1:8000\n'
    const found = verifyEffectiveConfig(
      await effective(forced),
      TARGET,
      knownHosts,
    )
    for (
      const difference of [
        'controlmaster is not no',
        'forwardagent is not no',
        'stricthostkeychecking is not yes',
        'identitiesonly is not yes',
        'hostkeyalgorithms is not ssh-ed25519',
        'clearallforwardings is not yes',
        'proxycommand is set',
        'localforward is set',
      ]
    ) {
      assert(found.includes(difference), `${difference} in ${found}`)
    }
  } finally {
    await Deno.remove(dir, { recursive: true })
  }
})

Deno.test('a session is not opened when ssh -G shows a setting that differs from the one written, when it fails, when the host is not pinned or the pin has a marker, and then nothing is connected', async () => {
  await withPinsFile([`${ALIAS} ssh-ed25519 ${ED_1}`], async (knownHosts) => {
    const never = () => Promise.reject(new Error('no connection is made'))

    // ssh -G says controlmaster auto although the file says no.
    const forced = spawnOf(never, {
      tamper: (out) => out.replace('controlmaster false', 'controlmaster auto'),
    })
    const refused = await assertRejects(
      () => open(forced.spawn, knownHosts),
      SshRefusal,
    )
    assertStringIncludes(refused.message, 'controlmaster is not no')
    assertEquals(forced.spawned.length, 0)

    // A setting that ssh -G prints only when something sets it.
    const proxied = spawnOf(never, {
      tamper: (out) => `${out}proxycommand nc 203.0.113.7 22\n`,
    })
    const proxy = await assertRejects(
      () => open(proxied.spawn, knownHosts),
      SshRefusal,
    )
    assertStringIncludes(proxy.message, 'proxycommand is set')

    // ssh -G itself fails.
    const failing: SshSpawn = () =>
      answer(255, '', 'Bad configuration option\n')
    const broken = await assertRejects(
      () => open(failing, knownHosts),
      SshRefusal,
    )
    assertStringIncludes(broken.message, 'Bad configuration option')
  })

  const real = spawnOf(() => Promise.reject(new Error('no connection is made')))
  for (
    const [name, lines] of [
      ['an empty file of pins', []],
      ['a pin of another host', [`[203.0.113.8]:2222 ssh-ed25519 ${ED_1}`]],
      ['the bare address in place of the alias', [
        `203.0.113.7 ssh-ed25519 ${ED_1}`,
      ]],
      ['a marker on the alias', [`@revoked ${ALIAS} ssh-ed25519 ${ED_1}`]],
    ] as [string, string[]][]
  ) {
    await withPinsFile(lines, async (knownHosts) => {
      const error = await assertRejects(
        () => open(real.spawn, knownHosts),
        SshRefusal,
        undefined,
        name,
      )
      if (!name.startsWith('a marker')) {
        assertStringIncludes(
          error.message,
          'slv v hosts:pin -n testnet -p node-1',
        )
      }
      // A host that is not pinned is told apart from one refused for another reason: the commands that move an identity pin it on the spot.
      assertEquals(
        error instanceof SshNotPinned,
        !name.startsWith('a marker'),
        name,
      )
    })
  }
  // No file of pins at all.
  const none = await assertRejects(
    () => open(real.spawn, '/nonexistent/known_hosts'),
    SshRefusal,
  )
  assertStringIncludes(none.message, 'is not pinned')
  assertEquals(none instanceof SshNotPinned, true)
  assertEquals(real.spawned.length, 0)
  assertEquals(pinsFor(`${ALIAS} ssh-ed25519 ${ED_1}\n# c\n`, ALIAS).length, 1)
  // A key of a type that the configuration does not accept is no pin.
  assertEquals(
    pinsFor(
      `${ALIAS} ecdsa-sha2-nistp256 AAAA\n${ALIAS} ssh-rsa AAAA\n`,
      ALIAS,
    ),
    [],
  )
  await withPinsFile(
    [`${ALIAS} ecdsa-sha2-nistp256 AAAA`],
    async (knownHosts) => {
      const error = await assertRejects(
        () => open(real.spawn, knownHosts),
        SshNotPinned,
      )
      assertStringIncludes(error.message, 'is not pinned')
    },
  )
})

Deno.test('every call runs ssh as -F <config> -T target -- <the fixed command> with an environment of its own, and the key buffer is zero afterwards whether the call went well, failed, timed out or could not start', async () => {
  await withPinsFile([`${ALIAS} ssh-ed25519 ${ED_1}`], async (knownHosts) => {
    const cases: [
      string,
      () => ReturnType<SshSpawn>,
      string,
      number | null,
    ][] = [
      ['success', () => answer(0, 'New validator identity: x\n'), 'ok', 0],
      [
        'failure',
        () => answer(1, '', '\nset-identity failed\nmore\n'),
        'failed',
        1,
      ],
      ['timeout', () => answer(null, '', '', true), 'timeout', null],
    ]
    for (const [name, reply, outcome, code] of cases) {
      const fake = spawnOf(reply)
      const session = await open(fake.spawn, knownHosts)
      try {
        const key = new Uint8Array(232).fill(7)
        const result = await session.run('setIdentity', {
          stdin: key,
          flag: 'require-tower',
        })
        assertEquals(result.outcome, outcome, name)
        assertEquals(result.code, code, name)
        assertEquals(key.every((byte) => byte === 0), true, `${name}: not zero`)
        assertEquals(fake.spawned.length, 1)
        const [call] = fake.spawned
        assertEquals(call.args.length, 6)
        assert(call.args[1].endsWith('/ssh_config'))
        assertEquals([call.args[0], ...call.args.slice(2)], [
          '-F',
          '-T',
          'target',
          '--',
          remoteCommands.setIdentity('require-tower'),
        ])
        assertEquals(call.stdinLength, 232)
        // Only these names reach ssh, and none that carries a secret or a program.
        assertEquals(call.env, {
          HOME: '/home/op',
          PATH: '/usr/bin:/bin',
          USER: 'op',
          LANG: 'C.UTF-8',
          TMPDIR: '/tmp',
        })
        assertEquals(fake.checks[0].args.slice(2), ['-G', 'target'])
        if (name === 'failure') {
          assertEquals(result.stderrLine, 'set-identity failed')
        }
      } finally {
        await session.close()
      }
    }

    const broken = spawnOf(() => Promise.reject(new Error('cannot start ssh')))
    const session = await open(broken.spawn, knownHosts)
    try {
      const key = new Uint8Array(232).fill(7)
      await assertRejects(
        () => session.run('setIdentity', { stdin: key }),
        Error,
        'cannot start ssh',
      )
      assertEquals(
        key.every((byte) => byte === 0),
        true,
        'not zero after a throw',
      )
    } finally {
      await session.close()
    }
  })
})

Deno.test('a canary key sent on stdin is in no argument, environment, configuration file, result or message, and the spawn saw it exactly once', async () => {
  await withPinsFile([`${ALIAS} ssh-ed25519 ${ED_1}`], async (knownHosts) => {
    const canary = new TextEncoder().encode(
      '[157,97,177,157,239,253,90,96,186,132,74,244,146,236,44,196,68,73,197,105,123,50,105,25,112,59,172,3,28,174,127,96]',
    )
    const text = new TextDecoder().decode(canary)
    const seen: string[] = []
    const fake = spawnOf((spawned) => {
      assertEquals(spawned.stdin, canary)
      seen.push('stdin')
      return answer(0, 'New validator identity: x\n', 'a message\n')
    }, { copyStdin: true })
    const session = await open(fake.spawn, knownHosts)
    try {
      const result = await session.run('setIdentity', { stdin: canary.slice() })
      assertEquals(seen, ['stdin'])
      const everything = JSON.stringify([
        fake.checks.map((c) => [c.args, c.env, c.stdinLength]),
        fake.spawned.map((c) => [c.args, c.env, c.stdinLength]),
        result,
      ])
      assertEquals(everything.includes(text), false)
      assertEquals(everything.includes('157,97,177'), false)
      // The configuration file holds no secret either.
      const configPath = fake.spawned[0].args[1]
      assertEquals((await Deno.readTextFile(configPath)).includes('157'), false)
      const files = [
        ...Deno.readDirSync(configPath.replace(/\/ssh_config$/, '')),
      ]
      assertEquals(files.map((f) => f.name), ['ssh_config'])
    } finally {
      await session.close()
    }
  })
})

Deno.test('each named call is one of the fixed commands, and closing the session removes its configuration', async () => {
  await withPinsFile([`${ALIAS} ssh-ed25519 ${ED_1}`], async (knownHosts) => {
    const fake = spawnOf(() => answer(0, 'out'))
    const session = await open(fake.spawn, knownHosts)
    const configPath = fake.checks[0].args[1]
    await session.run('alive')
    await session.run('guardContactInfo')
    await session.run('unstakedPubkey')
    await session.run('setIdentity', { stdin: new Uint8Array([1]) })
    await session.run('setIdentity', {
      stdin: new Uint8Array([1]),
      flag: 'do-not-require-vote-history',
    })
    await session.run('setUnstaked')
    await session.run('authorizedVoterAdd', { stdin: new Uint8Array([1]) })
    assertEquals(fake.spawned.map((call) => call.args[5]), [
      remoteCommands.alive,
      remoteCommands.guardContactInfo,
      remoteCommands.unstakedPubkey,
      remoteCommands.setIdentity('none'),
      remoteCommands.setIdentity('do-not-require-vote-history'),
      remoteCommands.setUnstaked,
      remoteCommands.authorizedVoterAdd,
    ])
    assertEquals(
      fake.spawned.map((call) => call.stdinLength),
      [null, null, null, 1, 1, null, 1],
    )
    assertEquals((await Deno.stat(configPath)).isFile, true)
    await session.close()
    await assertRejects(() => Deno.stat(configPath), Deno.errors.NotFound)
  })
})

Deno.test('a path with a character that ssh would read as something else is not written into the configuration', () => {
  for (
    const target of [
      { ...TARGET, identityFile: '/home/op/my key' },
      { ...TARGET, identityFile: '/home/op/%d/key' },
      { ...TARGET, identityAgent: '/tmp/a\nProxyCommand id' },
    ]
  ) {
    try {
      buildSshConfig(target, '/home/op/.slv/known_hosts')
      throw new Error('a configuration was written')
    } catch (error) {
      assert(error instanceof SshRefusal)
    }
  }
  assertEquals(
    buildSshConfig(TARGET, '/home/op/.slv/known_hosts').includes('\n\n'),
    false,
  )
})
