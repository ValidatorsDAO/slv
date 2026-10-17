import { assert, assertEquals, assertStringIncludes } from '@std/assert'
import { parse, stringify } from '@std/yaml'
import { VERSIONS_PATH } from '@cmn/constants/path.ts'
import {
  VERSION_ALLNODES_JITO_MAINNET,
  VERSION_JITO_MAINNET,
  VERSION_JITO_VALIDATOR_MAINNET,
  VERSION_JITO_VALIDATOR_TESTNET,
  VERSION_SOLANA_MAINNET,
  VERSION_SOLANA_VALIDATOR_MAINNET,
} from '@cmn/constants/version.ts'
import { CONTEXT_MODULES } from '@/ai/console/systemPrompt.ts'
import {
  defaultVersionsObject,
  defaultVersionsYml,
} from '/lib/config/defaultVersionsYml.ts'
import { updateDefaultVersion } from '/lib/config/updateDefaultVersion.ts'
import { migrateVersionsYml } from '/lib/migrate/migrateVersionsYml.ts'
import {
  buildMainnetHostEntry,
  DEFAULT_MAINNET_VALIDATOR_TYPE,
} from '/lib/addMainnetInventory.ts'
import { mainnetValidatorTypeRefusal } from '/lib/fdctlMainnetGuard.ts'

// The defaults after the Alpenglow update (slv overhaul: Alpenglow). Mainnet
// activates Alpenglow at the start of epoch 1064 and needs agave or jito built
// on Agave 4.3.0 or later; testnet and devnet already run it on 4.4.0-beta.*.
const ACCESS = { allowed_ssh_ips: [], allowed_ips: [] }
const FIREDANCER = '0.814.30108'

const MAINNET_VALIDATORS = {
  version_agave: '4.3.2',
  version_jito: '4.3.2-jito',
  version_allnodes_jito: '4.3.2-allnodes',
  version_firedancer: FIREDANCER,
  ...ACCESS,
}

const MAINNET_RPCS = {
  version_agave: '4.3.2',
  version_jito: '4.3.2-jito',
  version_firedancer: FIREDANCER,
  richat_version: 'richat-v8.2.2',
  geyser_version: 'v16.1.1+solana.4.3.0',
  ...ACCESS,
}

const TESTNET_VALIDATORS = {
  version_agave: '4.4.0-beta.1',
  version_jito: '4.4.0-beta.1-jito',
  version_allnodes_jito: '4.4.0-beta.1-allnodes',
  version_firedancer: FIREDANCER,
  ...ACCESS,
}

// The Yellowstone tag v17.0.0-rc5+solana.4.4.0.beta.0 is the build made for
// 4.4.0-beta.0, so the testnet and devnet RPC defaults stay on that client.
const TESTNET_RPCS = {
  version_agave: '4.4.0-beta.0',
  version_jito: '4.4.0-beta.0-jito',
  version_firedancer: FIREDANCER,
  richat_version: 'richat-v8.2.2',
  geyser_version: 'v17.0.0-rc5+solana.4.4.0.beta.0',
  ...ACCESS,
}

const DEVNET_RPCS = { ...TESTNET_RPCS }

const EXPECTED_DEFAULTS: Record<string, Record<string, unknown>> = {
  mainnet_validators: MAINNET_VALIDATORS,
  testnet_validators: TESTNET_VALIDATORS,
  mainnet_rpcs: MAINNET_RPCS,
  devnet_rpcs: DEVNET_RPCS,
  testnet_rpcs: TESTNET_RPCS,
}

Deno.test('default versions: mainnet validators and RPCs pin releases built on Agave 4.3', () => {
  const defaults = defaultVersionsObject()
  assertEquals(defaults.mainnet_validators, MAINNET_VALIDATORS)
  assertEquals(defaults.mainnet_rpcs, MAINNET_RPCS)
})

Deno.test('default versions: testnet validators run 4.4.0-beta.1, and the testnet and devnet RPCs stay on the 4.4.0-beta.0 their Yellowstone build is built for', () => {
  const defaults = defaultVersionsObject()
  assertEquals(defaults.testnet_validators, TESTNET_VALIDATORS)
  assertEquals(defaults.testnet_rpcs, TESTNET_RPCS)
  assertEquals(defaults.devnet_rpcs, DEVNET_RPCS)
})

