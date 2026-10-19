import {
  assert,
  assertEquals,
  assertFalse,
  assertRejects,
  assertStringIncludes,
} from '@std/assert'
import { parse } from '@std/yaml'
import { validatorCmd } from '@/validator/index.ts'
import { installCmd } from '@/install/index.ts'
import { backupCmd } from '@/backup/index.ts'
import {
  BACKUP_GUIDANCE,
  COMMAND_REFERENCE,
  FIREWALL_GUIDANCE,
  VALIDATOR_GUIDANCE,
  WIREGUARD_GUIDANCE,
} from '@/ai/console/operationalGuidance.ts'
import type { AlpenglowState } from '/lib/alpenglowState.ts'
import { ALPENGLOW_FLOORS } from '/lib/versionFloor.ts'
import { confirmDeploy, type InventoryHost } from '/lib/targetGuard.ts'
import { runSetIdentity, type SetIdentityDeps } from '/lib/identityPrecheck.ts'
import { parseAllowIps } from '@/install/firewallFlow.ts'
import denoJson from '/deno.json' with { type: 'json' }

const root = new URL('../../../', import.meta.url)
const read = (path: string) => Deno.readTextFile(new URL(path, root))
const template = `template/${denoJson.version}/ansible`

Deno.test('operational command examples match registered CLI options and do not invent automation flags', () => {
  const deploy = validatorCmd.getCommand('deploy')!
  assertEquals(deploy.getOptions().map((option) => option.name).sort(), [
    'network',
    'pubkey',
  ])
  assertEquals(
    validatorCmd.getCommand('init')!.getOptions().map((option) => option.name),
    ['localhost'],
  )
  for (
    const name of [
      'build:solana',
      'update:script',
      'restart',
      'set:identity',
      'set:unstaked',
      'check:alpenglow',
    ]
  ) {
    const command = validatorCmd.getCommand(name)
    assert(command)
    const flags = command.getOptions().flatMap((option) => option.flags)
    assert(flags.includes('-n') && flags.includes('-p'))
    assertStringIncludes(
      COMMAND_REFERENCE,
      `slv v ${name} -n <network> -p <host>`,
    )
  }
  const identityFlags = validatorCmd.getCommand('set:identity')!.getOptions()
    .flatMap((option) => option.flags)
  for (
    const flag of [
      '--first-activation',
      '--peer-down-confirmed',
      '--primary-down',
    ]
  ) assert(identityFlags.includes(flag))
  const wireguardFlags = installCmd.getCommand('wireguard')!.getOptions()
    .flatMap((option) => option.flags)
  for (const flag of ['-i', '-l', '--iphone-pubkey']) {
    assert(wireguardFlags.includes(flag))
  }
  assertFalse(wireguardFlags.includes('-y'))
  assertFalse(wireguardFlags.includes('--yes'))
  assertStringIncludes(WIREGUARD_GUIDANCE, 'still asks for confirmation')
  const firewallFlags = installCmd.getCommand('firewall')!.getOptions().flatMap(
    (option) => option.flags,
  )
  assert(firewallFlags.includes('--allow') && firewallFlags.includes('-y'))
  assertFalse(firewallFlags.includes('-i'))
  assertFalse(firewallFlags.includes('-p'))
  const backupFlags = backupCmd.getCommand('create')!.getOptions().flatMap(
    (option) => option.flags,
  )
  for (const flag of ['--restic', '-y', '-r']) {
    assert(backupFlags.includes(flag))
  }
  assertStringIncludes(BACKUP_GUIDANCE, 'not a remote-host selector')
})

Deno.test('deploy cannot be treated as a noninteractive command without an explicit environment override', async () => {
  let prompted = false
  let exitCode = 0
  assertEquals(
    await confirmDeploy({
      isTty: () => false,
      getEnv: () => undefined,
      prompt: () => {
        prompted = true
        return Promise.resolve(true)
      },
      info: () => {},
      error: () => {},
      setExitCode: (code) => {
        exitCode = code
      },
    }),
    false,
  )
  assertEquals(prompted, false)
  assertEquals(exitCode, 1)
  assertStringIncludes(VALIDATOR_GUIDANCE, "operator's terminal")
  assertStringIncludes(VALIDATOR_GUIDANCE, 'all-host override')
})

