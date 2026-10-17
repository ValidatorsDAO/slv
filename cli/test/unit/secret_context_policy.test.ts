import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
  assertThrows,
} from '@std/assert'
import { checkSecretContext, type ContextDeps } from '/lib/secret/context.ts'
import { parseIdentityRef } from '/lib/secret/identityRef.ts'
import {
  checkRefVault,
  type KeylessConfig,
  parseKeylessConfig,
  PolicyError,
  policyOf,
  readKeylessConfig,
  readServiceAccountToken,
  writeVaultId,
} from '/lib/secret/vaultPolicy.ts'

const VAULT = 'abcdefghijklmnopqrstuvwxyz'
const OTHER_VAULT = 'zyxwvutsrqponmlkjihgfedcba'
const ITEM = 'a1b2c3d4e5f6g7h8i9j0k1l2m3'
const TOKEN = 'ops_canary_token_value_1234567890'

const refIn = (vault: string) =>
  parseIdentityRef(`op://${vault}/${ITEM}/keypair`, { homeDir: '/home/op' }).ref

const withToken: KeylessConfig = {
  networks: {
    testnet: { vaultId: VAULT, tokenFile: '/home/op/.slv/op-testnet.token' },
  },
  identityAgent: null,
}
const withoutToken: KeylessConfig = {
  networks: { testnet: { vaultId: VAULT, tokenFile: null } },
  identityAgent: null,
}

/** A context that is fine: a terminal, no marker, no node, an empty environment. */
const context = (
  overrides: { env?: Record<string, string>; files?: string[]; tty?: boolean } =
    {},
): ContextDeps => {
  const env = overrides.env ?? {}
  return {
    env: (name) => env[name],
    envNames: () => Object.keys(env),
    exists: (path) => Promise.resolve((overrides.files ?? []).includes(path)),
    canOpenTty: () => Promise.resolve(overrides.tty ?? true),
  }
}

Deno.test('the context refuses a read without a terminal, from the AI console, on a machine marked or run as a node, and on mainnet with a service account token configured or in the environment', async () => {
  const refusals: [
    string,
    'testnet' | 'mainnet',
    KeylessConfig,
    Parameters<typeof context>[0],
    string,
  ][] = [
    ['no terminal', 'testnet', withToken, { tty: false }, '/dev/tty'],
    [
      'the AI console',
      'testnet',
      withToken,
      { env: { SLV_EXECUTION_CONTEXT: 'ai-console' } },
      'AI console',
    ],
    [
      'the marker of a machine that resolves nothing',
      'testnet',
      withToken,
      { files: ['/etc/slv/no-op-resolution'] },
      'no-op-resolution',
    ],
    [
      'a node by its unstaked key',
      'testnet',
      withToken,
      { files: ['/home/solv/unstaked-identity.json'] },
      'is a node',
    ],
    [
      'a node by its service',
      'testnet',
      withToken,
      { files: ['/etc/systemd/system/solv.service'] },
      'is a node',
    ],
    ['mainnet with the token configured', 'mainnet', withToken, {}, 'mainnet'],
    [
      'mainnet with a service account token in the environment',
      'mainnet',
      withoutToken,
      { env: { OP_SERVICE_ACCOUNT_TOKEN: TOKEN } },
      'mainnet',
    ],
    [
      'mainnet with a Connect token in the environment',
      'mainnet',
      withoutToken,
      { env: { OP_CONNECT_TOKEN: TOKEN } },
      'mainnet',
    ],
    [
      'mainnet with a Connect host in the environment',
      'mainnet',
      withoutToken,
      { env: { OP_CONNECT_HOST: 'http://connect:8080' } },
      'mainnet',
    ],
    [
      'mainnet with a session of 1Password in the environment',
      'mainnet',
      withoutToken,
      { env: { OP_SESSION_myaccount: TOKEN } },
      'mainnet',
    ],
    [
      'an ssh session without a service account',
      'testnet',
      withoutToken,
      { env: { SSH_CONNECTION: '203.0.113.9 5555 203.0.113.10 22' } },
      'over ssh',
    ],
    [
      'an ssh terminal without a service account',
      'testnet',
      withoutToken,
      { env: { SSH_TTY: '/dev/pts/3' } },
      'over ssh',
    ],
    [
      'biometric unlock switched off without a service account',
      'testnet',
      withoutToken,
      { env: { OP_BIOMETRIC_UNLOCK_ENABLED: 'false' } },
      'OP_BIOMETRIC_UNLOCK_ENABLED',
    ],
  ]
  for (const [name, network, config, overrides, expected] of refusals) {
    const reason = await checkSecretContext(network, config, context(overrides))
    assert(reason !== null, name)
    assertStringIncludes(reason, expected, name)
    assertEquals(reason.includes(TOKEN), false, name)
  }

  // What is fine: a terminal; an ssh session or no biometrics where a service
  // account is configured; mainnet in a clean environment.
  for (
    const [name, network, config, overrides] of [
      ['a terminal', 'testnet', withToken, {}],
      [
        'an ssh session with a service account',
        'testnet',
        withToken,
        { env: { SSH_CONNECTION: '203.0.113.9 5555 203.0.113.10 22' } },
      ],
      [
        'biometrics off with a service account',
        'testnet',
        withToken,
        { env: { OP_BIOMETRIC_UNLOCK_ENABLED: 'false' } },
      ],
      ['mainnet with no token anywhere', 'mainnet', withoutToken, {}],
    ] as const
  ) {
    assertEquals(
      await checkSecretContext(network, config, context(overrides)),
      null,
      name,
    )
  }
})

