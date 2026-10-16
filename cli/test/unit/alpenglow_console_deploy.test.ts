import { assert, assertEquals, assertStringIncludes } from '@std/assert'

// slv overhaul: Alpenglow. The SLV AI console deploys a validator by running
// <network>-validator/init.yml itself, which skips the checks of `slv v deploy`:
// a Firedancer or Frankendancer type on mainnet, and a client below the floor.
// What it is told is in the sub-agent prompt of src/ai/console/tools.ts.

const source = Deno.readTextFile(
  new URL('../../src/ai/console/tools.ts', import.meta.url),
)

/** The text from `from` up to the next `to` (or the end). */
const between = (text: string, from: string, to: string): string => {
  const start = text.indexOf(from)
  assert(start >= 0, `no "${from}" in tools.ts`)
  const end = text.indexOf(to, start + from.length)
  return text.slice(start, end < 0 ? undefined : end)
}

Deno.test('the console offers the Firedancer validator types on testnet only', async () => {
  const text = await source
  const question = between(text, '5. Validator type:', '\n')
  assertStringIncludes(question, 'jito / agave / allnodes-jito on any network')
  assertStringIncludes(
    question,
    'firedancer-agave / firedancer-jito on testnet only',
  )
  assertStringIncludes(question, 'mainnet refuses them')
  const types = between(text, '### Validator types', '\n###')
  for (const type of ['firedancer-agave', 'firedancer-jito']) {
    const line = types.split('\n').find((row) => row.startsWith(`- ${type} `))
    assert(line, `no ${type} in the list of types`)
    assertStringIncludes(line, 'testnet only; refused on mainnet')
  }
  for (const type of ['jito', 'agave', 'allnodes-jito']) {
    const line = types.split('\n').find((row) => row.startsWith(`- ${type} `))
    assert(line, `no ${type} in the list of types`)
    assertEquals(line.includes('testnet only'), false, type)
  }
})

Deno.test('the console deploy step makes the sub-agent refuse the Firedancer types on mainnet and hold the versions to the floor before it runs init.yml', async () => {
  const step = between(await source, '### Step 3: Deploy', '### Identity Key')
  const checks = step.slice(0, step.indexOf('ansible-playbook -i'))
  assertStringIncludes(checks, 'skips the checks that \\`slv v deploy\\` makes')
  // Mainnet refuses the Firedancer types, and the sub-agent stops there.
  assertStringIncludes(
    checks,
    'Mainnet refuses firedancer-agave and firedancer-jito',
  )
  assertStringIncludes(
    checks,
    'do not write the inventory and do not run init.yml',
  )
  assertStringIncludes(checks, 'offer jito, agave or allnodes-jito instead')
  // The floors come from the code that enforces them, not from a copy.
  assertStringIncludes(checks, '${ALPENGLOW_FLOORS.mainnet} on mainnet')
  assertStringIncludes(checks, '${ALPENGLOW_FLOORS.testnet} on testnet')
  assertStringIncludes(checks, 'version_agave')
  assertStringIncludes(checks, 'version_jito')
  assertStringIncludes(checks, 'version_allnodes_jito')
  assertStringIncludes(checks, 'is not a version number such as 4.3.2')
  // The playbook is meant to stop too, and the sub-agent does not go round it.
  assertStringIncludes(checks, 'init.yml is meant to stop on both')
  assertStringIncludes(
    checks,
    'do not change the validator type, a version or the playbook',
  )
  // All of it comes before the command that runs the playbook.
  assert(step.indexOf('Mainnet refuses') < step.indexOf('ansible-playbook -i'))
})
