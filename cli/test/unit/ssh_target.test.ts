import { assertEquals, assertRejects, assertThrows } from '@std/assert'
import {
  inventoryAccounts,
  readSshTarget,
  validatorGroup,
} from '/lib/ssh/inventoryTarget.ts'
import { parseSshTarget, TargetError } from '/lib/ssh/sshTarget.ts'

const IDENTITY = '586Z7H2vpX9qNhN2T4e9Utugie3ogjbxzGaMtM3E6HR5'
const VOTE = 'FVen3X669xLzsi6N2V91DoiyzHzg1uAgqiT8jZ9nS96Z'

const host = (fields: Record<string, string>): string =>
  `testnet_validators:\n  hosts:\n    node-1:\n${
    Object.entries(fields).map(([key, value]) => `      ${key}: ${value}\n`)
      .join(
        '',
      )
  }`

const GOOD: Record<string, string> = {
  ansible_host: '203.0.113.7',
  ansible_port: '2222',
  ansible_user: 'solv',
  ansible_ssh_private_key_file: '~/.ssh/node_ed25519',
  identity_account: IDENTITY,
  vote_account: VOTE,
  validator_type: 'agave',
}

const options = { homeDir: '/home/op', identityAgent: null }

const parse = (fields: Record<string, string>) =>
  parseSshTarget(host(fields), 'testnet_validators', 'node-1', options)

Deno.test('a host of the inventory becomes the facts ssh needs, with the key path of ~/ made absolute, and the alias the pin is kept under', () => {
  assertEquals(parse(GOOD), {
    name: 'node-1',
    host: '203.0.113.7',
    port: 2222,
    user: 'solv',
    identityFile: '/home/op/.ssh/node_ed25519',
    identityAgent: null,
    alias: '[203.0.113.7]:2222',
    identityAccount: IDENTITY,
    validatorType: 'agave',
  })
  const bare = { ...GOOD }
  delete bare.ansible_port
  delete bare.validator_type
  const target = parseSshTarget(
    host({ ...bare, ansible_ssh_private_key_file: '/keys/node_1.pem' }),
    'testnet_validators',
    'node-1',
    { homeDir: '/home/op', identityAgent: '/home/op/.1password/agent.sock' },
  )
  assertEquals(target.port, 22)
  assertEquals(target.alias, '[203.0.113.7]:22')
  assertEquals(target.identityFile, '/keys/node_1.pem')
  assertEquals(target.identityAgent, '/home/op/.1password/agent.sock')
  assertEquals(target.validatorType, '')
})

Deno.test('a host name or an IPv6 address with capitals becomes the lower-case text that ssh uses, in the host and in the alias of the pin', () => {
  for (
    const [written, host] of [
      ['Node-1.Example.com', 'node-1.example.com'],
      ['2001:DB8::ABCD', '2001:db8::abcd'],
      ['203.0.113.7', '203.0.113.7'],
    ]
  ) {
    const target = parse({ ...GOOD, ansible_host: written })
    assertEquals(target.host, host, written)
    assertEquals(target.alias, `[${host}]:2222`, written)
  }
})

