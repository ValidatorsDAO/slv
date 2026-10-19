import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from '@std/assert'
import { parse, stringify } from '@std/yaml'
import {
  ValidatorMainnetConfigSchema,
  ValidatorTestnetConfigSchema,
} from '@cmn/zod/config.ts'
import {
  ALLOWED_VARS,
  CONNECTION_VARS,
  InventoryRefusal,
  PLAYBOOK_VARS,
  prepareSafeInventory,
  type SafeInventoryDeps,
  type SafeInventoryInput,
} from '/lib/ansible/safeInventory.ts'
import { findExecutable } from '/lib/secret/opCli.ts'

const IDENTITY = '586Z7H2vpX9qNhN2T4e9Utugie3ogjbxzGaMtM3E6HR5'
const OTHER_IDENTITY = 'FVen3X669xLzsi6N2V91DoiyzHzg1uAgqiT8jZ9nS96Z'
const VOTE = 'Vote111111111111111111111111111111111111111'

/** A host of the inventory as slv writes it, with keys that a run does not need. */
const GOOD: Record<string, unknown> = {
  name: 'node-1',
  ansible_host: '203.0.113.7',
  ansible_port: 2222,
  ansible_user: 'solv',
  ansible_ssh_private_key_file: '~/.ssh/node_ed25519',
  identity_account: IDENTITY,
  vote_account: VOTE,
  authority_account: OTHER_IDENTITY,
  validator_type: 'agave',
  port_rpc: 8899,
  snapshot_url: 'https://snapshots.example/snapshot.tar.zst',
  commission_bps: 500,
  relayer_url: 'http://relayer.example',
  identity_ref:
    'op://abcdefghijklmnopqrstuvwxyz/a1b2c3d4e5f6g7h8i9j0k1l2m3/keypair',
}

const inventoryOf = (
  hosts: Record<string, Record<string, unknown>>,
  group = 'testnet_validators',
): string =>
  // JSON drops the keys whose value is undefined, which YAML cannot hold.
  stringify(
    JSON.parse(
      JSON.stringify({ [group]: { hosts, vars: { solana_cli: 'agave' } } }),
    ),
  )

const input = (
  changes: Record<string, unknown> = {},
  overrides: Partial<SafeInventoryInput> = {},
): SafeInventoryInput => ({
  group: 'testnet_validators',
  inventoryText: inventoryOf({
    'node-1': { ...GOOD, ...changes },
    'node-2': {
      ...GOOD,
      name: 'node-2',
      ansible_host: '203.0.113.8',
      ansible_port: undefined,
    },
    'node-3': { ...GOOD, name: 'node-3', identity_account: OTHER_IDENTITY },
  }),
  hosts: ['node-1'],
  homeDir: '/home/op',
  identityAgent: null,
  parentEnv: { PATH: '/usr/bin:/bin', HOME: '/home/op' },
  ...overrides,
})

/** Deps that make no directory and write no file, and say so. */
const idle = () => {
  const calls: string[] = []
  const deps: SafeInventoryDeps = {
    makeDir: () => {
      calls.push('makeDir')
      return Promise.resolve('/tmp/slv-run-test')
    },
    writeFile: () => {
      calls.push('writeFile')
      return Promise.resolve()
    },
    removeDir: () => {
      calls.push('removeDir')
      return Promise.resolve()
    },
    random: () => new Uint8Array(16),
  }
  return { calls, deps }
}