Deno.test('a reference to a vault that is not the configured one is refused, and so is one when no vault is configured; a file reference has no vault', () => {
  const policy = policyOf(withoutToken, 'testnet')
  checkRefVault(refIn(VAULT), policy, 'testnet')
  checkRefVault(
    parseIdentityRef('file:///home/op/key.json', { homeDir: '/home/op' }).ref,
    policy,
    'testnet',
  )
  const wrong = assertThrows(
    () => checkRefVault(refIn(OTHER_VAULT), policy, 'testnet'),
    PolicyError,
  )
  assertStringIncludes(wrong.message, 'not the vault configured for testnet')
  assertEquals(wrong.message.includes(OTHER_VAULT), false)
  const none = assertThrows(
    () =>
      checkRefVault(refIn(VAULT), policyOf(withoutToken, 'devnet'), 'devnet'),
    PolicyError,
  )
  assertStringIncludes(none.message, 'no vault is configured for devnet')
})

Deno.test('the service account token file has to be a regular file of mode 0600 that belongs to the user, and nothing said about it holds the token', async () => {
  const dir = await Deno.makeTempDir({ prefix: 'slv-token-' })
  try {
    const file = `${dir}/op-testnet.token`
    await Deno.writeTextFile(file, `${TOKEN}\n`, { mode: 0o600 })
    await Deno.chmod(file, 0o600)
    assertEquals(await readServiceAccountToken(file), TOKEN)

    for (const mode of [0o644, 0o640, 0o660, 0o400, 0o700]) {
      await Deno.chmod(file, mode)
      const error = await assertRejects(
        () => readServiceAccountToken(file),
        PolicyError,
        'mode 0600',
      )
      assertEquals(error.message.includes(TOKEN), false)
    }
    await Deno.chmod(file, 0o600)

    // Not the user's own file.
    const other = await assertRejects(
      () =>
        readServiceAccountToken(file, {
          readText: (path) => Deno.readTextFile(path),
          lstat: async (path) => {
            const info = await Deno.lstat(path)
            return {
              isFile: info.isFile,
              isSymlink: info.isSymlink,
              mode: info.mode,
              uid: info.uid,
            }
          },
          uid: () => 0,
        }),
      PolicyError,
      'belong to the user',
    )
    assertEquals(other.message.includes(TOKEN), false)

    // A link, a directory, an empty file, a file that is not there.
    await Deno.symlink(file, `${dir}/link.token`)
    await assertRejects(
      () => readServiceAccountToken(`${dir}/link.token`),
      PolicyError,
      'not a link',
    )
    await assertRejects(() => readServiceAccountToken(dir), PolicyError)
    await Deno.writeTextFile(`${dir}/empty.token`, '\n', { mode: 0o600 })
    await Deno.chmod(`${dir}/empty.token`, 0o600)
    await assertRejects(
      () => readServiceAccountToken(`${dir}/empty.token`),
      PolicyError,
      'empty',
    )
    await assertRejects(
      () => readServiceAccountToken(`${dir}/missing.token`),
      PolicyError,
      'cannot be read',
    )
  } finally {
    await Deno.remove(dir, { recursive: true })
  }
})

