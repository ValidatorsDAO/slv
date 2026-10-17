import {
  assert,
  assertEquals,
  assertFalse,
  assertStringIncludes,
} from '@std/assert'
import {
  classifyCommand,
  decideCommandGate,
  describeRefusal,
} from '@/ai/console/commandGate.ts'

// slv v keys:gen, keys:import, keys:check, keys:try and hosts:pin read, make or
// send a key, or decide which ssh key of a node slv trusts. The gate of the AI
// console marks them as it marks slv v set:identity, and goes further: a line
// with one of them never runs from the console, whoever confirms it, as does a
// line that sets, exports or unsets the variables by which slv knows that a
// command comes from the console.

const NAMESPACES = ['v', 'validator', 'rpc', 'r']
const KEYLESS_VERBS = [
  'keys:gen',
  'keys:import',
  'keys:check',
  'keys:try',
  'hosts:pin',
]
const REF = 'op://abcdefghijklmnopqrstuvwxyz/a1b2c3d4e5f6g7h8i9j0k1l2m3/keypair'

const INPUTS = [
  { autoExecute: true, hasTerminal: true, readOnly: false },
  { autoExecute: true, hasTerminal: false, readOnly: false },
  { autoExecute: false, hasTerminal: true, readOnly: false },
  { autoExecute: false, hasTerminal: false, readOnly: false },
]

Deno.test('the gate marks the keyless verbs under every namespace the way it marks set:identity, and names them as lines that never run', () => {
  for (const namespace of NAMESPACES) {
    const reference = classifyCommand(`slv ${namespace} set:identity -p node-1`)
    assertEquals(reference.gated, true, namespace)
    // set:identity is confirmed by a person; it is not a line that never runs.
    assertEquals(reference.forbidden, [], namespace)
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
        assertEquals(found.reasons, [`slv ${namespace} ${verb}`], command)
        assertEquals(found.forbidden, found.reasons, command)
      }
    }
  }
})

Deno.test('the keyless verbs are found in front of other commands, behind a path and a separator, and in the words of a program that runs its arguments', () => {
  for (const verb of KEYLESS_VERBS) {
    for (
      const command of [
        `/usr/local/bin/slv v ${verb} -p node-1`,
        `echo x && slv v ${verb} -p node-1`,
        `ls; slv validator ${verb}`,
        `slv ${verb} -p node-1`,
        `sudo slv v ${verb} -p node-1`,
        `bash -c "slv v ${verb} -p node-1"`,
        `awk 'BEGIN { system("slv v ${verb}") }'`,
      ]
    ) {
      const found = classifyCommand(command)
      assert(found.gated, command)
      assert(found.forbidden.length > 0, `not forbidden: ${command}`)
    }
  }
})

Deno.test('a line that never runs is refused with a terminal and without one, with auto-execute on and off; a gated line that is not one of them is confirmed at a terminal', () => {
  for (const input of INPUTS) {
    for (const verb of KEYLESS_VERBS) {
      const found = classifyCommand(`slv v ${verb} -p a`)
      assertEquals(
        decideCommandGate({
          gated: found.gated,
          forbidden: found.forbidden.length > 0,
          ...input,
        }),
        'refuse',
        `${verb} ${JSON.stringify(input)}`,
      )
    }
    const set = classifyCommand('slv v set:identity -p a')
    assertEquals(
      decideCommandGate({
        gated: set.gated,
        forbidden: set.forbidden.length > 0,
        ...input,
      }),
      input.hasTerminal ? 'confirm' : 'refuse',
      JSON.stringify(input),
    )
  }
  // Without the field the decision is what it was.
  assertEquals(
    decideCommandGate({
      gated: true,
      autoExecute: false,
      hasTerminal: true,
      readOnly: false,
    }),
    'confirm',
  )
})

Deno.test('a verb that only reads, or a word that only starts like the prefixes, is left alone', () => {
  for (
    const command of [
      'slv v list -n testnet',
      'slv v get:snapshot -n testnet',
      'slv v keys',
      'slv v hosts',
      'slv v keysmith',
    ]
  ) {
    const found = classifyCommand(command)
    assertFalse(found.gated, command)
    assertEquals(found.forbidden, [], command)
  }
})