Deno.test('a value that ansible would template, a variable that changes how it connects, a newline and a % in the key path are each refused, and no directory is made', async () => {
  const lookup = "{{ lookup('pipe', 'id') }}"
  const cases: [string, Record<string, unknown>, string][] = [
    ['a lookup in ansible_host', { ansible_host: lookup }, 'ansible_host'],
    [
      'a lookup in identity_account',
      { identity_account: lookup },
      'identity_account',
    ],
    ['a lookup in vote_account', { vote_account: lookup }, 'vote_account'],
    ['a lookup in identity_ref', { identity_ref: lookup }, 'identity_ref'],
    ['a lookup in no_voting', { no_voting: lookup }, 'no_voting'],
    ['a reference with a newline', {
      identity_ref: `${GOOD.identity_ref}\nextra`,
    }, 'identity_ref'],
    ['a reference with a template comment', {
      identity_ref: `op://{#comment#}/item/keypair`,
    }, 'identity_ref'],
    [
      'a malformed reference',
      { identity_ref: 'op://vault/item/keypair' },
      'identity_ref',
    ],
    [
      'a non-reference string',
      { identity_ref: 'not-a-reference' },
      'identity_ref',
    ],
    ['a numeric reference', { identity_ref: 123 }, 'identity_ref'],
    ['a null reference', { identity_ref: null }, 'identity_ref'],
    [
      'an object reference',
      { identity_ref: { keypair: 'fixture' } },
      'identity_ref',
    ],
    ...[null, 'true', 'false', 'yes', 0, 1, [], {}].map((
      value,
    ): [string, Record<string, unknown>, string] => [
      `a non-boolean no_voting ${JSON.stringify(value)}`,
      { no_voting: value },
      'no_voting',
    ]),
    [
      'a lookup in validator_type',
      { validator_type: lookup },
      'validator_type',
    ],
    ['a lookup in port_rpc', { port_rpc: lookup }, 'port_rpc'],
    [
      'a lookup in the key path',
      { ansible_ssh_private_key_file: lookup },
      'ansible_ssh_private_key_file',
    ],
    [
      '{% in a value',
      { vote_account: `{% if 1 %}${VOTE}{% endif %}` },
      'vote_account',
    ],
    ['{# in a value', { vote_account: `{#${VOTE}#}` }, 'vote_account'],
    ['ansible_python_interpreter', {
      ansible_python_interpreter: '/tmp/python',
    }, 'ansible_python_interpreter'],
    [
      'another interpreter',
      { ansible_perl_interpreter: '/tmp/perl' },
      'ansible_perl_interpreter',
    ],
    ['ansible_ssh_common_args', {
      ansible_ssh_common_args: '-oProxyCommand=id',
    }, 'ansible_ssh_common_args'],
    [
      'ansible_ssh_extra_args',
      { ansible_ssh_extra_args: '-oProxyCommand=id' },
      'ansible_ssh_extra_args',
    ],
    [
      'ansible_ssh_executable',
      { ansible_ssh_executable: '/tmp/ssh' },
      'ansible_ssh_executable',
    ],
    [
      'ansible_connection',
      { ansible_connection: 'local' },
      'ansible_connection',
    ],
    [
      'ansible_become_exe',
      { ansible_become_exe: '/tmp/sudo' },
      'ansible_become_exe',
    ],
    [
      'a newline in ansible_host',
      { ansible_host: '203.0.113.7\nHost *' },
      'ansible_host',
    ],
    [
      'a newline in vote_account',
      { vote_account: `${VOTE}\nx` },
      'vote_account',
    ],
    ['a control character', { vote_account: `${VOTE}\u0007` }, 'vote_account'],
    ['a space in a value', { ansible_host: '203.0.113.7 x' }, 'ansible_host'],
    [
      'a % in the key path',
      { ansible_ssh_private_key_file: '/keys/%d' },
      'ansible_ssh_private_key_file',
    ],
    [
      'a relative key path',
      { ansible_ssh_private_key_file: 'keys/node' },
      'ansible_ssh_private_key_file',
    ],
    ['a user that is not solv', { ansible_user: 'root' }, 'ansible_user'],
    ['a port above 65535', { ansible_port: 65536 }, 'ansible_port'],
    ['a port_rpc that is no port', { port_rpc: 70000 }, 'port_rpc'],
    [
      'an identity that is no public key',
      { identity_account: 'nope' },
      'identity_account',
    ],
    [
      'a vote account that is no public key',
      { vote_account: 'nope' },
      'vote_account',
    ],
    [
      'a type that is none of the types',
      { validator_type: 'solana' },
      'validator_type',
    ],
    ['no type', { validator_type: undefined }, 'validator_type'],
  ]
  for (const [name, change, mention] of cases) {
    const { calls, deps } = idle()
    const error = await assertRejects(
      () => prepareSafeInventory(input(change), deps),
      InventoryRefusal,
      undefined,
      name,
    )
    assertStringIncludes(error.message, mention, name)
    assertEquals(calls, [], `${name}: something was made`)
  }

  // And the choice of hosts.
  for (
    const [name, hosts, mention] of [
      ['no host', [], 'no host'],
      ['a host twice', ['node-1', 'node-1'], 'twice'],
      [
        'a host that is not in the inventory',
        ['node-9'],
        'not a host of testnet_validators',
      ],
      [
        'a name that ansible would template',
        ["{{ lookup('pipe', 'id') }}"],
        'a host name of the run',
      ],
      ['a name with a newline', ['node-1\nHost *'], 'a host name of the run'],
    ] as [string, string[], string][]
  ) {
    const { calls, deps } = idle()
    const error = await assertRejects(
      () => prepareSafeInventory(input({}, { hosts }), deps),
      InventoryRefusal,
      undefined,
      name,
    )
    assertStringIncludes(error.message, mention, name)
    assertEquals(calls, [], name)
  }
  const { calls, deps } = idle()
  await assertRejects(
    () => prepareSafeInventory(input({}, { inventoryText: 'a: [' }), deps),
    InventoryRefusal,
    'not valid YAML',
  )
  assertEquals(calls, [])
})