Deno.test('first-activation and peer-down-confirmed retain the real CLI safety semantics', async () => {
  const host: InventoryHost = {
    name: 'example-validator',
    ansibleHost: '192.0.2.10',
    identityAccount: 'ExamplePublicIdentity',
    voteAccount: 'ExampleVoteAccount',
    ansibleConnection: '',
  }
  const runs: { limit: string; vars?: Record<string, string | boolean> }[] = []
  const checks: boolean[] = []
  let precheckOk = false
  const deps: Partial<SetIdentityDeps> = {
    isTty: () => false,
    readState: () =>
      Promise.resolve({ state: 'towerbft', detail: '', marginSlots: 3000 }),
    ask: () => {
      throw new Error('No recovery confirmation expected')
    },
    readHosts: () => Promise.resolve([host]),
    precheck: (input) => {
      checks.push(input.peerDownConfirmed === true)
      return Promise.resolve({
        ok: precheckOk,
        failures: precheckOk ? [] : ['Identity is active elsewhere'],
        notes: [],
      })
    },
    confirm: () => {
      throw new Error('Noninteractive promotion cannot prompt')
    },
    runPlaybook: (_playbook, _inventory, limit, vars) => {
      runs.push({ limit, vars })
      return Promise.resolve(true)
    },
    templateRoot: () => '/example/templates',
    info: () => {},
    error: () => {},
    setExitCode: () => {},
  }
  const options = {
    network: 'testnet',
    pubkey: host.name,
    firstActivation: true,
    peerDownConfirmed: true,
  }
  assertEquals(await runSetIdentity(options, deps), false)
  assertEquals(runs, [])
  assertEquals(checks, [true])
  precheckOk = true
  assertEquals(await runSetIdentity(options, deps), true)
  assertEquals(runs, [{ limit: host.name, vars: { first_activation: true } }])
  assertEquals(
    await runSetIdentity({ ...options, network: 'mainnet' }, deps),
    false,
  )
  assertEquals(runs.length, 1)
  assertStringIncludes(
    VALIDATOR_GUIDANCE,
    'does not override a known-active peer',
  )
  assertStringIncludes(VALIDATOR_GUIDANCE, 'never voted')
})

Deno.test('keyless startup and stdin activation match the new runtime templates', async () => {
  type Task = Record<string, unknown>
  type Play = { tasks?: Task[]; import_playbook?: string }
  const setup = parse(
    await read(`${template}/cmn/setup_unstaked_identity.yml`),
  ) as Play[]
  const link = setup[0].tasks!.find((task) => Object.hasOwn(task, 'file'))!
    .file as Record<string, unknown>
  assertEquals(link.src, '/home/solv/unstaked-identity.json')
  assertEquals(link.dest, '/home/solv/identity.json')
  assertEquals(link.state, 'link')
  assertStringIncludes(VALIDATOR_GUIDANCE, String(link.src))
  assertStringIncludes(VALIDATOR_GUIDANCE, String(link.dest))
  const assertion = await read(`${template}/cmn/assert_unstaked_identity.yml`)
  assertStringIncludes(assertion, 'Nothing was stopped or started')
  for (const network of ['mainnet', 'testnet']) {
    const init = parse(
      await read(`${template}/${network}-validator/init.yml`),
    ) as Play[]
    const imports = init.map((play) => play.import_playbook)
    assertFalse(imports.includes('copy_keys.yml'))
    const startup = imports.indexOf('../cmn/setup_unstaked_identity.yml')
    const guard = imports.indexOf('../cmn/assert_unstaked_identity.yml')
    assert(startup >= 0 && guard > startup)
    const start = imports.findIndex((path) => path?.startsWith('start'))
    assert(
      start > guard,
      'the unstaked identity must be checked before service start',
    )
    await assertRejects(
      () =>
        Deno.stat(
          new URL(`${template}/${network}-validator/copy_keys.yml`, root),
        ),
      Deno.errors.NotFound,
    )
    const promotion = parse(
      await read(`${template}/${network}-validator/set_identity_key.yml`),
    ) as Play[]
    const tasks = promotion.flatMap((play) => play.tasks ?? [])
    const keyRead = tasks.find((task) =>
      task.name === 'Read local validator key file securely (base64)'
    )!
    assertEquals(keyRead.no_log, true)
    assertEquals(keyRead.delegate_to, 'localhost')
    const activation = tasks.find((task) =>
      task.name === 'Set Identity to Validator Key via stdin (agave family)'
    )!
    assertEquals(activation.no_log, true)
    assertStringIncludes(
      (activation.args as { stdin: string }).stdin,
      'key_file.content',
    )
    assertStringIncludes(String(activation.shell), 'vote_history_flag')
    const historyFlag = tasks.find((task) =>
      task.name ===
        'Do without the vote history file only when the old primary is confirmed down'
    )!
    assertStringIncludes(
      JSON.stringify(historyFlag),
      "slv_alpenglow_state == 'alpenglow'",
    )
    assertStringIncludes(
      JSON.stringify(historyFlag),
      'not vote_history_file.stat.exists',
    )
    assertStringIncludes(JSON.stringify(historyFlag), 'primary_down_confirmed')
    const retired = await read(
      `${template}/${network}-validator/set_identity_to_active.yml`,
    )
    assertStringIncludes(retired, 'SLV_KEYLESS_REFUSED')
  }
  assertStringIncludes(VALIDATOR_GUIDANCE, 'deploy never copies')
  assertStringIncludes(VALIDATOR_GUIDANCE, 'only on stdin')
  assertStringIncludes(VALIDATOR_GUIDANCE, 'after the genesis certificate')
  assertStringIncludes(VALIDATOR_GUIDANCE, 'Legacy')
  assertStringIncludes(VALIDATOR_GUIDANCE, ALPENGLOW_FLOORS.mainnet)
  assertStringIncludes(VALIDATOR_GUIDANCE, ALPENGLOW_FLOORS.testnet)
})