Deno.test('a host that could make ssh or ansible run something else is refused, one case for each way in', () => {
  const cases: [string, Record<string, string>, string][] = [
    [
      'a template in the address',
      { ansible_host: `"{{ lookup('pipe', 'id') }}"` },
      'ansible_host',
    ],
    [
      'a command substitution in the address',
      { ansible_host: '"$(id)"' },
      'ansible_host',
    ],
    ['an option for ssh in the address', {
      ansible_host: '"-oProxyCommand=id"',
    }, 'ansible_host'],
    [
      'a newline in the address',
      { ansible_host: '"203.0.113.7\\nHost *"' },
      'ansible_host',
    ],
    [
      'a space in the address',
      { ansible_host: '"203.0.113.7 x"' },
      'ansible_host',
    ],
    [
      'a percent in the key path',
      { ansible_ssh_private_key_file: '/keys/%d' },
      'ansible_ssh_private_key_file',
    ],
    [
      'a relative key path',
      { ansible_ssh_private_key_file: 'keys/node' },
      'ansible_ssh_private_key_file',
    ],
    [
      '.. in the key path',
      { ansible_ssh_private_key_file: '/keys/../etc/x' },
      'ansible_ssh_private_key_file',
    ],
    ['a space in the key path', {
      ansible_ssh_private_key_file: '"/keys/my key"',
    }, 'ansible_ssh_private_key_file'],
    ['a user that is not solv', { ansible_user: 'root' }, 'ansible_user'],
    ['a port of 0', { ansible_port: '0' }, 'ansible_port'],
    ['a port above 65535', { ansible_port: '65536' }, 'ansible_port'],
    ['a port that is text', { ansible_port: 'ssh' }, 'ansible_port'],
    [
      'an identity that is no public key',
      { identity_account: 'nope' },
      'identity_account',
    ],
    [
      'a python interpreter',
      { ansible_python_interpreter: '/tmp/python' },
      'ansible_python_interpreter',
    ],
    [
      'common ssh arguments',
      { ansible_ssh_common_args: '-oProxyCommand=id' },
      'ansible_ssh_common_args',
    ],
    [
      'extra ssh arguments',
      { ansible_ssh_extra_args: '-oProxyCommand=id' },
      'ansible_ssh_extra_args',
    ],
    [
      'another ssh executable',
      { ansible_ssh_executable: '/tmp/ssh' },
      'ansible_ssh_executable',
    ],
    [
      'another connection',
      { ansible_connection: 'local' },
      'ansible_connection',
    ],
    [
      'become settings',
      { ansible_become_exe: '/tmp/sudo' },
      'ansible_become_exe',
    ],
  ]
  for (const [name, change, mention] of cases) {
    const error = assertThrows(
      () => parse({ ...GOOD, ...change }),
      TargetError,
      undefined,
      name,
    )
    assertEquals(
      error.message.includes(mention),
      true,
      `${name}: ${error.message}`,
    )
  }
  assertThrows(
    () => parseSshTarget(host(GOOD), 'testnet_validators', 'node-2', options),
    TargetError,
    'not a host of testnet_validators',
  )
  assertThrows(
    () => parseSshTarget('a: [', 'testnet_validators', 'node-1', options),
    TargetError,
    'not valid YAML',
  )
})

Deno.test('the accounts of an inventory are every identity and vote account that its hosts name, and each network has its group', async () => {
  const text = [
    'testnet_validators:',
    '  hosts:',
    '    a:',
    `      identity_account: ${IDENTITY}`,
    `      vote_account: ${VOTE}`,
    '    b:',
    `      identity_account: ${IDENTITY}`,
    '      vote_account: not-a-key',
    '    c: {}',
    'mainnet_validators:',
    '  hosts:',
    '    d:',
    '      identity_account: Vote111111111111111111111111111111111111111',
  ].join('\n')
  assertEquals(inventoryAccounts(text, 'testnet_validators'), [IDENTITY, VOTE])
  assertEquals(inventoryAccounts(text, 'mainnet_validators'), [
    'Vote111111111111111111111111111111111111111',
  ])
  assertEquals(inventoryAccounts('', 'testnet_validators'), [])

  assertEquals(validatorGroup('testnet'), 'testnet_validators')
  assertEquals(validatorGroup('mainnet'), 'mainnet_validators')
  assertEquals(validatorGroup('devnet'), null)

  const reader = {
    readText: () => Promise.resolve(host(GOOD)),
    homeDir: '/home/op',
  }
  const read = await readSshTarget(
    'testnet',
    'node-1',
    { identityAgent: null },
    reader,
  )
  assertEquals(read.target.alias, '[203.0.113.7]:2222')
  assertEquals(read.accounts, [IDENTITY, VOTE])
  await assertRejects(
    () => readSshTarget('devnet', 'node-1', { identityAgent: null }, reader),
    TargetError,
    'no validator inventory',
  )
  await assertRejects(
    () =>
      readSshTarget('testnet', 'node-1', { identityAgent: null }, {
        readText: () => Promise.resolve(null),
        homeDir: '/home/op',
      }),
    TargetError,
    'there is no inventory file',
  )
  await assertRejects(
    () =>
      readSshTarget('testnet', 'node-1', { identityAgent: null }, {
        readText: () => Promise.resolve(host(GOOD)),
        homeDir: undefined,
      }),
    TargetError,
    'HOME is not set',
  )
})
