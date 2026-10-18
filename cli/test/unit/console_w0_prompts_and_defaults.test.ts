import { VALIDATOR_GUIDANCE } from '@/ai/console/operationalGuidance.ts'
import { assert, assertEquals, assertFalse } from '@std/assert'

import { AgentConfigSchema } from '@/ai/agentConfig/schema.ts'
import { EXTENDED_TOOLS } from '@/ai/console/tools.ts'
import {
  invalidateAgentContext,
  loadAgentContext,
} from '@/ai/agentConfig/loader.ts'
import {
  getModuleContent,
  loadContextModules,
  resetContextModules,
} from '@/ai/console/systemPrompt.ts'
import * as checkRelease from '@/ai/console/checkRelease.ts'
import { json, withFetch, withHome } from '/test/unit/_credentialFixtures.ts'

// A failure names the missing text instead of printing the whole file.
const includes = (text: string, needle: string, label = 'text'): void =>
  assert(text.includes(needle), `${label}: missing ${JSON.stringify(needle)}`)
const matches = (text: string, pattern: RegExp, label = 'text'): void =>
  assert(pattern.test(text), `${label}: no match for ${pattern}`)

const here = (relative: string): URL => new URL(relative, import.meta.url)
const source = (relative: string): Promise<string> =>
  Deno.readTextFile(here(relative))

const SRC = '../../src'
const ROOT = '../../..'

