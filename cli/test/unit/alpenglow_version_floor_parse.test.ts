import { assert, assertEquals, assertStringIncludes } from '@std/assert'
import { defaultVersionsObject } from '/lib/config/defaultVersionsYml.ts'
import {
  ALPENGLOW_FLOORS,
  findBelowFloorPins,
  type FloorDeps,
  isBelowFloor,
  refuseBelowFloorPins,
  refuseVersionBelowFloor,
} from '/lib/versionFloor.ts'

// slv overhaul: Alpenglow. How the floor reads what an operator writes in
// versions.yml or after a flag: 4.2 (a YAML number), 4.2.1.1, 3.1.10-bam, and
// a value with no version number in it.

type Recorded = {
  deps: FloorDeps
  info: string[]
  errors: string[]
  exitCodes: number[]
}

/** Floor dependencies that serve these pins and record what is said. */
const recorder = (versions: unknown): Recorded => {
  const rec: Recorded = {
    info: [],
    errors: [],
    exitCodes: [],
    deps: {
      readVersions: () => Promise.resolve(versions),
      defaults: defaultVersionsObject,
      info: (line) => rec.info.push(line),
      error: (line) => rec.errors.push(line),
      setExitCode: (code) => rec.exitCodes.push(code),
    },
  }
  return rec
}

const MAINNET = ALPENGLOW_FLOORS.mainnet
const TESTNET = ALPENGLOW_FLOORS.testnet

const pinned = (section: string, key: string, value: unknown) =>
  findBelowFloorPins({ [section]: { [key]: value } })

Deno.test('a numeric YAML value is read as X.Y.0', () => {
  // 4.2 is a number once YAML has parsed it, and it is 4.2.0.
  assert(isBelowFloor('4.2', MAINNET))
  assertEquals(isBelowFloor('4.3', MAINNET), false)
  assert(isBelowFloor('4.3', TESTNET))
  assertEquals(isBelowFloor('4.4', TESTNET), false)

  const found = pinned('mainnet_validators', 'version_agave', 4.2)
  assertEquals(
    found.map((pin) => [pin.section, pin.key, pin.pinned, pin.suggested]),
    [['mainnet_validators', 'version_agave', '4.2', '4.3.2']],
  )
  assertEquals(pinned('mainnet_validators', 'version_agave', 4.3), [])
})

Deno.test('a fourth component is ignored: 4.2.1.1 is 4.2.1', () => {
  assert(isBelowFloor('4.2.1.1', MAINNET))
  assertEquals(isBelowFloor('4.3.0.9', MAINNET), false)
  assertEquals(
    pinned('mainnet_rpcs', 'version_jito', '4.2.1.1').map((pin) => pin.pinned),
    ['4.2.1.1'],
  )
})

Deno.test('a tag this does not know is read by its X.Y.Z, and a pre-release before it stays', () => {
  assert(isBelowFloor('3.1.10-bam', MAINNET))
  assertEquals(isBelowFloor('4.3.2-bam', MAINNET), false)
  // 4.3.0-beta.3 is older than 4.3.0, whatever follows it.
  assert(isBelowFloor('4.3.0-beta.3-bam', MAINNET))
  assertEquals(isBelowFloor('4.4.0-beta.1-bam', TESTNET), false)
  // Forms that were refused before still are, and spaces do not matter.
  for (const version of ['4.2.1', 'v4.2.1-jito', '4.2.1-jito.2', '4.2.1 ']) {
    assert(isBelowFloor(version, MAINNET), version)
  }
  assertEquals(
    pinned('mainnet_validators', 'version_jito', '3.1.10-bam').map((pin) =>
      pin.pinned
    ),
    ['3.1.10-bam'],
  )
})

Deno.test('a pin with no X.Y is refused in a mainnet section and only warned about in the others', async () => {
  for (const value of ['latest', 'main', 'a1b2c3d']) {
    for (const role of ['validator', 'rpc'] as const) {
      const section = role === 'validator'
        ? 'mainnet_validators'
        : 'mainnet_rpcs'
      const rec = recorder({ [section]: { version_agave: value } })
      assertEquals(
        await refuseBelowFloorPins('mainnet', role, rec.deps),
        true,
        `${section} ${value}`,
      )
      assertEquals(rec.exitCodes, [1], `${section} ${value}`)
      const message = rec.errors.join('\n')
      assertStringIncludes(
        message,
        `${section}.version_agave: ${value} -> 4.3.2`,
      )
      assertStringIncludes(message, 'not a version')
      assertStringIncludes(message, 'Nothing was changed')
    }
  }
  // Testnet and devnet: said, not refused.
  for (
    const [network, role, section] of [
      ['testnet', 'validator', 'testnet_validators'],
      ['testnet', 'rpc', 'testnet_rpcs'],
      ['devnet', 'rpc', 'devnet_rpcs'],
    ] as const
  ) {
    const rec = recorder({ [section]: { version_agave: 'latest' } })
    assertEquals(
      await refuseBelowFloorPins(network, role, rec.deps),
      false,
      section,
    )
    assertEquals([rec.errors, rec.exitCodes], [[], []], section)
    assertEquals(rec.info.length, 1, section)
    assertStringIncludes(rec.info[0], `${section}.version_agave is latest`)
    assertStringIncludes(rec.info[0], TESTNET)
  }
  // A mainnet section also lists a pin below the floor in the same refusal.
  const both = recorder({
    mainnet_validators: { version_agave: 'latest', version_jito: '3.1.10-bam' },
  })
  assertEquals(
    await refuseBelowFloorPins('mainnet', 'validator', both.deps),
    true,
  )
  const lines = both.errors.join('\n')
  assertStringIncludes(
    lines,
    'mainnet_validators.version_agave: latest -> 4.3.2',
  )
  assertStringIncludes(
    lines,
    'mainnet_validators.version_jito: 3.1.10-bam -> 4.3.2-jito',
  )
})

Deno.test('a version typed on the command line is read the same way, and one with no X.Y is warned about and not refused', async () => {
  const refused = async (network: string, version: string) => {
    const rec = recorder(null)
    const went = await refuseVersionBelowFloor(
      network,
      'rpc',
      version,
      'install:solana -v',
      rec.deps,
    )
    return { went, rec }
  }
  for (const version of ['4.2', '4.2.1.1', '3.1.10-bam']) {
    const { went, rec } = await refused('mainnet', version)
    assertEquals(went, true, version)
    assertEquals(rec.exitCodes, [1], version)
  }
  assertEquals((await refused('mainnet', '4.3')).went, false)
  for (const network of ['mainnet', 'testnet']) {
    for (const version of ['latest', 'main', 'a1b2c3d']) {
      const { went, rec } = await refused(network, version)
      assertEquals(went, false, `${network} ${version}`)
      assertEquals(
        [rec.errors, rec.exitCodes],
        [[], []],
        `${network} ${version}`,
      )
      assertEquals(rec.info.length, 1, `${network} ${version}`)
      assertStringIncludes(rec.info[0], `install:solana -v ${version}`)
    }
  }
})