Deno.test('default versions: the generated versions.yml carries the same values', () => {
  assertEquals(parse(defaultVersionsYml()), EXPECTED_DEFAULTS)
})

// The solana version a Yellowstone tag was built for:
// v16.1.1+solana.4.3.0 -> 4.3.0, v17.0.0-rc5+solana.4.4.0.beta.0 -> 4.4.0-beta.0
const builtForSolana = (yellowstoneTag: string): string => {
  const built = /\+solana\.(.+)$/.exec(yellowstoneTag)?.[1]
  assert(built, `${yellowstoneTag} does not say which solana it is built for`)
  return built.replace(/^(\d+\.\d+\.\d+)\./, '$1-')
}

// A pre-release client needs the exact build; a release also takes a plugin
// built for another patch of its minor release.
const clientTakesPlugin = (client: string, builtFor: string): boolean => {
  const core = client.replace(/-jito$/, '')
  if (core.includes('-') || builtFor.includes('-')) return core === builtFor
  return core.split('.').slice(0, 2).join('.') ===
    builtFor.split('.').slice(0, 2).join('.')
}

Deno.test('default versions: a Geyser RPC default pairs its client with a Yellowstone plugin built for it', () => {
  const defaults = defaultVersionsObject()
  for (
    const section of ['mainnet_rpcs', 'testnet_rpcs', 'devnet_rpcs'] as const
  ) {
    const rpc = defaults[section]
    const builtFor = builtForSolana(rpc.geyser_version)
    for (const client of [rpc.version_agave, rpc.version_jito]) {
      assert(
        clientTakesPlugin(client, builtFor),
        `${section}: ${client} does not take ${rpc.geyser_version}`,
      )
    }
  }
})

Deno.test('a new mainnet inventory entry defaults to the jito validator type', () => {
  assertEquals(DEFAULT_MAINNET_VALIDATOR_TYPE, 'jito')
  const entry = buildMainnetHostEntry('val-a', 'IdentityKey', {
    username: 'solv',
    ip: '203.0.113.10',
    rsa_key_path: '/keys/id_rsa',
  })
  assertEquals(entry.validator_type, 'jito')
  assertEquals(entry.name, 'val-a')
  assertEquals(entry.ansible_host, '203.0.113.10')
  assertEquals(entry.identity_account, 'IdentityKey')
  assertEquals(entry.ansible_connection, undefined)

  const local = buildMainnetHostEntry('val-l', 'IdentityKey', {
    username: 'solv',
    ip: 'localhost',
    rsa_key_path: '',
  }, true)
  assertEquals(local.ansible_connection, 'local')
  assertEquals(local.validator_type, 'jito')
})

Deno.test('the mainnet init prompt defaults to jito', async () => {
  const source = await Deno.readTextFile(
    new URL('../../src/validator/init/initMainnetConfig.ts', import.meta.url),
  )
  assertStringIncludes(source, 'default: DEFAULT_MAINNET_VALIDATOR_TYPE')
  assertEquals(source.includes("default: 'firedancer-jito'"), false)
  assertStringIncludes(source, 'refuseMainnetValidatorType(')
})

Deno.test('the mainnet validator type refusal explains unsupported types and replacements', () => {
  for (const type of ['agave', 'jito', 'allnodes-jito', '']) {
    assertEquals(mainnetValidatorTypeRefusal(type), null, type)
  }
  for (
    const type of [
      'firedancer-agave',
      'firedancer-jito',
      'firedancer',
      'frankendancer',
    ]
  ) {
    const refusal = mainnetValidatorTypeRefusal(type)
    assert(refusal !== null, type)
    for (
      const fact of [
        type,
        'Alpenglow',
        'epoch 1064',
        'mainnet',
        'not supported',
        'agave',
        'jito',
        'allnodes-jito',
        'slv v switch',
      ]
    ) assertStringIncludes(refusal, fact, type)
  }
})