Deno.test('primary-down requires a terminal, a named peer and readable consensus without bypassing prechecks', async () => {
  const host: InventoryHost = {
    name: 'standby',
    ansibleHost: '192.0.2.11',
    identityAccount: 'Aa'.repeat(22),
    voteAccount: 'Bb'.repeat(22),
    ansibleConnection: '',
  }
  const peer: InventoryHost = {
    ...host,
    name: 'primary',
    ansibleHost: '192.0.2.10',
  }
  let tty = false
  let state: AlpenglowState = 'alpenglow'
  let precheckOk = true
  let asks = 0
  let reads = 0
  let typed = peer.name
  const runs: Record<string, string | boolean>[] = []
  const deps: Partial<SetIdentityDeps> = {
    isTty: () => tty,
    readHosts: () => Promise.resolve([host, peer]),
    readState: () => {
      reads++
      return Promise.resolve({ state, detail: '', marginSlots: 3000 })
    },
    ask: () => {
      asks++
      return Promise.resolve(typed)
    },
    confirm: () => Promise.resolve(true),
    precheck: (input) => {
      assertEquals(input.downPeer, peer.name)
      assertEquals(input.consensus, 'alpenglow')
      return Promise.resolve({
        ok: precheckOk,
        failures: precheckOk ? [] : ['Still voting'],
        notes: [],
      })
    },
    runPlaybook: (_playbook, _inventory, _limit, vars) => {
      runs.push(vars ?? {})
      return Promise.resolve(true)
    },
    info: () => {},
    error: () => {},
    setExitCode: () => {},
    templateRoot: () => '/example/template',
  }
  const options = { network: 'testnet', pubkey: host.name, primaryDown: true }
  assertEquals(await runSetIdentity(options, deps), false)
  assertEquals(reads, 0)
  tty = true
  assertEquals(
    await runSetIdentity({ ...options, firstActivation: true }, deps),
    false,
  )
  assertEquals(reads, 0)
  for (const blocked of ['unknown', 'imminent', 'window'] as const) {
    state = blocked
    assertEquals(await runSetIdentity(options, deps), false)
  }
  assertEquals(asks, 0)
  state = 'alpenglow'
  typed = 'not-a-peer'
  assertEquals(await runSetIdentity(options, deps), false)
  typed = peer.name
  precheckOk = false
  assertEquals(await runSetIdentity(options, deps), false)
  assertEquals(runs, [])
  precheckOk = true
  assertEquals(await runSetIdentity(options, deps), true)
  assertEquals(runs, [{ primary_down_confirmed: true }])
  assertStringIncludes(
    VALIDATOR_GUIDANCE,
    'incompatible with --first-activation',
  )
  assertStringIncludes(VALIDATOR_GUIDANCE, '270 slots')
})