Deno.test('valid hosts give the allowlisted variables and no others, the key path made absolute, the unselected hosts and the group variables left out', async () => {
  const safe = await prepareSafeInventory(
    input({}, { hosts: ['node-1', 'node-2'] }),
  )
  try {
    const generated = parse(
      await Deno.readTextFile(safe.inventoryPath),
    ) as Record<string, unknown>
    assertEquals(generated, {
      testnet_validators: {
        hosts: {
          'node-1': {
            ansible_host: '203.0.113.7',
            ansible_port: 2222,
            ansible_user: 'solv',
            ansible_ssh_private_key_file: '/home/op/.ssh/node_ed25519',
            identity_account: IDENTITY,
            identity_ref: GOOD.identity_ref,
            vote_account: VOTE,
            validator_type: 'agave',
            port_rpc: 8899,
          },
          // A port that the inventory does not give is not invented.
          'node-2': {
            ansible_host: '203.0.113.8',
            ansible_user: 'solv',
            ansible_ssh_private_key_file: '/home/op/.ssh/node_ed25519',
            identity_account: IDENTITY,
            identity_ref: GOOD.identity_ref,
            vote_account: VOTE,
            validator_type: 'agave',
            port_rpc: 8899,
          },
        },
      },
    })
    for (
      const host of Object.values(
        (generated.testnet_validators as { hosts: Record<string, object> })
          .hosts,
      )
    ) {
      for (const key of Object.keys(host)) {
        assert(ALLOWED_VARS.includes(key), `${key} is not allowlisted`)
      }
    }
    // The checked facts go to the ssh configuration and the prompt.
    assertEquals(safe.hosts.map((host) => host.target.alias), [
      '[203.0.113.7]:2222',
      '[203.0.113.8]:22',
    ])
    assertEquals(safe.hosts[0].voteAccount, VOTE)
    assertEquals(safe.hosts[0].portRpc, 8899)
  } finally {
    await safe.remove()
  }

  // A mainnet group is read from the mainnet group, and a host without a vote account or port_rpc has neither.
  const bare = { ...GOOD, vote_account: undefined, port_rpc: undefined }
  const mainnet = await prepareSafeInventory({
    ...input(),
    group: 'mainnet_validators',
    inventoryText: inventoryOf({ 'node-1': bare }, 'mainnet_validators'),
  })
  try {
    const generated = parse(await Deno.readTextFile(mainnet.inventoryPath)) as {
      mainnet_validators: { hosts: Record<string, Record<string, unknown>> }
    }
    assertEquals(
      Object.keys(generated.mainnet_validators.hosts['node-1']).sort(),
      [
        'ansible_host',
        'ansible_port',
        'ansible_ssh_private_key_file',
        'ansible_user',
        'identity_account',
        'identity_ref',
        'validator_type',
      ],
    )
  } finally {
    await mainnet.remove()
  }
})

Deno.test('activation policy survives safe inventory serialization without boolean coercion or invented legacy fields', async () => {
  for (const group of ['testnet_validators', 'mainnet_validators'] as const) {
    const hosts = {
      bootstrap: { ...GOOD, no_voting: true, vote_account: '' },
      vault: { ...GOOD, no_voting: false },
      file: {
        ...GOOD,
        no_voting: false,
        identity_ref: 'file:///tmp/fixture-identity.json',
      },
      legacy: { ...GOOD, identity_ref: undefined },
      empty: { ...GOOD, identity_ref: '' },
    }
    const safe = await prepareSafeInventory(input({}, {
      group,
      inventoryText: inventoryOf(hosts, group),
      hosts: Object.keys(hosts),
    }))
    try {
      const generated = parse(
        await Deno.readTextFile(safe.inventoryPath),
      ) as Record<
        string,
        { hosts: Record<string, Record<string, unknown>> }
      >
      const saved = generated[group].hosts
      assertEquals(saved.bootstrap.no_voting, true)
      assertEquals(saved.bootstrap.identity_ref, GOOD.identity_ref)
      assertEquals(saved.bootstrap.vote_account, undefined)
      assertEquals(saved.vault.no_voting, false)
      assertEquals(saved.vault.identity_ref, GOOD.identity_ref)
      assertEquals(saved.file.no_voting, false)
      assertEquals(saved.file.identity_ref, hosts.file.identity_ref)
      assertEquals(Object.hasOwn(saved.legacy, 'no_voting'), false)
      assertEquals(Object.hasOwn(saved.legacy, 'identity_ref'), false)
      assertEquals(saved.empty.identity_ref, '')
      assertEquals(Object.hasOwn(saved.empty, 'no_voting'), false)
    } finally {
      await safe.remove()
    }
  }
})