// The keys updateDefaultVersion overwrites, per section.
const OVERWRITTEN_KEYS: Record<string, string[]> = {
  mainnet_validators: [
    'version_agave',
    'version_jito',
    'version_allnodes_jito',
    'version_firedancer',
  ],
  testnet_validators: [
    'version_agave',
    'version_jito',
    'version_allnodes_jito',
    'version_firedancer',
  ],
  mainnet_rpcs: [
    'version_agave',
    'version_jito',
    'version_firedancer',
    'geyser_version',
  ],
  devnet_rpcs: [
    'version_agave',
    'version_jito',
    'version_firedancer',
    'geyser_version',
  ],
  testnet_rpcs: [
    'version_agave',
    'version_jito',
    'version_firedancer',
    'geyser_version',
  ],
}

const statOrNull = async (path: string) => {
  try {
    return await Deno.stat(path)
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return null
    throw error
  }
}

Deno.test('updateDefaultVersion writes the validator constants under *_validators and the RPC constants under *_rpcs', async () => {
  const defaults = defaultVersionsObject() as unknown as Record<
    string,
    Record<string, unknown>
  >
  const stale: Record<string, Record<string, unknown>> = {}
  for (const [section, values] of Object.entries(defaults)) {
    stale[section] = Object.fromEntries(
      Object.entries(values).map((
        [key, value],
      ) => [key, Array.isArray(value) ? ['203.0.113.9'] : `stale-${key}`]),
    )
  }
  const expected = EXPECTED_DEFAULTS

  const realBefore = await statOrNull(VERSIONS_PATH)
  const dir = await Deno.makeTempDir({ prefix: 'slv-w0-versions-' })
  const path = `${dir}/versions.yml`
  try {
    await Deno.writeTextFile(path, stringify(stale))
    assertEquals(await updateDefaultVersion(path), true)
    const written = parse(await Deno.readTextFile(path)) as Record<
      string,
      Record<string, unknown>
    >

    for (const [section, keys] of Object.entries(OVERWRITTEN_KEYS)) {
      for (const key of keys) {
        assertEquals(
          written[section][key],
          expected[section][key],
          `${section}.${key} is the constant for that section`,
        )
        assertEquals(
          written[section][key],
          defaults[section][key],
          `${section}.${key} matches defaultVersionsObject()`,
        )
      }
    }
    // Keys it does not overwrite keep what the file had.
    assertEquals(written.mainnet_rpcs.richat_version, 'stale-richat_version')
    assertEquals(written.mainnet_validators.allowed_ips, ['203.0.113.9'])
  } finally {
    await Deno.remove(dir, { recursive: true })
  }

  const realAfter = await statOrNull(VERSIONS_PATH)
  assertEquals(realAfter?.mtime?.getTime(), realBefore?.mtime?.getTime())
  assertEquals(realAfter === null, realBefore === null)
})

Deno.test('upgrade:settings keeps every value pinned in versions.yml and only fills the keys that are missing', async () => {
  const dir = await Deno.makeTempDir({ prefix: 'slv-alpenglow-versions-' })
  const path = `${dir}/versions.yml`
  try {
    await Deno.writeTextFile(
      path,
      stringify({
        mainnet_validators: {
          version_agave: '4.2.2',
          version_jito: '4.2.2-jito',
          allowed_ips: ['203.0.113.7'],
          note: 'kept',
        },
        mainnet_rpcs: {
          version_agave: '3.1.10',
          version_jito: '3.1.10-jito',
          geyser_version: 'v10.1.2-rc3+solana.3.1.10',
        },
      }),
    )
    assertEquals(await migrateVersionsYml(path), true)
    const written = parse(await Deno.readTextFile(path)) as Record<
      string,
      Record<string, unknown>
    >
    // What the operator pinned stays, however old it is.
    assertEquals(written.mainnet_validators.version_agave, '4.2.2')
    assertEquals(written.mainnet_validators.version_jito, '4.2.2-jito')
    assertEquals(written.mainnet_validators.allowed_ips, ['203.0.113.7'])
    assertEquals(written.mainnet_validators.note, 'kept')
    assertEquals(written.mainnet_rpcs.version_agave, '3.1.10')
    assertEquals(written.mainnet_rpcs.version_jito, '3.1.10-jito')
    assertEquals(
      written.mainnet_rpcs.geyser_version,
      'v10.1.2-rc3+solana.3.1.10',
    )
    // A key that was missing takes the default, and so does a missing section.
    assertEquals(
      written.mainnet_validators.version_allnodes_jito,
      '4.3.2-allnodes',
    )
    assertEquals(written.mainnet_rpcs.richat_version, 'richat-v8.2.2')
    assertEquals(written.testnet_validators, TESTNET_VALIDATORS)
  } finally {
    await Deno.remove(dir, { recursive: true })
  }
})