Deno.test('firewall guidance follows local execution, destructive rules replacement and actual accepted source formats', async () => {
  const firewall = parse(
    await read(`${template}/cmn/software/install-firewall.yaml`),
  ) as {
    vars: {
      ssh_port: number
      wireguard_port: number
      gateway_http_ports: string
    }
    tasks: { copy?: { dest: string; content: string } }[]
  }[]
  assertEquals(firewall[0].vars.ssh_port, 22)
  assertEquals(firewall[0].vars.wireguard_port, 51820)
  assertEquals(firewall[0].vars.gateway_http_ports, '80,443')
  const rules =
    firewall[0].tasks.find((task) => task.copy?.dest === '/etc/nftables.conf')!
      .copy!.content
  assertStringIncludes(rules, 'flush ruleset')
  assertStringIncludes(rules, 'policy drop')
  assertStringIncludes(rules, 'ip saddr 10.0.0.0/24 accept')
  assertStringIncludes(
    await read('cli/src/install/firewallFlow.ts'),
    'await runAnsibleLocal(',
  )
  assertEquals(parseAllowIps(['192.0.2.1,192.0.2.2', '192.0.2.1']), {
    ok: true,
    ips: ['192.0.2.1', '192.0.2.2'],
  })
  assertEquals(parseAllowIps('192.0.2.0/24').ok, false)
  assertStringIncludes(FIREWALL_GUIDANCE, 'THIS management host')
  assertStringIncludes(FIREWALL_GUIDANCE, 'active validator/RPC')
})

Deno.test('WireGuard guidance reflects one-peer replacement and confirmation even with supplied flags', async () => {
  const source = await read('cli/src/install/index.ts')
  const wireguard = source.slice(
    source.indexOf('const wireguardCmd'),
    source.indexOf('const maskPubkey'),
  )
  assertStringIncludes(wireguard, 'if (!options.inventory)')
  assertStringIncludes(wireguard, "message: 'Proceed with WireGuard install?'")
  assert(
    wireguard.indexOf('await Confirm.prompt') <
      wireguard.indexOf('await runAnsibleV2'),
  )
  const plays = parse(
    await read(`${template}/cmn/software/install-wireguard.yaml`),
  ) as {
    vars: { wg_port: number; wg_server_ip: string }
    tasks: {
      copy?: { content?: string }
      name: string
      no_log?: boolean
      diff?: boolean
    }[]
  }[]
  assertEquals(plays[0].vars.wg_port, 51820)
  assertEquals(plays[0].vars.wg_server_ip, '10.0.0.1')
  const config = plays[0].tasks.find((task) =>
    task.name === 'Create WireGuard config'
  )!.copy!.content!
  assertEquals(
    plays[0].tasks.find((task) => task.name === 'Create WireGuard config')!
      .diff,
    false,
  )
  for (
    const name of [
      'Read existing private key if present',
      'Generate new private key if missing or invalid',
      'Generate public key',
    ]
  ) {
    assertEquals(
      plays[0].tasks.find((task) => task.name === name)!.no_log,
      true,
    )
  }
  assertEquals(config.match(/\[Peer\]/g)?.length, 1)
  assertStringIncludes(config, 'AllowedIPs = 10.0.0.2/32')
  assertStringIncludes(WIREGUARD_GUIDANCE, 'replaces existing peers')
  assertStringIncludes(
    WIREGUARD_GUIDANCE,
    '127.0.0.1 is not reachable through the WireGuard IP',
  )
})

Deno.test('published operational skill mirrors match source and do not teach direct deploy bypasses', async () => {
  for (
    const file of [
      'slv-validator/SKILL.md',
      'slv-validator/AGENT.md',
      'slv-firewall/SKILL.md',
      'slv-wireguard/SKILL.md',
    ]
  ) {
    const source = await read(`oss-skills/${file}`)
    assertEquals(await read(`dist/oss-skills/${file}`), source)
    assertFalse(
      /ansible-playbook[^`]*?(?:mainnet|testnet|\{net\}|\{network\})-validator\/init\.yml/
        .test(source),
    )
  }
})