Deno.test('a line that sets, exports, unsets or drops SLV_EXECUTION_CONTEXT or OP_BIOMETRIC_UNLOCK_ENABLED never runs, whatever it runs after that', () => {
  const lines = [
    'SLV_EXECUTION_CONTEXT= /tmp/s v keys:check -n testnet',
    'SLV_EXECUTION_CONTEXT=terminal ./tool',
    'OP_BIOMETRIC_UNLOCK_ENABLED= ./tool',
    'OP_BIOMETRIC_UNLOCK_ENABLED=true ./tool',
    'export SLV_EXECUTION_CONTEXT=terminal; ./tool',
    'export SLV_EXECUTION_CONTEXT; ./tool',
    'export -n OP_BIOMETRIC_UNLOCK_ENABLED',
    'unset SLV_EXECUTION_CONTEXT; ./tool',
    'unset -v OP_BIOMETRIC_UNLOCK_ENABLED',
    'declare -x SLV_EXECUTION_CONTEXT=x',
    'readonly OP_BIOMETRIC_UNLOCK_ENABLED=true',
    'env -u SLV_EXECUTION_CONTEXT ./tool',
    'env --unset=OP_BIOMETRIC_UNLOCK_ENABLED ./tool',
    'env SLV_EXECUTION_CONTEXT= ./tool',
    'env -i ./tool',
    'env - ./tool',
    'env -iu HOME ./tool',
    'env --ignore-environment ./tool',
    'env -S "SLV_EXECUTION_CONTEXT= ./tool"',
    'exec -c ./tool',
    'nice env -i ./tool',
    'timeout 5 env -u SLV_EXECUTION_CONTEXT ./tool',
    'sudo env -i ./tool',
    'sudo SLV_EXECUTION_CONTEXT= ./tool',
    'ln -sf "$HOME/.slv/bin/slv" /tmp/s; SLV_EXECUTION_CONTEXT= OP_BIOMETRIC_UNLOCK_ENABLED= /tmp/s v keys:check -n testnet --ref op://v/i/keypair',
  ]
  for (const line of lines) {
    const found = classifyCommand(line)
    assert(found.gated, `not gated: ${line}`)
    assert(found.forbidden.length > 0, `not forbidden: ${line}`)
    for (const input of INPUTS) {
      assertEquals(
        decideCommandGate({
          gated: found.gated,
          forbidden: found.forbidden.length > 0,
          ...input,
        }),
        'refuse',
        `${line} ${JSON.stringify(input)}`,
      )
    }
  }
  // The positive controls: lines that mention the names, or do the same with other variables, are not lines that never run.
  for (
    const line of [
      'grep -rn SLV_EXECUTION_CONTEXT cli/lib',
      'echo $SLV_EXECUTION_CONTEXT',
      'cat cli/lib/secret/context.ts',
      'env',
      'env -u HOME ls',
      'env FOO=1 ls',
      'export PATH=/usr/bin:$PATH',
      'unset FOO',
      'FOO=1 ls',
      'exec ls',
    ]
  ) {
    assertEquals(classifyCommand(line).forbidden, [], line)
  }
})

Deno.test('the refusal of a line that never runs says so and does not say that a terminal is missing', () => {
  const command = 'SLV_EXECUTION_CONTEXT= ./s v keys:check -n testnet'
  const text = describeRefusal(command, classifyCommand(command))
  assertStringIncludes(text, 'never run from the AI console')
  assertStringIncludes(text, 'SLV_EXECUTION_CONTEXT')
  assertStringIncludes(text, 'ask them to run it themselves in a terminal')
  assertFalse(text.includes('no terminal is attached'))
  // The refusal of a line that is only gated is the one it was.
  const gated = 'slv v set:identity -p a'
  assertStringIncludes(
    describeRefusal(gated, classifyCommand(gated)),
    'no terminal is attached',
  )
})
