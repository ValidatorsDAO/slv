import { assertEquals, assertStringIncludes } from '@std/assert'
import { parse, stringify } from '@std/yaml'
import { VERSIONS_PATH } from '@cmn/constants/path.ts'
import {
  defaultVersionsObject,
  defaultVersionsYml,
} from '/lib/config/defaultVersionsYml.ts'
import { updateDefaultVersion } from '/lib/config/updateDefaultVersion.ts'
import {
  buildMainnetHostEntry,
  DEFAULT_MAINNET_VALIDATOR_TYPE,
  frankendancerWarning,
} from '/lib/addMainnetInventory.ts'

// The sections other than mainnet_validators, with the values they had before the
// mainnet validator defaults were separated from the RPC defaults.
const UNCHANGED_SECTIONS = {
  testnet_validators: {
    version_agave: '4.0.0-beta.2',
    version_jito: '4.0.0-beta.2-jito',
    version_allnodes_jito: '3.1.14',
    version_firedancer: '0.814.30108',
    allowed_ssh_ips: [],
    allowed_ips: [],
  },
  mainnet_rpcs: {
    version_agave: '3.1.10',
    version_jito: '3.1.10-jito',
    version_firedancer: '0.814.30108',
    richat_version: 'richat-v8.2.2',
    geyser_version: 'v10.1.2-rc3+solana.3.1.10',
    allowed_ssh_ips: [],
    allowed_ips: [],
  },
  devnet_rpcs: {
    version_agave: '3.1.10',
    version_jito: '3.1.10-jito',
    version_firedancer: '0.814.30108',
    richat_version: 'richat-v8.2.2',
    geyser_version: 'v10.0.1+solana.3.0.6',
    allowed_ssh_ips: [],
    allowed_ips: [],
  },
  testnet_rpcs: {
    version_agave: '4.0.0-beta.2',
    version_jito: '4.0.0-beta.2-jito',
    version_firedancer: '0.814.30108',
    richat_version: 'richat-v8.2.2',
    geyser_version: 'v10.1.1+solana.3.1.1-rc',
    allowed_ssh_ips: [],
    allowed_ips: [],
  },
}

const MAINNET_VALIDATORS = {
  version_agave: '4.3.0',
  version_jito: '4.3.0-jito.0',
  version_allnodes_jito: '4.3.0-allnodes.1',
  version_firedancer: '0.814.30108',
  allowed_ssh_ips: [],
  allowed_ips: [],
}

Deno.test('default versions: mainnet validators meet the SFDP minimum for agave, jito and allnodes', () => {
  const defaults = defaultVersionsObject()
  assertEquals(defaults.mainnet_validators, MAINNET_VALIDATORS)
})

Deno.test('default versions: RPC, testnet, devnet and Firedancer values are unchanged', () => {
  const defaults = defaultVersionsObject()
  assertEquals(
    defaults.testnet_validators,
    UNCHANGED_SECTIONS.testnet_validators,
  )
  assertEquals(defaults.mainnet_rpcs, UNCHANGED_SECTIONS.mainnet_rpcs)
  assertEquals(defaults.devnet_rpcs, UNCHANGED_SECTIONS.devnet_rpcs)
  assertEquals(defaults.testnet_rpcs, UNCHANGED_SECTIONS.testnet_rpcs)
})

Deno.test('default versions: the generated versions.yml carries the same values', () => {
  assertEquals(parse(defaultVersionsYml()), {
    mainnet_validators: MAINNET_VALIDATORS,
    ...UNCHANGED_SECTIONS,
  })
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
  assertStringIncludes(source, 'frankendancerWarning(')
})

Deno.test('picking a Frankendancer type warns that it must be replaced before Alpenglow activates', () => {
  for (const type of ['agave', 'jito', 'allnodes-jito', '']) {
    assertEquals(frankendancerWarning(type), null, type)
  }
  for (const type of ['firedancer-agave', 'firedancer-jito']) {
    const warning = frankendancerWarning(type)
    assertEquals(typeof warning, 'string')
    assertStringIncludes(warning ?? '', type)
    assertStringIncludes(warning ?? '', 'Frankendancer')
    assertStringIncludes(warning ?? '', 'Alpenglow')
    assertStringIncludes(warning ?? '', 'mainnet')
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
  const expected: Record<string, Record<string, unknown>> = {
    mainnet_validators: MAINNET_VALIDATORS,
    ...UNCHANGED_SECTIONS,
  }

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
