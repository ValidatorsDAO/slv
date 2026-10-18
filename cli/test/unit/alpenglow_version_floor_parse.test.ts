import { assert, assertEquals, assertStringIncludes } from '@std/assert'
import { defaultVersionsObject } from '/lib/config/defaultVersionsYml.ts'
import {
  ALPENGLOW_FLOORS,
  findBelowFloorPins,
  type FloorDeps,
  isBelowFloor,
  noticeBelowFloorPins,
  readClientVersion,
  refuseBelowFloorPins,
  refuseVersionBelowFloor,
  yellowstoneBuiltFor,
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

Deno.test('a pin set to nothing (version_agave:) is a pin that cannot be read: refused in a mainnet section and only warned about in the others', async () => {
  for (
    const [network, role, section] of [
      ['mainnet', 'validator', 'mainnet_validators'],
      ['mainnet', 'rpc', 'mainnet_rpcs'],
    ] as const
  ) {
    const rec = recorder({ [section]: { version_agave: null } })
    assertEquals(await refuseBelowFloorPins(network, role, rec.deps), true)
    assertEquals(rec.exitCodes, [1], section)
    assertStringIncludes(
      rec.errors.join('\n'),
      `${section}.version_agave: (empty) -> 4.3.2`,
    )
  }
  for (
    const [network, role, section] of [
      ['testnet', 'validator', 'testnet_validators'],
      ['testnet', 'rpc', 'testnet_rpcs'],
      ['devnet', 'rpc', 'devnet_rpcs'],
    ] as const
  ) {
    const rec = recorder({ [section]: { version_agave: null } })
    assertEquals(await refuseBelowFloorPins(network, role, rec.deps), false)
    assertEquals([rec.errors, rec.exitCodes], [[], []], section)
    assertEquals(rec.info.length, 1, section)
    assertStringIncludes(rec.info[0], `${section}.version_agave is (empty)`)
  }
  // A key that is not there is no pin at all.
  const absent = recorder({
    mainnet_validators: { version_jito: '4.3.2-jito' },
  })
  assertEquals(
    await refuseBelowFloorPins('mainnet', 'validator', absent.deps),
    false,
  )
  assertEquals([absent.errors, absent.info, absent.exitCodes], [[], [], []])
})

Deno.test('slv upgrade names the pins of a mainnet section that are no version and says the mainnet commands refuse them', async () => {
  const rec = recorder({
    mainnet_validators: {
      version_agave: 'latest',
      version_jito: null,
      version_allnodes_jito: '4.3.2-allnodes',
    },
    testnet_validators: { version_agave: 'main' },
  })
  assertEquals(await noticeBelowFloorPins(rec.deps), [])
  assertEquals(rec.info.length, 2)
  assertStringIncludes(
    rec.info[0],
    'mainnet_validators.version_agave is latest in ~/.slv/versions.yml',
  )
  assertStringIncludes(rec.info[0], 'the mainnet commands refuse it')
  assertStringIncludes(rec.info[0], 'Set it to 4.3.2.')
  assertStringIncludes(
    rec.info[1],
    'mainnet_validators.version_jito is (empty)',
  )
  assertStringIncludes(rec.info[1], 'Set it to 4.3.2-jito.')
  assertEquals([rec.errors, rec.exitCodes], [[], []])
})

Deno.test('the warning about a version with no X.Y after a flag says on mainnet that the playbook stops the run, and only there', async () => {
  const warned = async (network: string): Promise<string> => {
    const rec = recorder(null)
    await refuseVersionBelowFloor(
      network,
      'rpc',
      'latest',
      'install:solana -v',
      rec.deps,
    )
    return rec.info.join('\n')
  }
  const mainnet = await warned('mainnet')
  assertStringIncludes(
    mainnet,
    'The playbook stops a mainnet run with a version it cannot read',
  )
  assertStringIncludes(
    mainnet,
    'use 4.3.0 or later, such as 4.3.2 for agave or 4.3.2-jito for jito',
  )
  for (const network of ['testnet', 'devnet']) {
    const text = await warned(network)
    assertStringIncludes(text, 'is not a version (X.Y.Z)')
    assertEquals(text.includes('playbook'), false, network)
  }
})

// --- the vectors the Ansible check shares ---------------------------------------
//
// template/latest/tests/alpenglow_floor_vectors.json holds the cases that
// ansible/cmn/check_alpenglow_floor.yml and this module both have to answer the
// same way: how a version is read, whether it is below the floor of each network,
// and how a Yellowstone tag is read.

type Networks = Record<'mainnet' | 'testnet' | 'devnet', boolean>

type Vectors = {
  floors: Record<string, string>
  rank: Record<string, number>
  client_versions: {
    value: string | number
    reads: number[] | null
    below: Networks
    why: string
  }[]
  geyser_tags: {
    tag: string
    built_for: string | null
    reads: number[] | null
    below: Networks
    why: string
  }[]
}

const VECTORS = JSON.parse(
  await Deno.readTextFile(
    new URL(
      '../../../template/latest/tests/alpenglow_floor_vectors.json',
      import.meta.url,
    ),
  ),
) as Vectors

const NETWORKS = ['mainnet', 'testnet', 'devnet'] as const

Deno.test('the floors and the ranks of the shared vectors are the ones of the CLI', () => {
  assertEquals(VECTORS.floors, ALPENGLOW_FLOORS)
  for (
    const [name, rank] of [
      ['alpha', VECTORS.rank.alpha],
      ['beta', VECTORS.rank.beta],
      ['rc', VECTORS.rank.rc],
    ] as const
  ) {
    assertEquals(readClientVersion(`1.2.3-${name}.7`), [1, 2, 3, rank, 7], name)
  }
  assertEquals(readClientVersion('1.2.3'), [1, 2, 3, VECTORS.rank.release, 0])
})

Deno.test('every client version of the shared vectors reads as the vector says and is below the floors the vector says', () => {
  assert(VECTORS.client_versions.length > 50)
  for (const vector of VECTORS.client_versions) {
    // A number in the file is what YAML makes of 4.2: it is read as its text.
    const value = String(vector.value)
    assertEquals<unknown>(
      readClientVersion(value),
      vector.reads,
      `${value}: ${vector.why}`,
    )
    for (const network of NETWORKS) {
      assertEquals(
        isBelowFloor(value, ALPENGLOW_FLOORS[network]),
        vector.below[network],
        `${value} on ${network}: ${vector.why}`,
      )
    }
  }
})

Deno.test('a pin is refused or warned about as the shared vectors say: below the floor it is refused, with no X.Y it is refused on mainnet and only warned about on testnet', async () => {
  for (const vector of VECTORS.client_versions) {
    for (const network of ['mainnet', 'testnet'] as const) {
      const section = `${network}_validators`
      const rec = recorder({ [section]: { version_jito: vector.value } })
      const refused = await refuseBelowFloorPins(network, 'validator', rec.deps)
      const expected = vector.reads === null
        ? network === 'mainnet'
        : vector.below[network]
      assertEquals(
        refused,
        expected,
        `${vector.value} in ${section}: ${vector.why}`,
      )
      assertEquals(
        rec.exitCodes,
        expected ? [1] : [],
        `${vector.value} in ${section}`,
      )
      if (vector.reads === null && network === 'testnet') {
        assertEquals(
          rec.info.length,
          1,
          `${vector.value} is warned about on testnet`,
        )
      }
    }
  }
})

Deno.test('every Yellowstone tag of the shared vectors is read by the solana release it is built for', () => {
  assert(VECTORS.geyser_tags.length > 10)
  const sections = {
    mainnet: 'mainnet_rpcs',
    testnet: 'testnet_rpcs',
    devnet: 'devnet_rpcs',
  } as const
  for (const vector of VECTORS.geyser_tags) {
    const builtFor = yellowstoneBuiltFor(vector.tag)
    assertEquals(builtFor, vector.built_for, `${vector.tag}: ${vector.why}`)
    assertEquals<unknown>(
      builtFor === null ? null : readClientVersion(builtFor),
      vector.reads,
      `${vector.tag}: ${vector.why}`,
    )
    for (const network of NETWORKS) {
      const pins = findBelowFloorPins({
        [sections[network]]: { geyser_version: vector.tag },
      })
      assertEquals(
        pins.length,
        vector.below[network] ? 1 : 0,
        `${vector.tag} on ${network}: ${vector.why}`,
      )
    }
  }
})