// a symlink or a key generation taught to the console
const SYMLINK_TO_IDENTITY = /\bln\s+-[a-zA-Z]*s[a-zA-Z]*\b[^\n]*identity\.json/
const KEYGEN_NEW = /solana-keygen\s+new/
// `slv v set:identity` in backticks with nothing after it (the source file
// escapes the closing backtick with a backslash)
const BARE_SET_IDENTITY = /slv v set:identity\\?`/

Deno.test('the agent config asks for confirmation unless it is told otherwise', async () => {
  assertEquals(AgentConfigSchema.parse({}).auto_execute, false)
  assertEquals(
    AgentConfigSchema.parse({ auto_execute: true }).auto_execute,
    true,
  )
  assertEquals(
    AgentConfigSchema.parse({ auto_execute: false }).auto_execute,
    false,
  )

  const home = await Deno.makeTempDir({ prefix: 'console-w0-agent-' })
  try {
    invalidateAgentContext()
    const ctx = await loadAgentContext({ home, force: true })
    assertEquals(ctx.autoExecute, false)
  } finally {
    invalidateAgentContext()
    await Deno.remove(home, { recursive: true })
  }
})

Deno.test('slv onboard writes auto_execute: false', async () => {
  const text = await source(`${SRC}/ai/onboard/onboardAction.ts`)
  matches(text, /auto_execute:\s*false/, 'onboardAction.ts')
  assertFalse(/auto_execute:\s*true/.test(text), 'onboard writes true')
})

// What the descriptions of auto_execute say about read-only commands, reading
// files and redaction.
const READ_ONLY_ONLY = 'runs read-only commands without asking'
const OTHERS_NEED_A_PERSON =
  'every other command needs a person to confirm it in a terminal'
const CAN_READ_OUTSIDE = 'read files outside the refused classes'
const THREE_SHAPES = 'redaction hides only three key shapes'

Deno.test('every description of auto_execute says that it runs read-only commands only, that the console can read files outside the refused classes and that redaction hides only three key shapes', async () => {
  const note = (text: string | undefined, label: string): void => {
    assert(text !== undefined, `${label}: no description`)
    includes(text, READ_ONLY_ONLY, label)
    includes(text, OTHERS_NEED_A_PERSON, label)
    includes(text, CAN_READ_OUTSIDE, label)
    includes(text, THREE_SHAPES, label)
  }
  note(AgentConfigSchema.shape.auto_execute.description, 'config schema')

  const descriptionOf = (name: string): string | undefined =>
    EXTENDED_TOOLS.find((tool) => tool.name === name)?.description
  note(descriptionOf('run_command'), 'run_command')
  note(descriptionOf('read_file'), 'read_file')

  // slv onboard prints the note in its security box and puts it above the key
  const onboard = await source(`${SRC}/ai/onboard/onboardAction.ts`)
  matches(onboard, /printWrapped\(AUTO_EXECUTE_NOTE/, 'onboardAction.ts')
  matches(
    onboard,
    /# auto_execute: \$\{AUTO_EXECUTE_NOTE\}/,
    'onboardAction.ts',
  )

  // the refusal that points to auto_execute carries it as well
  const gate = await import('@/ai/console/commandGate.ts')
  const refusal = gate.describeRefusal('ls', { gated: false, reasons: [] })
  includes(refusal, 'auto_execute: true', 'refusal')
  includes(refusal, 'run read-only commands', 'refusal')
  includes(refusal, READ_ONLY_ONLY, 'refusal')
  includes(refusal, CAN_READ_OUTSIDE, 'refusal')

  // with auto_execute on, a line that is not read-only is told why
  const notReadOnly = gate.describeRefusal(
    'touch /tmp/x',
    { gated: false, reasons: [] },
    { autoExecute: true, notReadOnly: ['touch is not a read-only program'] },
  )
  includes(
    notReadOnly,
    'with auto-execute on only read-only commands run without a person',
    'refusal',
  )
  includes(notReadOnly, 'touch is not a read-only program', 'refusal')
})

Deno.test('the run_command description names the recursive searches that need a person', () => {
  const description = EXTENDED_TOOLS.find((tool) => tool.name === 'run_command')
    ?.description
  assert(description !== undefined, 'run_command: no description')
  includes(
    description,
    'a recursive grep, rg or diff of a directory that may hold them',
    'run_command',
  )
  includes(description, 'a home directory or one above it', 'run_command')
  includes(description, 'anything under .slv or .ssh', 'run_command')
  includes(
    description,
    'a directory above or inside a key or wallet location (such as /etc, /etc/ssl, /dev, ~/.config and ~/slv)',
    'run_command',
  )
  includes(description, 'or no path at all', 'run_command')
  includes(
    description,
    'rg searches its input instead when it follows a pipe or reads a file',
    'run_command',
  )
  includes(
    description,
    'a ps that prints the environment of processes',
    'run_command',
  )
  includes(description, 'an output format named environ', 'run_command')
  includes(
    description,
    'no parameter expansion with an operator such as ${X:-default}',
    'run_command',
  )
})

Deno.test('the write_file description and the validator onboarding text say who confirms a write', async () => {
  const description = EXTENDED_TOOLS.find((tool) => tool.name === 'write_file')
    ?.description
  assert(description !== undefined, 'write_file: no description')
  includes(description, 'MEMORY.md is written without asking', 'write_file')
  includes(description, 'confirm the write in a terminal', 'write_file')
  includes(description, 'the first 20 lines', 'write_file')
  includes(
    description,
    'give the user the content and the path',
    'write_file',
  )
  includes(description, '~/.slv/api.yml', 'write_file')

  const tools = await source(`${SRC}/ai/console/tools.ts`)
  includes(
    tools,
    'In the terminal console the user confirms the write',
    'tools.ts',
  )
  includes(
    tools,
    'A gateway session has no terminal, and write_file refuses there',
    'tools.ts',
  )
  includes(tools, 'gives both to the user to save themselves', 'tools.ts')
})

Deno.test('the validator prompts name the staked mainnet key as the template does', async () => {
  const template = await source(
    `${ROOT}/template/2026.6.6.2026/ansible/mainnet-validator/copy_keys.yml`,
  )
  includes(
    template,
    '/home/solv/mainnet-validator-keypair.json',
    'copy_keys.yml',
  )
  for (const file of ['tools.ts', 'systemPrompt.ts']) {
    const wiring = await source(`${SRC}/ai/console/${file}`)
    includes(wiring, 'VALIDATOR_GUIDANCE', file)
    const text = VALIDATOR_GUIDANCE
    includes(text, '/home/solv/mainnet-validator-keypair.json', file)
    assertFalse(
      text.includes('/home/solv/<identity-pubkey>.json'),
      `${file}: a pubkey-named staked key is left`,
    )
  }
})

Deno.test('the console context no longer teaches an identity switch by symlink or key generation', () => {
  resetContextModules()
  try {
    loadContextModules([
      'ssh_check',
      'delegation',
      'deploy',
      'validator',
      'cli_reference',
      'mcp_reference',
    ])
    const text = getModuleContent()
    assert(text.length > 1000, 'the context modules did not load')
    assertFalse(SYMLINK_TO_IDENTITY.test(text), 'a symlink instruction is left')
    assertFalse(KEYGEN_NEW.test(text), 'a key generation step is left')
    includes(text, 'slv v switch', 'context')
    includes(text, 'slv v set:identity -n <network> -p <host>', 'context')
    includes(text, 'slv v init', 'context')
    assertFalse(
      BARE_SET_IDENTITY.test(text),
      'a bare slv v set:identity is left',
    )
  } finally {
    resetContextModules()
  }
})

Deno.test('the sub-agent prompt no longer teaches an identity switch by symlink or key generation', async () => {
  const wiring = await source(`${SRC}/ai/console/tools.ts`)
  includes(
    wiring,
    "effectiveName === 'Cecil' ? VALIDATOR_GUIDANCE",
    'specialist wiring',
  )
  const text = VALIDATOR_GUIDANCE
  assertFalse(SYMLINK_TO_IDENTITY.test(text), 'a symlink instruction is left')
  assertFalse(KEYGEN_NEW.test(text), 'a key generation step is left')
  assertFalse(/\bln -sf\b/.test(text), 'ln -sf is left')
  includes(text, 'slv v switch', 'tools.ts')
  includes(text, 'slv v set:identity -n <network> -p <host>', 'tools.ts')
  includes(text, 'slv v init', 'tools.ts')
  assertFalse(
    BARE_SET_IDENTITY.test(text),
    'a bare slv v set:identity is left',
  )
})

Deno.test('the release notes under template/ promote one node with slv v set:identity -p <host>', async () => {
  for (const name of ['mainnet.md', 'testnet.md']) {
    const text = await source(`${ROOT}/template/${name}`)
    assertFalse(SYMLINK_TO_IDENTITY.test(text), `${name}: symlink`)
    assertFalse(/\bln -sf\b/.test(text), `${name}: ln -sf`)
    const uses = text.match(/slv v set:identity[^\n]*/g) ?? []
    assert(uses.length > 0, `${name}: no set:identity example`)
    for (const use of uses) {
      includes(use, '-p <host>', `${name}: ${use}`)
    }
  }
  includes(
    await source(`${ROOT}/template/mainnet.md`),
    'slv v set:identity -p <host> -n mainnet',
    'mainnet.md',
  )
})

Deno.test('no release note under template/note teaches slv v set:identity without -p <host>', async () => {
  const dir = here(`${ROOT}/template/note/`)
  let notes = 0
  let teaching = 0
  for await (const entry of Deno.readDir(dir)) {
    if (!entry.isFile || !entry.name.endsWith('.md')) continue
    notes++
    const text = await Deno.readTextFile(new URL(entry.name, dir))
    assertFalse(SYMLINK_TO_IDENTITY.test(text), `${entry.name}: symlink`)
    for (const line of text.split('\n')) {
      if (!line.includes('set:identity')) continue
      teaching++
      matches(line, /set:identity\b.*\s-p\s+<host>/, `${entry.name}: ${line}`)
    }
  }
  assert(notes > 0, 'no release note found')
  assert(teaching > 0, 'no set:identity example found')
})

Deno.test('the classifier, the environment builder and the redaction live in their own modules', async () => {
  const load = async (specifier: string): Promise<Record<string, unknown>> => {
    try {
      return await import(specifier)
    } catch {
      throw new Error(`${specifier} cannot be loaded`)
    }
  }
  const gate = await load('@/ai/console/commandGate.ts')
  const safety = await load('@/ai/console/toolSafety.ts')
  const inGate = ['classifyCommand', 'decideCommandGate']
  const inSafety = [
    'buildCommandEnv',
    'buildShellInvocation',
    'redactSecretKeys',
  ]
  for (const name of inGate) assertEquals(typeof gate[name], 'function', name)
  for (const name of inSafety) {
    assertEquals(typeof safety[name], 'function', name)
  }

  const tools = await source(`${SRC}/ai/console/tools.ts`)
  for (const name of [...inGate, ...inSafety]) {
    assertFalse(
      new RegExp(`\\b(function|const|let)\\s+${name}\\b`).test(tools),
      `tools.ts defines ${name}`,
    )
  }
  matches(tools, /from '@\/ai\/console\/commandGate\.ts'/, 'tools.ts')
  matches(tools, /from '@\/ai\/console\/toolSafety\.ts'/, 'tools.ts')

  // the modules do not depend on tools.ts
  for (const file of ['commandGate.ts', 'toolSafety.ts']) {
    const text = await source(`${SRC}/ai/console/${file}`)
    assertFalse(
      /from '[^']*\/tools\.ts'/.test(text),
      `${file} imports tools.ts`,
    )
  }
})

Deno.test('the validator AGENT.md generates keys on the operator machine, in both copies', async () => {
  const copies = [
    await source(`${ROOT}/oss-skills/slv-validator/AGENT.md`),
    await source(`${ROOT}/dist/oss-skills/slv-validator/AGENT.md`),
  ]
  assert(copies[0] === copies[1], 'the two AGENT.md copies differ')
  const text = copies[0]
  assertFalse(KEYGEN_NEW.test(text), 'solana-keygen new is left')
  assertFalse(
    /generat\w*[^\n]*\b(target|remote)\b[^\n]*\bserver\b/i.test(text),
    'a key generation on the server is left',
  )
  includes(
    text,
    'Have the operator complete key handling in their own terminal',
    'key handling',
  )
  includes(
    text,
    'only for public keys or non-secret status, never key contents',
    'key handling',
  )
  includes(text, 'not voting without keys', 'keyless semantics')
})

Deno.test('the validator SKILL.md command table shows slv v set:identity -p <host>, in both copies', async () => {
  for (
    const path of [
      `${ROOT}/oss-skills/slv-validator/SKILL.md`,
      `${ROOT}/dist/oss-skills/slv-validator/SKILL.md`,
    ]
  ) {
    const text = await source(path)
    includes(text, '| `slv v set:identity -n <network> -p <host>` |', path)
    assertFalse(text.includes('| `slv v set:identity` |'), `${path}: bare row`)
  }
})

const VERSIONS_YML = [
  'mainnet_validators:',
  '  version_agave: 2.0.0',
  '  version_jito: 2.0.0-jito',
  'testnet_validators:',
  '  version_agave: 2.1.0',
  '',
].join('\n')

Deno.test('the release checker asks GitHub for nothing and writes no version', async () => {
  await withHome(null, async (home) => {
    const versionsPath = `${home}/.slv/versions.yml`
    await Deno.writeTextFile(versionsPath, VERSIONS_YML)
    await withFetch(
      () => json([{ tag_name: 'v9.9.9', prerelease: false }]),
      async (requests) => {
        const updates = await checkRelease.checkSolanaReleases()
        assertEquals(updates, [])
        await checkRelease.applyVersionUpdates([
          {
            component: 'agave',
            repo: 'anza-xyz/agave',
            current: '2.0.0',
            latest: '9.9.9',
            network: 'mainnet',
            field: 'mainnet_validators.version_agave',
          },
        ])
        assertEquals(requests.map((r) => r.url), [])
      },
    )
    assertEquals(await Deno.readTextFile(versionsPath), VERSIONS_YML)
  })
})

Deno.test('the console start-up does not check releases and /update only says they are disabled', async () => {
  const consoleSource = await source(`${SRC}/ai/console/consoleAction.ts`)
  assertFalse(consoleSource.includes('checkSolanaReleases'))
  assertFalse(consoleSource.includes('applyVersionUpdates'))
  assertFalse(consoleSource.includes('api.github.com'))
  assertFalse(consoleSource.includes('pendingUpdates'))
  matches(
    consoleSource,
    /input === '\/update'[\s\S]{0,400}VERSION_UPDATES_DISABLED_MESSAGE/,
    'consoleAction.ts /update',
  )

  const checkerSource = await source(`${SRC}/ai/console/checkRelease.ts`)
  assertFalse(checkerSource.includes('api.github.com'))
  assertFalse(/\bfetch\s*\(/.test(checkerSource))
  assertFalse(/writeTextFile/.test(checkerSource))

  const message = (checkRelease as unknown as Record<string, unknown>)
    .VERSION_UPDATES_DISABLED_MESSAGE
  assertEquals(typeof message, 'string')
  includes(message as string, 'disabled', 'message')
  includes(message as string, 'version resolver', 'message')
})
