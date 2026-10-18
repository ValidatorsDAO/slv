import {
  assert,
  assertEquals,
  assertFalse,
  assertStringIncludes,
} from '@std/assert'
import { VALIDATOR_GUIDANCE } from '@/ai/console/operationalGuidance.ts'
import { CONTEXT_MODULES } from '@/ai/console/systemPrompt.ts'
import { ALPENGLOW_FLOORS } from '/lib/versionFloor.ts'

Deno.test('main console and validator specialist use the same current identity guidance', async () => {
  assertEquals(CONTEXT_MODULES.validator, VALIDATOR_GUIDANCE)
  assertFalse(CONTEXT_MODULES.deploy === VALIDATOR_GUIDANCE)
  assertStringIncludes(CONTEXT_MODULES.deploy, 'mainnet/testnet/devnet RPC')
  const tools = await Deno.readTextFile(
    new URL('../../src/ai/console/tools.ts', import.meta.url),
  )
  assertStringIncludes(tools, "effectiveName === 'Cecil' ? VALIDATOR_GUIDANCE")
  assertFalse(tools.includes('Then run ansible-playbook directly'))
  assertFalse(tools.includes('Do NOT use \\`slv v deploy'))
})

Deno.test('validator guidance preserves Alpenglow restrictions and uses executable version floors', () => {
  assertStringIncludes(
    VALIDATOR_GUIDANCE,
    'Mainnet Firedancer/Frankendancer deployment and promotion are refused',
  )
  for (const type of ['agave', 'jito', 'allnodes-jito']) {
    assert(VALIDATOR_GUIDANCE.includes(type))
  }
  assertStringIncludes(
    VALIDATOR_GUIDANCE,
    `mainnet ${ALPENGLOW_FLOORS.mainnet}`,
  )
  assertStringIncludes(
    VALIDATOR_GUIDANCE,
    `testnet ${ALPENGLOW_FLOORS.testnet}`,
  )
  assertStringIncludes(VALIDATOR_GUIDANCE, 'preserve CLI checks')
  assertStringIncludes(VALIDATOR_GUIDANCE, 'do not bypass prompts or guards')
})

Deno.test('the routing prompt offers Firedancer types only on testnet', () => {
  assertStringIncludes(
    CONTEXT_MODULES.delegation,
    'firedancer-agave/firedancer-jito on testnet only',
  )
  assertStringIncludes(CONTEXT_MODULES.delegation, 'mainnet refuses them')
})