Deno.test('the OSS skill docs state the mainnet Solana version the CLI defaults to, in both copies', async () => {
  const docs: Array<[string, string]> = [
    ['slv-validator/SKILL.md', VERSION_SOLANA_VALIDATOR_MAINNET],
    ['slv-rpc/SKILL.md', VERSION_SOLANA_MAINNET],
    ['slv-rpc/AGENT.md', VERSION_SOLANA_MAINNET],
    ['slv-grpc-geyser/SKILL.md', VERSION_SOLANA_MAINNET],
    ['slv-grpc-geyser/AGENT.md', VERSION_SOLANA_MAINNET],
  ]
  for (const root of ['oss-skills', 'dist/oss-skills']) {
    for (const [file, expected] of docs) {
      const path = `${root}/${file}`
      const text = await Deno.readTextFile(
        new URL(`../../../${path}`, import.meta.url),
      )
      const stated = text.split('\n')
        .filter((line) => /solana_version|Solana version/.test(line))
        .flatMap((line) =>
          [...line.matchAll(/default: `?([0-9][^`)\s]*)/g)].map((m) => m[1])
        )
      assert(stated.length > 0, `${path} states no default Solana version`)
      for (const version of stated) assertEquals(version, expected, path)
    }
  }
})

Deno.test('the OSS skill docs name the default jito and allnodes versions wherever they give one, in both copies', async () => {
  assertEquals(VERSION_JITO_MAINNET, VERSION_JITO_VALIDATOR_MAINNET)
  const files = [
    'README.md',
    'slv-validator/AGENT.md',
    'slv-validator/SKILL.md',
    'slv-validator/README.md',
    'slv-validator/examples/inventory.yml',
    'slv-rpc/AGENT.md',
    'slv-rpc/SKILL.md',
    'slv-rpc/README.md',
    'slv-rpc/examples/inventory.yml',
    'slv-grpc-geyser/AGENT.md',
    'slv-grpc-geyser/SKILL.md',
    'slv-grpc-geyser/README.md',
    'slv-grpc-geyser/examples/inventory.yml',
  ]
  let named = 0
  for (const root of ['oss-skills', 'dist/oss-skills']) {
    for (const file of files) {
      const path = `${root}/${file}`
      const text = await Deno.readTextFile(
        new URL(`../../../${path}`, import.meta.url),
      )
      const jito = text.match(/(?<![\d.])\d+\.\d+\.\d+-jito\b/g) ?? []
      const allnodes = text.match(/(?<![\d.])\d+\.\d+\.\d+-allnodes\b/g) ??
        []
      for (const version of jito) {
        assertEquals(version, VERSION_JITO_MAINNET, path)
      }
      for (const version of allnodes) {
        assertEquals(version, VERSION_ALLNODES_JITO_MAINNET, path)
      }
      named += jito.length + allnodes.length
    }
  }
  assert(named > 0, 'the docs name no jito or allnodes version')
})

Deno.test('the console prompts quote the testnet validator jito default as their version example', async () => {
  assertStringIncludes(
    CONTEXT_MODULES.deploy,
    `"Solana Version: ${VERSION_JITO_VALIDATOR_TESTNET} (from versions.yml)"`,
  )
  const tools = await Deno.readTextFile(
    new URL('../../src/ai/console/tools.ts', import.meta.url),
  )
  assertStringIncludes(tools, '(e.g. "${VERSION_JITO_VALIDATOR_TESTNET}")')
  for (const text of [CONTEXT_MODULES.deploy, tools]) {
    assertEquals(text.includes('4.0.0-beta.2'), false)
  }
})