Deno.test('the directory of a run is private and holds the inventory, ansible.cfg and run.nonce and nothing else; ansible runs in it with ANSIBLE_CONFIG on its ansible.cfg and no other ANSIBLE_* variable', async () => {
  const parentEnv = {
    PATH: '/usr/bin:/bin',
    HOME: '/home/op',
    SSH_AUTH_SOCK: '/tmp/agent.sock',
    ANSIBLE_CONFIG: '/tmp/evil/ansible.cfg',
    ANSIBLE_LIBRARY: '/tmp/evil/modules',
    ANSIBLE_LOOKUP_PLUGINS: '/tmp/evil/lookups',
    ANSIBLE_STDOUT_CALLBACK: 'evil',
    ansible_python_interpreter: '/tmp/evil/python',
  }
  const safe = await prepareSafeInventory(input({}, { parentEnv }))
  try {
    assertEquals((await Deno.stat(safe.runDir)).mode! & 0o777, 0o700)
    assertEquals(
      [...Deno.readDirSync(safe.runDir)].map((entry) => entry.name).sort(),
      ['ansible.cfg', 'inventory.yml', 'run.nonce'],
    )
    for (const path of [safe.inventoryPath, safe.configPath, safe.noncePath]) {
      assertEquals((await Deno.stat(path)).mode! & 0o777, 0o600, path)
    }
    assertEquals(safe.cwd, safe.runDir)
    assertEquals(safe.inventoryPath, `${safe.runDir}/inventory.yml`)
    // The nonce is random, in the file, and the same one that the caller gets.
    assert(/^[0-9a-f]{32}$/.test(safe.nonce), safe.nonce)
    assertEquals(await Deno.readTextFile(safe.noncePath), safe.nonce)
    const config = await Deno.readTextFile(safe.configPath)
    assertStringIncludes(config, `inventory = ${safe.inventoryPath}`)

    // The environment: what the process had, minus every ANSIBLE_* variable, plus ANSIBLE_CONFIG.
    assertEquals(safe.env, {
      PATH: '/usr/bin:/bin',
      HOME: '/home/op',
      SSH_AUTH_SOCK: '/tmp/agent.sock',
      ANSIBLE_CONFIG: safe.configPath,
    })
    assertEquals(
      Object.keys(safe.env).filter((name) => /^ansible_/i.test(name)),
      ['ANSIBLE_CONFIG'],
    )
  } finally {
    await safe.remove()
  }
  await assertRejects(() => Deno.stat(safe.runDir), Deno.errors.NotFound)

  // Two runs get two directories and two nonces.
  const first = await prepareSafeInventory(input())
  const second = await prepareSafeInventory(input())
  try {
    assert(first.runDir !== second.runDir)
    assert(first.nonce !== second.nonce)
  } finally {
    await first.remove()
    await second.remove()
  }
})

Deno.test('the environment of a run has no variable of 1Password: OP_SESSION_*, OP_SERVICE_ACCOUNT_TOKEN, OP_CONNECT_* and every other OP_* of the process are left out, and the ssh agent socket and the rest are kept', async () => {
  const canaries = {
    OP_SESSION_myaccount: 'session-canary',
    OP_SERVICE_ACCOUNT_TOKEN: 'ops_token_canary',
    OP_CONNECT_HOST: 'http://connect:8080',
    OP_CONNECT_TOKEN: 'connect-token-canary',
    OP_ACCOUNT: 'my.1password.com',
    OP_CACHE: 'true',
    OP_BIOMETRIC_UNLOCK_ENABLED: 'true',
    op_lower_case: 'canary',
  }
  const kept = {
    PATH: '/usr/bin:/bin',
    HOME: '/home/op',
    LANG: 'C.UTF-8',
    SSH_AUTH_SOCK: '/tmp/agent.sock',
    // These start with the letters but are not OP_ variables.
    OPENSSL_CONF: '/etc/ssl/openssl.cnf',
    OPTIND: '1',
  }
  const safe = await prepareSafeInventory(
    input({}, { parentEnv: { ...kept, ...canaries } }),
  )
  try {
    assertEquals(safe.env, { ...kept, ANSIBLE_CONFIG: safe.configPath })
    const seen = JSON.stringify(safe.env)
    for (const canary of Object.values(canaries)) {
      assertEquals(seen.includes(canary), false, canary)
    }
  } finally {
    await safe.remove()
  }
})

