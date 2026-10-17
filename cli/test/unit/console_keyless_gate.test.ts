import { assert, assertEquals, assertFalse } from '@std/assert'
import { classifyCommand, decideCommandGate } from '@/ai/console/commandGate.ts'

// slv v keys:gen, keys:check, keys:try and hosts:pin read, make or send a key, or
// decide which ssh key of a node slv trusts. The gate of the AI console has to
// treat them as it treats slv v set:identity.

const NAMESPACES = ['v', 'validator', 'rpc', 'r']
const KEYLESS_VERBS = ['keys:gen', 'keys:check', 'keys:try', 'hosts:pin']
const REF = 'op://abcdefghijklmnopqrstuvwxyz/a1b2c3d4e5f6g7h8i9j0k1l2m3/keypair'

Deno.test('the gate marks keys:gen, keys:check, keys:try and hosts:pin under every namespace the way it marks set:identity', () => {
  for (const namespace of NAMESPACES) {
    const reference = classifyCommand(`slv ${namespace} set:identity -p node-1`)
    assertEquals(reference.gated, true, namespace)
    for (const verb of KEYLESS_VERBS) {
      for (
        const command of [
          `slv ${namespace} ${verb}`,
          `slv ${namespace} ${verb} -n testnet -p node-1 --ref ${REF}`,
          `slv ${namespace} ${verb.toUpperCase()} -n testnet`,
        ]
      ) {
        const found = classifyCommand(command)
        assertEquals(found.gated, reference.gated, command)
        // The reason has the shape of the one for set:identity: the command and its verb.
        assertEquals(
          found.reasons,
          [`slv ${namespace} ${verb}`],
          command,
        )
        assertEquals(reference.reasons, [`slv ${namespace} set:identity`])
      }
    }
  }
})

Deno.test('the gate marks them in front of other commands, behind a path and a separator, and decides for them as it decides for set:identity', () => {
  for (const verb of KEYLESS_VERBS) {
    for (
      const command of [
        `/usr/local/bin/slv v ${verb} -p node-1`,
        `echo x && slv v ${verb} -p node-1`,
        `ls; slv validator ${verb}`,
        `slv ${verb} -p node-1`,
      ]
    ) {
      const found = classifyCommand(command)
      assert(found.gated, command)
      assert(found.reasons.length > 0, command)
    }
  }
  // What the gate does with a gated command does not depend on the verb.
  for (
    const input of [
      { autoExecute: true, hasTerminal: true, readOnly: false },
      { autoExecute: true, hasTerminal: false, readOnly: false },
      { autoExecute: false, hasTerminal: true, readOnly: false },
      { autoExecute: false, hasTerminal: false, readOnly: false },
    ]
  ) {
    const reference = decideCommandGate({
      gated: classifyCommand('slv v set:identity -p a').gated,
      ...input,
    })
    for (const verb of KEYLESS_VERBS) {
      assertEquals(
        decideCommandGate({
          gated: classifyCommand(`slv v ${verb} -p a`).gated,
          ...input,
        }),
        reference,
        `${verb} ${JSON.stringify(input)}`,
      )
    }
  }

  // And a verb that only reads, or a word that only starts like the new prefixes, is still left alone.
  for (
    const command of [
      'slv v list -n testnet',
      'slv v get:snapshot -n testnet',
      'slv v keys',
      'slv v hosts',
      'slv v keysmith',
    ]
  ) {
    assertFalse(classifyCommand(command).gated, command)
  }
})