Deno.test('keyless.yml is read as documented, whatever else is in it is refused by its name, and no file means no settings', async () => {
  const config = parseKeylessConfig(`networks:
  testnet:
    vault_id: ${VAULT}
    service_account_token_file: /home/op/.slv/op-testnet.token
ssh:
  identity_agent: /home/op/.1password/agent.sock
`)
  assertEquals(config, {
    networks: {
      testnet: {
        vaultId: VAULT,
        tokenFile: '/home/op/.slv/op-testnet.token',
      },
    },
    identityAgent: '/home/op/.1password/agent.sock',
  })
  assertEquals(policyOf(config, 'mainnet'), { vaultId: null, tokenFile: null })

  const bad: [string, string, string][] = [
    ['an unknown key', 'tokens:\n  testnet: x\n', 'unknown key "tokens"'],
    ['an unknown network', 'networks:\n  stagenet: {}\n', '"stagenet"'],
    [
      'an unknown key of a network',
      'networks:\n  testnet:\n    token: x\n',
      'unknown key "token"',
    ],
    [
      'a vault name for the id',
      'networks:\n  testnet:\n    vault_id: slv-validators\n',
      'vault_id',
    ],
    [
      'a relative token file',
      'networks:\n  testnet:\n    service_account_token_file: op.token\n',
      'absolute path',
    ],
    [
      'a token file with ..',
      'networks:\n  testnet:\n    service_account_token_file: /home/op/../x\n',
      'absolute path',
    ],
    [
      'a relative agent socket',
      'ssh:\n  identity_agent: agent.sock\n',
      'absolute path',
    ],
    ['text that is no YAML', 'networks: [\n', 'not valid YAML'],
    ['a list', '- testnet\n', 'has to be a mapping'],
  ]
  for (const [name, text, expected] of bad) {
    const error = assertThrows(
      () => parseKeylessConfig(text),
      PolicyError,
      undefined,
      name,
    )
    assertStringIncludes(error.message, expected, name)
  }
  assertEquals(parseKeylessConfig(''), { networks: {}, identityAgent: null })
  assertEquals(
    await readKeylessConfig('/nonexistent/keyless.yml', {
      readText: () => Promise.resolve(null),
    }),
    { networks: {}, identityAgent: null },
  )
})

Deno.test('the vault id is written into keyless.yml with mode 0600, keeps what is in it, and is not written over a file that is refused', async () => {
  const dir = await Deno.makeTempDir({ prefix: 'slv-keyless-' })
  try {
    const path = `${dir}/.slv/keyless.yml`
    await writeVaultId('testnet', VAULT, path)
    assertEquals(
      (await readKeylessConfig(path)).networks.testnet,
      { vaultId: VAULT, tokenFile: null },
    )
    assertEquals((await Deno.stat(path)).mode! & 0o7777, 0o600)

    await Deno.writeTextFile(
      path,
      `networks:\n  testnet:\n    service_account_token_file: /home/op/t.token\nssh:\n  identity_agent: /home/op/a.sock\n`,
      { mode: 0o600 },
    )
    await writeVaultId('testnet', OTHER_VAULT, path)
    assertEquals(await readKeylessConfig(path), {
      networks: {
        testnet: { vaultId: OTHER_VAULT, tokenFile: '/home/op/t.token' },
      },
      identityAgent: '/home/op/a.sock',
    })

    // A file that would be refused is left as it is.
    await Deno.writeTextFile(path, 'tokens: x\n', { mode: 0o600 })
    await assertRejects(() => writeVaultId('testnet', VAULT, path), PolicyError)
    assertEquals(await Deno.readTextFile(path), 'tokens: x\n')
    await assertRejects(
      () => writeVaultId('testnet', 'a vault name', path),
      PolicyError,
    )
  } finally {
    await Deno.remove(dir, { recursive: true })
  }
})