Deno.test('when a file of the run cannot be written, or the directory cannot hold ansible.cfg, the directory is removed again and the error is passed on', async () => {
  const removed: string[] = []
  const failing: SafeInventoryDeps = {
    makeDir: () => Promise.resolve('/tmp/slv-run-failing'),
    writeFile: (path) =>
      path.endsWith('ansible.cfg')
        ? Promise.reject(new Error('disk full'))
        : Promise.resolve(),
    removeDir: (dir) => {
      removed.push(dir)
      return Promise.resolve()
    },
    random: () => new Uint8Array(16),
  }
  await assertRejects(
    () => prepareSafeInventory(input(), failing),
    Error,
    'disk full',
  )
  assertEquals(removed, ['/tmp/slv-run-failing'])

  removed.length = 0
  const spaced: SafeInventoryDeps = {
    ...failing,
    makeDir: () => Promise.resolve('/tmp/slv run'),
    writeFile: () => Promise.resolve(),
  }
  await assertRejects(
    () => prepareSafeInventory(input(), spaced),
    InventoryRefusal,
    'cannot hold the files of a run',
  )
  assertEquals(removed, ['/tmp/slv run'])
})

// ---------------------------------------------------------------------------
// The variables the identity playbooks read
// ---------------------------------------------------------------------------

const ANSIBLE_DIR = new URL(
  '../../../template/latest/ansible/',
  import.meta.url,
)

const IDENTITY_PLAYBOOKS = ['mainnet-validator', 'testnet-validator'].flatMap(
  (directory) =>
    [
      'set_identity_key',
      'switch_on_identity',
      'switch_off_identity',
      'nodowntime_migrate',
    ]
      .map((name) => `${directory}/${name}.yml`),
)

/** The playbooks, and every file they import or include by a path that holds no template. */
const closureOf = (starts: string[]): Map<string, string> => {
  const texts = new Map<string, string>()
  const queue = [...starts]
  while (queue.length > 0) {
    const path = queue.pop()!
    if (texts.has(path)) continue
    let text: string
    try {
      text = Deno.readTextFileSync(new URL(path, ANSIBLE_DIR))
    } catch (_error) {
      continue
    }
    texts.set(path, text)
    const base = path.includes('/')
      ? path.slice(0, path.lastIndexOf('/') + 1)
      : ''
    for (
      const match of text.matchAll(
        /(?:import_playbook|import_tasks|include_tasks):\s*([^\s#]+)/g,
      )
    ) {
      const reference = match[1].replace(/^['"]|['"]$/g, '')
      if (reference.includes('{{')) continue
      queue.push(
        new URL(reference, new URL(base, ANSIBLE_DIR)).href.slice(
          ANSIBLE_DIR.href.length,
        ),
      )
    }
  }
  return texts
}

Deno.test('the variables of the inventory that the identity playbooks read are the ones the generated inventory carries, and the allowlist holds nothing else but what ansible needs to connect', () => {
  const texts = closureOf(IDENTITY_PLAYBOOKS)
  assert(
    texts.size >= IDENTITY_PLAYBOOKS.length,
    'the playbooks were not found',
  )
  const code = [...texts.values()].join('\n').split('\n')
    .filter((line) => !line.trim().startsWith('#')).join('\n')

  // Every key an inventory entry of a validator can have, but the words that mean something else in a playbook.
  const candidates = new Set([
    ...Object.keys(ValidatorMainnetConfigSchema.shape),
    ...Object.keys(ValidatorTestnetConfigSchema.shape),
    ...CONNECTION_VARS,
  ])
  for (const word of ['name', 'ip', 'username']) candidates.delete(word)
  const referenced = [...candidates].filter((key) =>
    new RegExp(`(?<![A-Za-z0-9_])${key}(?![A-Za-z0-9_])`).test(code)
  ).sort()

  // Whatever a playbook reads has to be in the generated inventory, and what is there for the playbooks is what they read.
  for (const key of referenced) {
    assert(
      ALLOWED_VARS.includes(key),
      `${key} is read by a playbook and is not allowlisted`,
    )
  }
  assertEquals(
    referenced.filter((key) =>
      !(CONNECTION_VARS as readonly string[]).includes(key)
    ),
    [...PLAYBOOK_VARS].filter((key) =>
      !(CONNECTION_VARS as readonly string[]).includes(key)
    ).sort(),
  )
  assertEquals(
    [...ALLOWED_VARS].sort(),
    [...new Set([...CONNECTION_VARS, ...referenced])].sort(),
  )
})

// ---------------------------------------------------------------------------
// With the ansible of this machine, when there is one
// ---------------------------------------------------------------------------

const ANSIBLE_INVENTORY = await findExecutable(
  'ansible-inventory',
  Deno.env.get('PATH'),
)
const ANSIBLE_CONFIG_TOOL = await findExecutable(
  'ansible-config',
  Deno.env.get('PATH'),
)

const run = async (
  command: string,
  args: string[],
  env: Record<string, string>,
  cwd: string,
) => {
  const out = await new Deno.Command(command, {
    args,
    env,
    clearEnv: true,
    cwd,
    stdin: 'null',
    stdout: 'piped',
    stderr: 'piped',
  }).output()
  return {
    success: out.success,
    stdout: new TextDecoder().decode(out.stdout),
    stderr: new TextDecoder().decode(out.stderr),
  }
}

Deno.test({
  name:
    'ansible reads the generated inventory as the variables that were checked, and takes its configuration from ansible.cfg of the run, not from ANSIBLE_* variables or an ansible.cfg of the home directory',
  ignore: ANSIBLE_INVENTORY === null || ANSIBLE_CONFIG_TOOL === null,
  fn: async () => {
    const home = await Deno.makeTempDir({ prefix: 'slv-ansible-home-' })
    try {
      // A configuration in the home directory and ANSIBLE_* variables that would change the run.
      await Deno.writeTextFile(
        `${home}/.ansible.cfg`,
        '[defaults]\nremote_user = evil\nlibrary = /tmp/evil-home\n',
      )
      const parentEnv = {
        PATH: Deno.env.get('PATH') ?? '/usr/bin:/bin',
        HOME: home,
        ANSIBLE_LIBRARY: '/tmp/evil-modules',
        ANSIBLE_REMOTE_USER: 'evil',
        ANSIBLE_HOST_KEY_CHECKING: 'False',
      }
      const safe = await prepareSafeInventory(
        input({}, { parentEnv, hosts: ['node-1', 'node-2'] }),
      )
      try {
        const listed = await run(
          ANSIBLE_INVENTORY!,
          ['-i', safe.inventoryPath, '--list'],
          safe.env,
          safe.cwd,
        )
        assert(listed.success, listed.stderr)
        const hostvars = JSON.parse(listed.stdout)._meta.hostvars
        assertEquals(Object.keys(hostvars).sort(), ['node-1', 'node-2'])
        assertEquals(hostvars['node-1'], {
          ansible_host: '203.0.113.7',
          ansible_port: 2222,
          ansible_user: 'solv',
          ansible_ssh_private_key_file: '/home/op/.ssh/node_ed25519',
          identity_account: IDENTITY,
          identity_ref: GOOD.identity_ref,
          vote_account: VOTE,
          validator_type: 'agave',
          port_rpc: 8899,
        })

        const changed = await run(
          ANSIBLE_CONFIG_TOOL!,
          ['dump', '--only-changed'],
          safe.env,
          safe.cwd,
        )
        assert(changed.success, changed.stderr)
        assertStringIncludes(changed.stdout, safe.configPath)
        for (const evil of ['evil', '/tmp/evil-modules', '/tmp/evil-home']) {
          assertEquals(
            changed.stdout.includes(evil),
            false,
            `${evil} reached the configuration`,
          )
        }
        // Positive control: with the environment as it was, the same settings do reach ansible.
        const unsafe = await run(
          ANSIBLE_CONFIG_TOOL!,
          ['dump', '--only-changed'],
          parentEnv,
          safe.cwd,
        )
        assert(unsafe.success, unsafe.stderr)
        assertStringIncludes(unsafe.stdout, '/tmp/evil-modules')
        assertStringIncludes(unsafe.stdout, 'evil')
      } finally {
        await safe.remove()
      }
    } finally {
      await Deno.remove(home, { recursive: true })
    }
  },
})
