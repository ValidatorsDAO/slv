import { VERSION } from '@cmn/constants/version.ts'
import { assert, assertEquals } from '@std/assert'
import { parse } from '@std/yaml'
import { existsSync } from '@std/fs'

const templateRoot = new URL(
  `../../../template/${VERSION}/`,
  import.meta.url,
)
const validatorNetworks = ['mainnet-validator', 'testnet-validator'] as const

const agaveFamily = ['agave', 'jito', 'allnodes-jito']
const frankendancerFamily = ['firedancer-agave', 'firedancer-jito']
const supportedTypes = [...agaveFamily, ...frankendancerFamily]

type Entry = Record<string, unknown>

const readText = (path: string): string =>
  Deno.readTextFileSync(new URL(path, templateRoot))

const readPlaybook = (path: string): Entry[] => parse(readText(path)) as Entry[]

const tasksOf = (play: Entry): Entry[] => (play.tasks ?? []) as Entry[]

const moduleArgs = (task: Entry, module: string): unknown =>
  task[module] ?? task[`ansible.builtin.${module}`]

const hasModule = (task: Entry, module: string): boolean =>
  moduleArgs(task, module) !== undefined

const commandOf = (task: Entry): string =>
  String(moduleArgs(task, 'shell') ?? moduleArgs(task, 'command') ?? '')

const conditionsOf = (entry: Entry): string[] =>
  [entry.when ?? []].flat().map((condition) => String(condition).trim())

const normalized = (value: unknown): string =>
  JSON.stringify(value).replaceAll(/\s+/g, ' ')

const sameMembers = (a: string[], b: string[]): boolean =>
  [...a].sort().join(',') === [...b].sort().join(',')

const gateOf = (entry: Entry): string[] | undefined => {
  for (const condition of conditionsOf(entry)) {
    const match = /^validator_type(?: \| default\(''\))? in (\[.*\])$/.exec(
      condition,
    )
    if (match) return JSON.parse(match[1].replaceAll("'", '"')) as string[]
  }
  return undefined
}

const familyOf = (gate: string[] | undefined): string | undefined => {
  if (gate && sameMembers(gate, agaveFamily)) return 'agave'
  if (gate && sameMembers(gate, frankendancerFamily)) return 'frankendancer'
  return undefined
}

const assertNoTypeFallback = (path: string): void => {
  const raw = readText(path)
  assert(
    !/validator_type\s*\|\s*default\(\s*['"](?:agave|jito|allnodes-jito|firedancer|firedancer-agave|firedancer-jito)['"]\s*\)/
      .test(raw),
    `${path} still falls back to a default validator_type`,
  )
  assert(
    !/^\s*validator_type:\s*"\{\{\s*validator_type/m.test(raw),
    `${path} still re-assigns validator_type`,
  )
}

const assertTypeGate = (task: Entry | undefined, path: string): void => {
  assert(
    task && (hasModule(task, 'assert') || hasModule(task, 'fail')),
    `${path}: the first task must assert the validator type`,
  )
  const text = normalized(task)
  for (const type of supportedTypes) {
    assert(text.includes(`'${type}'`), `${path}: type gate misses ${type}`)
  }
  assert(
    text.includes('validator_type'),
    `${path}: gate ignores validator_type`,
  )
}

// An additional read-only bootstrap refusal can precede the original type gate.
const firstTypeTask = (tasks: Entry[]): Entry | undefined =>
  tasks[0]?.name ===
      'Refuse bootstrap or 1Password-backed identities in the legacy activation path'
    ? tasks[1]
    : tasks[0]
const withoutBootstrapImport = (entries: Entry[]): Entry[] =>
  entries.filter((entry) =>
    entry.import_playbook !== '../cmn/assert_validator_bootstrap.yml'
  )

const firstIndex = (
  tasks: Entry[],
  predicate: (task: Entry) => boolean,
): number => tasks.findIndex(predicate)

Deno.test('behavior 1: set_unstaked_key and set_identity_key act for every family or fail', () => {
  for (const network of validatorNetworks) {
    for (const file of ['set_unstaked_key.yml', 'set_identity_key.yml']) {
      const path = `ansible/${network}/${file}`
      assertNoTypeFallback(path)
      const tasks = tasksOf(readPlaybook(path)[0])
      assertTypeGate(firstTypeTask(tasks), path)

      const changing = tasks.filter((task) =>
        /set-identity|authorized-voter add/.test(commandOf(task))
      )
      assert(changing.length >= 2, `${path}: identity tasks not found`)
      for (const task of changing) {
        assert(
          familyOf(gateOf(task)) !== undefined,
          `${path}: "${task.name}" is not gated on a family list`,
        )
      }
      const setIdentity = changing.filter((task) =>
        /set-identity/.test(commandOf(task))
      )
      assertEquals(
        new Set(setIdentity.map((task) => familyOf(gateOf(task)))),
        new Set(['agave', 'frankendancer']),
        `${path}: both families need a set-identity branch`,
      )

      const last = tasks[tasks.length - 1]
      assert(hasModule(last, 'fail'), `${path}: the last task must fail`)
      for (const task of setIdentity) {
        assert(
          typeof task.register === 'string' &&
            conditionsOf(last).includes(`${task.register} is skipped`),
          `${path}: final task does not test "${task.name}" for skipped`,
        )
      }
    }
  }
})

Deno.test('behavior 2: restart, stop, start and nodowntime_migrate assert the type and gate every family', () => {
  const gateTable = (network: string, file: string) => {
    const path = `ansible/${network}/${file}`
    assertNoTypeFallback(path)
    const entries = readPlaybook(path)
    assertTypeGate(
      firstTypeTask(tasksOf(withoutBootstrapImport(entries)[0])),
      path,
    )
    return entries
      .filter((entry) => entry.import_playbook !== undefined)
      .map((entry) => {
        const family = familyOf(gateOf(entry))
        assert(
          family !== undefined,
          `${path}: ${entry.import_playbook} is not gated on a family list`,
        )
        return `${entry.import_playbook}:${family}`
      })
  }
  for (
    const file of [
      'restart_node.yml',
      'stop_node.yml',
      'start_node.yml',
      'nodowntime_migrate.yml',
    ]
  ) {
    const mainnet = gateTable('mainnet-validator', file)
    const testnet = gateTable('testnet-validator', file)
    assert(mainnet.length >= 2, `${file}: expected gated imports`)
    assertEquals(testnet, mainnet, `${file}: testnet gates differ from mainnet`)
    const agaveGates = readPlaybook(`ansible/testnet-validator/${file}`)
      .filter((entry) => familyOf(gateOf(entry)) === 'agave')
    assert(agaveGates.length >= 1, `${file}: no agave family gate on testnet`)
    for (const entry of agaveGates) {
      assert(
        gateOf(entry)?.includes('allnodes-jito'),
        `${file}: testnet agave gate lacks allnodes-jito`,
      )
    }
  }
})

Deno.test('behavior 3: set_identity_key needs the tower or vote history unless first_activation is true, asks the cluster before it sets the identity on Alpenglow, and opts out of the vote history only for a confirmed dead primary', () => {
  for (const network of validatorNetworks) {
    const path = `ansible/${network}/set_identity_key.yml`
    const tasks = tasksOf(readPlaybook(path)[0])
    const firstSetIdentity = firstIndex(
      tasks,
      (task) => /set-identity/.test(commandOf(task)),
    )
    assert(firstSetIdentity > 0, `${path}: set-identity task not found`)

    const statOf = (fragment: string) =>
      firstIndex(
        tasks,
        (task) =>
          hasModule(task, 'stat') &&
          String((moduleArgs(task, 'stat') as Entry).path).startsWith(
            `/mnt/ledger/${fragment}`,
          ) &&
          String((moduleArgs(task, 'stat') as Entry).path).includes(
            'identity_account',
          ),
      )
    const towerStat = statOf('tower-1_9-')
    const voteStat = statOf('vote_history-')
    assert(
      towerStat >= 0 && towerStat < firstSetIdentity,
      `${path}: tower stat`,
    )
    assert(voteStat >= 0 && voteStat < firstSetIdentity, `${path}: vote stat`)
    const towerRegister = String(tasks[towerStat].register)
    const voteRegister = String(tasks[voteStat].register)
    const firstActivation =
      'first_activation | default(false) is not sameas true'
    const alpenglow = "slv_alpenglow_state == 'alpenglow'"
    const primaryDown = 'primary_down_confirmed | default(false) | bool'
    const noFile = `not ${voteRegister}.stat.exists`

    // TowerBFT: the tower or the vote history file, as before
    const refusal = tasks.findIndex((task) =>
      hasModule(task, 'fail') &&
      conditionsOf(task).includes(`not ${towerRegister}.stat.exists`)
    )
    assert(refusal > voteStat && refusal < firstSetIdentity, `${path}: refusal`)
    assertEquals(
      new Set(conditionsOf(tasks[refusal])),
      new Set([
        "slv_alpenglow_state == 'towerbft'",
        noFile,
        `not ${towerRegister}.stat.exists`,
        firstActivation,
      ]),
      `${path}: refusal conditions`,
    )

    // Alpenglow: only the vote history file counts, a tower file does not stand in for it
    const alpenglowRefusal = tasks.findIndex((task) =>
      hasModule(task, 'fail') &&
      conditionsOf(task).includes(`not (${primaryDown})`)
    )
    assert(
      alpenglowRefusal > voteStat && alpenglowRefusal < firstSetIdentity,
      `${path}: Alpenglow refusal`,
    )
    assertEquals(
      new Set(conditionsOf(tasks[alpenglowRefusal])),
      new Set([alpenglow, noFile, firstActivation, `not (${primaryDown})`]),
      `${path}: Alpenglow refusal conditions`,
    )
    assert(
      normalized(tasks[alpenglowRefusal]).includes('--primary-down'),
      `${path}: the refusal names the way out for a dead primary`,
    )

    // the checks (nothing votes with the identity, the host has caught up, gossip): every Alpenglow run,
    // a first activation included, with the vote history file or without it
    const checkConditions = [alpenglow]
    // the one host and the vote history flag: a confirmed dead primary and no file
    const deadConditions = [alpenglow, noFile, firstActivation, primaryDown]
    const deadImport = tasks.findIndex((task) =>
      moduleArgs(task, 'import_tasks') ===
        '../cmn/tasks/vote_history_dead_primary.yml'
    )
    assert(
      deadImport > alpenglowRefusal && deadImport < firstSetIdentity,
      `${path}: dead primary checks`,
    )
    assertEquals(
      new Set(conditionsOf(tasks[deadImport])),
      new Set(checkConditions),
      `${path}: the checks run on every Alpenglow set, a first activation included, whatever the vote history file`,
    )
    const importVars = tasks[deadImport].vars as Entry
    assertEquals(
      importVars.slv_alpenglow_network,
      network.replace('-validator', ''),
    )
    // gossip is read on every run that gets the checks: no switch turns it off, and the address named down
    // is the only address besides the one of the host that the identity may be listed at
    assertEquals(
      importVars.slv_dp_check_gossip,
      undefined,
      `${path}: gossip is read on every run`,
    )
    assert(
      normalized(importVars.slv_dp_down_address).includes(
        'primary_down_address',
      ),
      `${path}: the address named down is the one the CLI passes`,
    )
    const oneHost = tasks.findIndex((task) =>
      hasModule(task, 'assert') &&
      normalized(task).includes('ansible_play_hosts_all | length == 1')
    )
    assert(
      oneHost > alpenglowRefusal && oneHost < deadImport,
      `${path}: one host at a time before the checks`,
    )
    assertEquals(
      new Set(conditionsOf(tasks[oneHost])),
      new Set([alpenglow, firstActivation, primaryDown]),
    )
    // one identity on two hosts of one play: refused before any host passes its own checks
    const twoHosts = tasks.findIndex((task) =>
      hasModule(task, 'assert') &&
      normalized(task).includes('slv_sik_same_identity')
    )
    assert(
      twoHosts > oneHost && twoHosts < deadImport,
      `${path}: one identity on two hosts is refused before the checks`,
    )
    assertEquals(conditionsOf(tasks[twoHosts]), [alpenglow])
    const sameHosts = tasks.find((task) =>
      hasModule(task, 'set_fact') &&
      (moduleArgs(task, 'set_fact') as Entry).slv_sik_same_identity !==
        undefined
    )
    assert(sameHosts, `${path}: the hosts that hold the identity are counted`)
    assert(
      normalized(sameHosts).includes('ansible_play_hosts_all') &&
        normalized(sameHosts).includes('identity_account'),
      `${path}: the hosts of the whole play are counted by identity_account`,
    )
    // a first activation is for a vote account that has not voted since the Alpenglow genesis: agave asks for the
    // vote history file only when the last vote is after the slot of the genesis certificate, and the play mirrors it
    const firstActivationIs = 'first_activation | default(false) is sameas true'
    const genesisSlot = tasks.findIndex((task) =>
      hasModule(task, 'set_fact') &&
      (moduleArgs(task, 'set_fact') as Entry).slv_sik_genesis_slot !== undefined
    )
    assert(
      genesisSlot >= 0 && genesisSlot < deadImport,
      `${path}: the slot of the genesis certificate is read`,
    )
    assertEquals(
      new Set(conditionsOf(tasks[genesisSlot])),
      new Set([alpenglow, firstActivationIs]),
    )
    assert(
      normalized(tasks[genesisSlot]).includes('slv_ag_cert_reply') &&
        normalized(tasks[genesisSlot]).includes('block.slot'),
      `${path}: the slot comes from the answer of getAgGenesisCert`,
    )
    const voted = tasks.findIndex((task) =>
      hasModule(task, 'fail') &&
      normalized(task).includes('first_activation is for a vote account')
    )
    assert(
      voted > deadImport && voted < firstSetIdentity,
      `${path}: first activation`,
    )
    assertEquals(
      new Set(conditionsOf(tasks[voted])),
      new Set([
        alpenglow,
        firstActivationIs,
        '(slv_sik_genesis_slot | int(-1)) < 0 or (slv_dp_last | int(-1)) < 0 or (slv_dp_last | int(-1)) > (slv_sik_genesis_slot | int(-1))',
      ]),
    )
    for (const exit of ['--primary-down', 'vote history file']) {
      assert(
        normalized(tasks[voted]).includes(exit),
        `${path}: the refusal of a first activation names the exits: ${exit}`,
      )
    }
    assert(
      normalized(tasks[alpenglowRefusal]).includes('--first-activation'),
      `${path}: the refusal without a file names --first-activation`,
    )
    const readers = tasks.filter((task) =>
      moduleArgs(task, 'import_tasks') ===
        '../cmn/tasks/vote_history_last_vote.yml'
    )
    assertEquals(readers.length, 1, `${path}: one baseline reader`)
    assertEquals(
      (readers[0].vars as Entry).slv_lv_identity,
      '{{ hostvars[inventory_hostname].identity_account }}',
      `${path}: the vote account has to belong to the identity`,
    )
    const deadRefusal = tasks.findIndex((task, index) =>
      index > deadImport && hasModule(task, 'fail') &&
      conditionsOf(task).includes('not (slv_dp_ok | bool)')
    )
    assert(deadRefusal > deadImport && deadRefusal < firstSetIdentity)
    assertEquals(
      new Set(conditionsOf(tasks[deadRefusal])),
      new Set([...checkConditions, 'not (slv_dp_ok | bool)']),
    )
    assert(
      normalized(tasks[deadRefusal]).includes('slv_dp_reason'),
      `${path}: the refusal says which check failed`,
    )
    assert(
      normalized(tasks[deadRefusal]).includes('primary_down_address'),
      `${path}: the refusal names the variable that allows the address of a stopped node`,
    )

    // --require-tower: the tower is the only file, and the cluster does not run Alpenglow
    const flagTasks = tasks.filter((task) =>
      normalized(task).includes('--require-tower')
    )
    assertEquals(
      flagTasks.length,
      1,
      `${path}: one task decides --require-tower`,
    )
    const flag = flagTasks[0]
    assert(hasModule(flag, 'set_fact'), `${path}: flag must be a fact`)
    assert(
      normalized(flag).includes(
        `slv_alpenglow_state != 'alpenglow' and ${towerRegister}.stat.exists and ${noFile}`,
      ),
      `${path}: --require-tower only when the tower is the only file and the cluster runs TowerBFT`,
    )
    assert(tasks.indexOf(flag) < firstSetIdentity, `${path}: flag order`)
    const flagName = Object.keys(moduleArgs(flag, 'set_fact') as Entry)[0]

    // --do-not-require-vote-history: Alpenglow, no file, not a first activation, dead primary confirmed
    const voteFlagTasks = tasks.filter((task) =>
      normalized(task).includes('--do-not-require-vote-history')
    )
    assertEquals(
      voteFlagTasks.length,
      1,
      `${path}: one task decides --do-not-require-vote-history`,
    )
    const voteFlag = voteFlagTasks[0]
    assert(hasModule(voteFlag, 'set_fact'), `${path}: vote flag must be a fact`)
    for (const condition of deadConditions) {
      assert(
        normalized(voteFlag).includes(condition),
        `${path}: --do-not-require-vote-history needs: ${condition}`,
      )
    }
    assert(
      tasks.indexOf(voteFlag) < firstSetIdentity,
      `${path}: vote flag order`,
    )
    const voteFlagName = Object.keys(
      moduleArgs(voteFlag, 'set_fact') as Entry,
    )[0]

    const setIdentityTasks = tasks.filter((task) =>
      /set-identity/.test(commandOf(task))
    )
    assertEquals(setIdentityTasks.length, 2, `${path}: set-identity tasks`)
    for (const task of setIdentityTasks) {
      assert(
        commandOf(task).includes(`{{ ${flagName} }}`),
        `${path}: "${task.name}" does not pass the flag`,
      )
    }
    const [agaveSetIdentity, firedancerSetIdentity] = setIdentityTasks
    assert(
      commandOf(agaveSetIdentity).includes(`{{ ${voteFlagName} }}`),
      `${path}: the agave command passes the vote history flag`,
    )
    assert(
      !commandOf(firedancerSetIdentity).includes(voteFlagName),
      `${path}: fdctl has no vote history flag`,
    )

    // on Alpenglow the authorized voter has to be there (Votor derives its BLS key from it)
    const addVoter = tasks.find((task) =>
      /authorized-voter add/.test(commandOf(task)) &&
      gateOf(task)?.includes('agave')
    )
    assert(addVoter, `${path}: agave authorized-voter add`)
    assertEquals(
      addVoter.failed_when,
      false,
      `${path}: the authorized-voter add reports through the task after it, so its own output stays out of the log`,
    )
    const addVoterStop = tasks[tasks.indexOf(addVoter) + 1]
    assert(
      hasModule(addVoterStop, 'fail'),
      `${path}: a failed authorized-voter add stops the play on Alpenglow`,
    )
    assertEquals(
      new Set(conditionsOf(addVoterStop)),
      new Set([
        alpenglow,
        'add_voter_agave_result is not skipped',
        '(add_voter_agave_result.rc | default(1)) != 0',
        "'Authorized voter already present' not in ((add_voter_agave_result.stdout | default('')) ~ (add_voter_agave_result.stderr | default('')))",
      ]),
      `${path}: a failed authorized-voter add stops the play on Alpenglow, and an authorized voter that is already there is not a failure`,
    )
  }
})

const survivorsAfterFind = async (findArguments: string): Promise<string[]> => {
  const dir = await Deno.makeTempDir({ prefix: 'slv-w0-ledger-' })
  try {
    for (
      const name of [
        'contact-info.bin',
        'tower-1_9-IDENTITY.bin',
        'vote_history-IDENTITY.bin',
        'snapshot.tar.zst',
        'gossip.bin',
      ]
    ) {
      await Deno.writeTextFile(`${dir}/${name}`, 'x')
    }
    await Deno.mkdir(`${dir}/rocksdb`)
    await Deno.writeTextFile(`${dir}/rocksdb/CURRENT`, 'x')
    const { success, stderr } = await new Deno.Command('bash', {
      args: ['-c', `find '${dir}/' ${findArguments}`],
      stderr: 'piped',
    }).output()
    assert(success, new TextDecoder().decode(stderr))
    return [...Deno.readDirSync(dir)].map((entry) => entry.name).sort()
  } finally {
    await Deno.remove(dir, { recursive: true })
  }
}

const keptFiles = [
  'contact-info.bin',
  'tower-1_9-IDENTITY.bin',
  'vote_history-IDENTITY.bin',
]

const findArgumentsOf = (text: string): string => {
  const found = /sudo find \/mnt\/ledger\/ (.+)$/m.exec(text)
  assert(found, `no ledger wipe in: ${text}`)
  return found[1]
}

const assertRefusesBeforeWipe = (
  path: string,
): { tasks: Entry[]; wipe: number } => {
  const tasks = tasksOf(readPlaybook(path)[0])
  const wipe = firstIndex(
    tasks,
    (task) => /find \/mnt\/ledger\//.test(commandOf(task)),
  )
  const state = firstIndex(
    tasks,
    (task) => /systemctl is-active/.test(commandOf(task)),
  )
  const refusal = firstIndex(tasks, (task) => hasModule(task, 'fail'))
  assert(wipe >= 0, `${path}: ledger wipe not found`)
  assert(state >= 0 && state < refusal, `${path}: service state before refusal`)
  assert(refusal < wipe, `${path}: refusal must come before the wipe`)
  const stateText = normalized(tasks[state])
  assert(stateText.includes('solv.service'), `${path}: solv.service`)
  assert(
    stateText.includes('firedancer.service'),
    `${path}: firedancer.service`,
  )
  return { tasks, wipe }
}

Deno.test('behavior 4: rm_ledger refuses a live validator and both ledger wipes keep tower and vote history', async () => {
  const path = 'ansible/cmn/rm_ledger.yml'
  const { tasks, wipe } = assertRefusesBeforeWipe(path)
  const wipeCommand = commandOf(tasks[wipe])
  assert(wipeCommand.startsWith('sudo find /mnt/ledger/ '), wipeCommand)
  assertEquals(
    await survivorsAfterFind(findArgumentsOf(wipeCommand)),
    keptFiles,
    `${path}: wipe must keep the consensus files`,
  )

  const restarter = readText('jinja/cmn/restart.sh.j2')
  const restarterFind = /sudo find "\$\{ledger_root\}\/" ([^;]+?); then/.exec(
    restarter,
  )
  assert(restarterFind, 'restart.sh.j2: ledger wipe not found')
  assertEquals(
    await survivorsAfterFind(restarterFind[1]),
    keptFiles,
    'restart.sh.j2: wipe must keep the consensus files',
  )
})

const probeFile = '../cmn/tasks/alpenglow_state.yml'

Deno.test('behavior 5: switch_off asks the Alpenglow probe, refuses before demotion and switch_on requires the tower or the vote history', () => {
  const isGuard = (task: Entry) =>
    hasModule(task, 'assert') || hasModule(task, 'fail')
  for (const network of validatorNetworks) {
    const probeVars = {
      slv_alpenglow_network: network.replace('-validator', ''),
      slv_alpenglow_freeze: true,
      slv_alpenglow_move_types: ["{{ validator_type | default('') }}"],
    }

    // switch_off_firedancer_identity: an fdctl host moves a tower, so TowerBFT only
    {
      const path = `ansible/${network}/switch_off_firedancer_identity.yml`
      const tasks = tasksOf(readPlaybook(path)[0])
      const firstSetIdentity = firstIndex(
        tasks,
        (task) => /set-identity/.test(commandOf(task)),
      )
      const probe = firstIndex(
        tasks,
        (task) => moduleArgs(task, 'import_tasks') === probeFile,
      )
      assert(probe >= 0 && probe < firstSetIdentity, `${path}: probe`)
      assertEquals(tasks[probe].vars, probeVars, `${path}: probe variables`)

      const alpenglowGuard = firstIndex(
        tasks,
        (task) =>
          isGuard(task) && normalized(task).includes('Alpenglow') &&
          normalized(task).includes('TowerBFT'),
      )
      assert(
        alpenglowGuard > probe && alpenglowGuard < firstSetIdentity,
        `${path}: Alpenglow guard`,
      )
      assert(
        normalized(tasks[alpenglowGuard]).includes(
          "slv_alpenglow_state == 'towerbft'",
        ),
        `${path}: guard must require the TowerBFT state`,
      )
      assert(
        normalized(tasks[alpenglowGuard]).includes('vote history'),
        `${path}: guard must say why a swap on Alpenglow waits`,
      )

      const towerStat = firstIndex(
        tasks,
        (task) =>
          hasModule(task, 'stat') &&
          String((moduleArgs(task, 'stat') as Entry).path).startsWith(
            '/mnt/ledger/tower-1_9-',
          ),
      )
      assert(
        towerStat > alpenglowGuard && towerStat < firstSetIdentity,
        `${path}: tower stat`,
      )
      const towerGuard = firstIndex(
        tasks,
        (task) =>
          isGuard(task) &&
          normalized(task).includes(`${tasks[towerStat].register}.stat.exists`),
      )
      assert(
        towerGuard > towerStat && towerGuard < firstSetIdentity,
        `${path}: tower guard`,
      )

      // a second probe stands between the wait for the restart window and the demotion
      const wait = firstIndex(
        tasks,
        (task) => /wait-for-restart-window/.test(commandOf(task)),
      )
      const probes = tasks.flatMap((task, index) =>
        moduleArgs(task, 'import_tasks') === probeFile ? [index] : []
      )
      assertEquals(probes.length, 2, `${path}: two probes`)
      assert(
        probes[1] > wait && probes[1] < firstSetIdentity,
        `${path}: the second probe stands between the wait and the demotion`,
      )
      assertEquals(tasks[probes[1]].vars, tasks[probes[0]].vars)
      const lateGuard = tasks.findIndex((task, index) =>
        index > probes[1] && isGuard(task) &&
        normalized(task).includes("slv_alpenglow_state == 'towerbft'")
      )
      assert(
        lateGuard > probes[1] && lateGuard < firstSetIdentity,
        `${path}: the second probe is followed by the TowerBFT guard`,
      )
    }

    // switch_off_identity: the tower on TowerBFT, the vote history file on Alpenglow
    {
      const path = `ansible/${network}/switch_off_identity.yml`
      const tasks = tasksOf(readPlaybook(path)[0])
      const firstSetIdentity = firstIndex(
        tasks,
        (task) => /set-identity/.test(commandOf(task)),
      )
      const wait = firstIndex(
        tasks,
        (task) => /wait-for-restart-window/.test(commandOf(task)),
      )
      const probes = tasks.flatMap((task, index) =>
        moduleArgs(task, 'import_tasks') === probeFile ? [index] : []
      )
      assertEquals(probes.length, 2, `${path}: two probes`)
      assert(
        probes[0] < wait,
        `${path}: the first probe stands before the wait`,
      )
      assert(
        probes[1] > wait && probes[1] < firstSetIdentity,
        `${path}: the second probe stands between the wait and the demotion`,
      )
      assertEquals(tasks[probes[0]].vars, probeVars, `${path}: probe variables`)
      assertEquals(tasks[probes[1]].vars, probeVars, `${path}: second probe`)

      // the mode the switch moves is fixed by the first probe, and the second probe has to agree
      const mode = firstIndex(
        tasks,
        (task) =>
          hasModule(task, 'set_fact') &&
          (moduleArgs(task, 'set_fact') as Entry).slv_switch_mode !== undefined,
      )
      assert(mode > probes[0] && mode < wait, `${path}: switch mode`)
      assertEquals(
        (moduleArgs(tasks[mode], 'set_fact') as Entry).slv_switch_mode,
        '{{ slv_alpenglow_state }}',
      )
      const lateGuard = tasks.findIndex((task, index) =>
        index > probes[1] && isGuard(task) &&
        normalized(task).includes('slv_alpenglow_state == slv_switch_mode')
      )
      assert(
        lateGuard > probes[1] && lateGuard < firstSetIdentity,
        `${path}: the second probe is followed by the guard that the mode did not change`,
      )

      // the vote account of the inventory has to belong to the identity: asked before the wait and the demotion
      const voteAccount = firstIndex(
        tasks,
        (task) =>
          moduleArgs(task, 'import_tasks') ===
            '../cmn/tasks/vote_history_last_vote.yml',
      )
      assert(
        voteAccount > probes[0] && voteAccount < wait,
        `${path}: the vote account is checked before the source waits or is demoted`,
      )
      assertEquals(conditionsOf(tasks[voteAccount]), [
        "slv_switch_mode == 'alpenglow'",
      ])
      assertEquals(
        (tasks[voteAccount].vars as Entry).slv_lv_identity,
        '{{ hostvars[inventory_hostname].identity_account }}',
        `${path}: the vote account has to belong to the identity`,
      )
      // and the cluster has to show it: unreadable or not listed, the source is not touched
      const voteAccountShown = firstIndex(
        tasks,
        (task) =>
          hasModule(task, 'fail') &&
          conditionsOf(task).includes('slv_lv_last | int(-1) < 0'),
      )
      assert(
        voteAccountShown > voteAccount && voteAccountShown < wait,
        `${path}: a vote account the cluster does not show stops the switch before the source waits or is demoted`,
      )
      assertEquals(conditionsOf(tasks[voteAccountShown]), [
        "slv_switch_mode == 'alpenglow'",
        'slv_lv_last | int(-1) < 0',
      ])
      for (const text of ['slv_lv_detail', 'Nothing was changed on']) {
        assert(
          normalized(tasks[voteAccountShown]).includes(text),
          `${path}: the refusal says why and that nothing was changed: ${text}`,
        )
      }

      // the file to carry is checked before the wait and before the demotion
      for (
        const [fragment, mode] of [
          ['tower-1_9-', 'towerbft'],
          ['vote_history-', 'alpenglow'],
        ]
      ) {
        const stat = firstIndex(
          tasks,
          (task) =>
            hasModule(task, 'stat') &&
            String((moduleArgs(task, 'stat') as Entry).path).startsWith(
              `/mnt/ledger/${fragment}`,
            ) &&
            String((moduleArgs(task, 'stat') as Entry).path).includes(
              'identity_account',
            ),
        )
        assert(stat > probes[0] && stat < wait, `${path}: ${fragment} stat`)
        assertEquals(conditionsOf(tasks[stat]), [
          `slv_switch_mode == '${mode}'`,
        ])
        const guard = firstIndex(
          tasks,
          (task) =>
            isGuard(task) &&
            normalized(task).includes(`${tasks[stat].register}.stat.exists`),
        )
        assert(guard > stat && guard < wait, `${path}: ${fragment} guard`)
        assertEquals(conditionsOf(tasks[guard]), [
          `slv_switch_mode == '${mode}'`,
        ])
      }

      // after the demotion: the tower is fetched on TowerBFT, the vote history file is taken on Alpenglow
      const towerFetch = tasks.filter((task) => hasModule(task, 'fetch'))
      assertEquals(towerFetch.length, 1, `${path}: one fetch`)
      assert(tasks.indexOf(towerFetch[0]) > firstSetIdentity)
      assertEquals(conditionsOf(towerFetch[0]), [
        "slv_switch_mode == 'towerbft'",
      ])
      const take = tasks.findIndex((task) =>
        Array.isArray(task.block) &&
        (task.block as Entry[]).some((inner) =>
          moduleArgs(inner, 'import_tasks') ===
            '../cmn/tasks/vote_history_take.yml'
        )
      )
      assert(
        take > firstSetIdentity,
        `${path}: the vote history file is taken after the demotion`,
      )
      assertEquals(conditionsOf(tasks[take]), [
        "slv_switch_mode == 'alpenglow'",
      ])
      assert(
        Array.isArray(tasks[take].rescue),
        `${path}: a failed take says what is left to do`,
      )
    }

    // switch_on_firedancer_identity: an fdctl host takes a tower (the one of testnet is retired and refuses, and is pinned
    // with the other retired playbooks)
    if (network === 'mainnet-validator') {
      const path = `ansible/${network}/switch_on_firedancer_identity.yml`
      const tasks = tasksOf(readPlaybook(path)[0])
      const setIdentity = tasks.filter((task) =>
        /set-identity/.test(commandOf(task))
      )
      assertEquals(setIdentity.length, 1, `${path}: set-identity task`)
      assert(
        commandOf(setIdentity[0]).includes('--require-tower'),
        `${path}: set-identity must pass --require-tower`,
      )
      const probe = firstIndex(
        tasks,
        (task) => moduleArgs(task, 'import_tasks') === probeFile,
      )
      assertEquals(tasks[probe].vars, probeVars, `${path}: probe variables`)
    }

    // switch_on_identity: --require-tower with the tower on TowerBFT, the vote history file on Alpenglow
    {
      const path = `ansible/${network}/switch_on_identity.yml`
      const tasks = tasksOf(readPlaybook(path)[0])
      const probe = firstIndex(
        tasks,
        (task) => moduleArgs(task, 'import_tasks') === probeFile,
      )
      assertEquals(tasks[probe].vars, probeVars, `${path}: probe variables`)
      const mode = firstIndex(
        tasks,
        (task) =>
          hasModule(task, 'set_fact') &&
          (moduleArgs(task, 'set_fact') as Entry).slv_switch_mode !== undefined,
      )
      assert(mode > probe, `${path}: switch mode`)
      assertEquals(
        (moduleArgs(tasks[mode], 'set_fact') as Entry).slv_switch_mode,
        '{{ slv_ag_resume_mode if (slv_ag_resume | default(false) | bool) else slv_alpenglow_state }}',
      )

      const towerSetIdentity = tasks.filter((task) =>
        /set-identity/.test(commandOf(task))
      )
      assertEquals(
        towerSetIdentity.length,
        1,
        `${path}: set-identity on TowerBFT`,
      )
      assert(commandOf(towerSetIdentity[0]).includes('--require-tower'))
      assertEquals(conditionsOf(towerSetIdentity[0]), [
        "slv_switch_mode == 'towerbft'",
      ])
      const upload = tasks.find((task) =>
        hasModule(task, 'copy') &&
        String((moduleArgs(task, 'copy') as Entry).src).includes('/tower/')
      )
      assert(upload, `${path}: the tower is uploaded`)
      assertEquals(conditionsOf(upload), ["slv_switch_mode == 'towerbft'"])

      const block = tasks.find((task) => Array.isArray(task.block))
      assert(block, `${path}: the Alpenglow block`)
      assertEquals(conditionsOf(block), ["slv_switch_mode == 'alpenglow'"])
      const inner = block.block as Entry[]
      assert(
        Array.isArray(block.rescue),
        `${path}: a failed step says where the copy is`,
      )
      assert(
        normalized(block.rescue).includes('set_identity_result') &&
          normalized(block.rescue).includes('slv v set:identity -n') &&
          normalized(block.rescue).includes('unstaked'),
        `${path}: the rescue says which hosts are unstaked and the command that passes`,
      )
      const innerSetIdentity = inner.filter((task) =>
        /set-identity/.test(commandOf(task))
      )
      assertEquals(innerSetIdentity.length, 1)
      assert(
        !commandOf(innerSetIdentity[0]).includes('--require-tower'),
        `${path}: no tower flag on Alpenglow: agave then requires the vote history file`,
      )
      // the checks come before the block, so that a refusal changes nothing and has no rescue note:
      // the copy exists, it belongs to the identity of the source, and this run took it
      const blockIndex = tasks.indexOf(block)
      const outer = (predicate: (task: Entry) => boolean) =>
        tasks.findIndex(predicate)
      const stat = outer((task) =>
        hasModule(task, 'stat') && task.register === 'slv_vh_copy_stat'
      )
      assertEquals(
        (moduleArgs(tasks[stat], 'stat') as Entry).checksum_algorithm,
        'sha256',
        `${path}: the copy is read with its sha256`,
      )
      const refuse = outer((task) =>
        isGuard(task) &&
        normalized(task).includes('slv_vh_copy_stat.stat.exists')
      )
      const identityMatch = outer((task) =>
        isGuard(task) &&
        normalized(task).includes(
          'hostvars[slv_alpenglow_demoted_source].identity_account == slv_vh_identity',
        )
      )
      const taken = outer((task) =>
        isGuard(task) && normalized(task).includes('slv_vh_taken_sha256')
      )
      assert(
        stat >= 0 && stat < refuse && refuse < identityMatch &&
          identityMatch < taken && taken < blockIndex,
        `${path}: copy check, source identity, file of this run, then the block`,
      )
      for (const index of [stat, refuse, identityMatch, taken]) {
        assert(
          conditionsOf(tasks[index]).includes("slv_switch_mode == 'alpenglow'"),
          `${path}: "${tasks[index].name}" is for Alpenglow`,
        )
      }
      // the file of this run: a source was switched off in this run and the sha256 of the copy is the one its take recorded
      const takenText = normalized(tasks[taken])
      for (
        const part of [
          "slv_alpenglow_demoted_source | default('', true) != ''",
          'hostvars[slv_alpenglow_demoted_source].slv_vh_taken_sha256',
          'slv_vh_copy_stat.stat.checksum',
          'slv v set:identity -n',
        ]
      ) {
        assert(
          takenText.includes(part),
          `${path}: the file of this run: ${part}`,
        )
      }
      const index = (predicate: (task: Entry) => boolean) =>
        inner.findIndex(predicate)
      const upload2 = index((task) =>
        hasModule(task, 'copy') &&
        String((moduleArgs(task, 'copy') as Entry).dest).startsWith(
          '/mnt/ledger/vote_history-',
        )
      )
      const set = inner.indexOf(innerSetIdentity[0])
      const voter = index((task) =>
        /authorized-voter add/.test(commandOf(task))
      )
      const confirm = index((task) =>
        moduleArgs(task, 'import_tasks') ===
          '../cmn/tasks/vote_history_confirm.yml'
      )
      const remove = index((task) =>
        hasModule(task, 'file') &&
        (moduleArgs(task, 'file') as Entry).state === 'absent'
      )
      assert(
        upload2 >= 0 && upload2 < set && set < voter && voter < confirm &&
          confirm < remove,
        `${path}: upload, set-identity, authorized voter, confirmation, removal of the copy`,
      )
      const reader = index((task) =>
        moduleArgs(task, 'import_tasks') ===
          '../cmn/tasks/vote_history_last_vote.yml'
      )
      assert(
        reader >= 0 && reader < set,
        `${path}: the last vote is read first`,
      )
      assertEquals(
        (inner[reader].vars as Entry).slv_lv_identity,
        '{{ hostvars[inventory_hostname].identity_account }}',
        `${path}: the vote account has to belong to the identity`,
      )
      const copy = moduleArgs(inner[upload2], 'copy') as Entry
      assertEquals(
        [copy.owner, copy.group, copy.mode],
        ['solv', 'solv', '0644'],
        `${path}: the file gets the owner and mode agave gives it`,
      )
      assertEquals(
        inner[voter].failed_when,
        false,
        `${path}: the authorized-voter add reports through the task after it, so its own output stays out of the log`,
      )
      const voterStop = inner[voter + 1]
      assert(
        hasModule(voterStop, 'fail') &&
          conditionsOf(voterStop).includes(
            '(add_voter_result.rc | default(1)) != 0',
          ),
        `${path}: a failed authorized-voter add stops the play on Alpenglow`,
      )
      assert(
        normalized(voterStop).includes('Authorized voter already present'),
        `${path}: an authorized voter that is already there is not a failure`,
      )
      assertEquals(
        (inner[confirm].vars as Entry).slv_vh_baseline_sha256,
        '{{ slv_vh_uploaded.stat.checksum }}',
        `${path}: the baseline of the vote check is the uploaded file`,
      )
    }
  }
})

const freezeText =
  'identity changes wait until getAgGenesisCert returns a certificate'
const imminentText = 'Run the identity change after the genesis certificate'
const demotedText = 'are both unstaked now'
const fdctlMoveText = 'cannot move an identity on a cluster that runs Alpenglow'

const listYamlFiles = (directory: string): string[] =>
  [...Deno.readDirSync(new URL(directory, templateRoot))].flatMap((entry) =>
    entry.isDirectory
      ? listYamlFiles(`${directory}${entry.name}/`)
      : entry.name.endsWith('.yml')
      ? [`${directory}${entry.name}`]
      : []
  )

const base58Alphabet = '[1-9A-HJ-NP-Za-km-z]{32,44}'
const isBase58Guard = (task: Entry) =>
  hasModule(task, 'assert') && normalized(task).includes(base58Alphabet) &&
  normalized(task).includes('is match(')

Deno.test('base58 identity: an identity_account that is not a base58 public key stops the switch playbooks and the vote history take before they name a file on the controller', () => {
  for (const network of validatorNetworks) {
    // switch_off: before the file is looked for, the cluster is asked again and the source is demoted
    {
      const path = `ansible/${network}/switch_off_identity.yml`
      const tasks = tasksOf(readPlaybook(path)[0])
      const guard = firstIndex(tasks, isBase58Guard)
      const wait = firstIndex(
        tasks,
        (task) => /wait-for-restart-window/.test(commandOf(task)),
      )
      const demotion = firstIndex(
        tasks,
        (task) => /set-identity/.test(commandOf(task)),
      )
      const mode = firstIndex(
        tasks,
        (task) =>
          hasModule(task, 'set_fact') &&
          (moduleArgs(task, 'set_fact') as Entry).slv_switch_mode !== undefined,
      )
      assert(
        mode >= 0 && guard > mode && guard < wait && wait < demotion,
        `${path}: the identity is checked before the source waits or is demoted`,
      )
      assertEquals(
        conditionsOf(tasks[guard]),
        [],
        `${path}: the identity is checked in every mode`,
      )
      assert(
        normalized(tasks[guard]).includes(
          'hostvars[inventory_hostname].identity_account',
        ),
        `${path}: the guard reads the identity_account of the host`,
      )
    }
    // switch_on: before the key file and the vote history copy are looked for on the controller
    {
      const path = `ansible/${network}/switch_on_identity.yml`
      const tasks = tasksOf(readPlaybook(path)[0])
      const guard = firstIndex(tasks, isBase58Guard)
      const slurp = firstIndex(tasks, (task) => hasModule(task, 'slurp'))
      const block = firstIndex(tasks, (task) => Array.isArray(task.block))
      const probe = firstIndex(
        tasks,
        (task) => moduleArgs(task, 'import_tasks') === probeFile,
      )
      assert(
        guard >= 0 && guard < probe && probe < slurp && slurp < block,
        `${path}: the identity is checked before the probe, which stats a controller path built from it`,
      )
      assertEquals(
        conditionsOf(tasks[guard]),
        [],
        `${path}: the identity is checked in every mode`,
      )
    }
  }
  // the take: the first task, before the copy path is built from the identity
  const take = parse(
    readText('ansible/cmn/tasks/vote_history_take.yml'),
  ) as Entry[]
  assert(
    isBase58Guard(take[0]),
    'vote_history_take.yml: the identity is checked first',
  )
  assert(
    normalized(take[0]).includes('slv_vh_identity'),
    'vote_history_take.yml: the guard reads slv_vh_identity',
  )
  assert(
    take.slice(1).every((task) => !isBase58Guard(task)) &&
      normalized(take[1]).includes('slv_vh_copy'),
    'vote_history_take.yml: the copy path is built right after the check',
  )
})

Deno.test('base58 identity: every other playbook that builds a controller path from identity_account refuses a value that is not a base58 public key first, in every mode', () => {
  // set_identity_to_active, change_identity_and_restart and switch_on_firedancer_identity of testnet refuse without
  // reading anything, and the copy_keys.yml of the validators are gone: deploy never copies the staked key to a node
  const files = [
    ...validatorNetworks.flatMap((network) =>
      ['set_identity_key', 'switch_off_firedancer_identity'].map((file) =>
        `ansible/${network}/${file}.yml`
      )
    ),
    'ansible/mainnet-validator/switch_on_firedancer_identity.yml',
    'ansible/mainnet-rpc/copy_keys.yml',
    'ansible/cmn/copy_rpc_keys.yml',
  ]
  for (const path of files) {
    const tasks = tasksOf(readPlaybook(path)[0])
    const guard = firstIndex(tasks, isBase58Guard)
    assert(guard >= 0, `${path}: no base58 guard`)
    assertEquals(
      conditionsOf(tasks[guard]),
      [],
      `${path}: the identity is checked in every mode`,
    )
    assert(
      normalized(tasks[guard]).includes(
        'hostvars[inventory_hostname].identity_account',
      ),
      `${path}: the guard reads the identity_account of the host`,
    )
    // before the guard nothing is changed and no controller path is built: the gate on the validator
    // type, a fact, or another guard
    for (const before of tasks.slice(0, guard)) {
      assert(
        hasModule(before, 'assert') || hasModule(before, 'fail') ||
          hasModule(before, 'set_fact'),
        `${path}: "${before.name}" runs before the identity is checked`,
      )
      assert(
        !/identity_account|local_key_path|key_name/.test(normalized(before)),
        `${path}: "${before.name}" uses the identity before it is checked`,
      )
    }
    // and every task that builds a path from the identity comes after it
    const firstUse = firstIndex(
      tasks,
      (task) =>
        task !== tasks[guard] &&
        /identity_account|local_key_path/.test(normalized(task)),
    )
    assert(
      firstUse < 0 || guard < firstUse,
      `${path}: a path is built from the identity before it is checked`,
    )
  }
})

// The retired playbooks refuse. set_identity_to_active set the identity without the checks that slv v set:identity makes
// first (for a Firedancer host of testnet it also read a key file on the node); switch_on_firedancer_identity and
// change_identity_and_restart of testnet took the staked key from a file on the node, which a deploy never copies there:
// the key stays on the controller and reaches the node on stdin during slv v set:identity and slv v switch. Each is one
// play with one task that fails with a message that starts with SLV_KEYLESS_REFUSED, so nothing else runs.
const keylessRefusals: [string, string][] = [
  ['mainnet-validator', 'set_identity_to_active'],
  ['testnet-validator', 'set_identity_to_active'],
  ['testnet-validator', 'switch_on_firedancer_identity'],
  ['testnet-validator', 'change_identity_and_restart'],
]
const isKeylessRefusal = (network: string, file: string): boolean =>
  keylessRefusals.some(([n, f]) => n === network && f === file)

Deno.test('keyless: the retired playbooks are one play with one task that refuses', () => {
  for (const [directory, file] of keylessRefusals) {
    const path = `ansible/${directory}/${file}.yml`
    const plays = readPlaybook(path)
    assertEquals(plays.length, 1, `${path}: one play`)
    const tasks = tasksOf(plays[0])
    assertEquals(tasks.length, 1, `${path}: one task, so nothing else runs`)
    assert(hasModule(tasks[0], 'fail'), `${path}: the task fails`)
    assertEquals(conditionsOf(tasks[0]), [], `${path}: it always fails`)
    assertEquals(
      plays[0].become,
      undefined,
      `${path}: nothing is run as another user`,
    )
    const message = String((moduleArgs(tasks[0], 'fail') as Entry).msg)
    assert(
      message.startsWith('SLV_KEYLESS_REFUSED'),
      `${path}: the message starts with SLV_KEYLESS_REFUSED`,
    )
    const network = directory.replace('-validator', '')
    // the two Firedancer-only playbooks cannot name their own host: slv v set:identity refuses a Firedancer host of testnet
    const host = file === 'set_identity_to_active'
      ? '{{ inventory_hostname }}'
      : '<host>'
    for (
      const part of [
        'Nothing was changed on {{ inventory_hostname }}',
        `slv v set:identity -n ${network} -p ${host}`,
        `slv v switch -n ${network}`,
        `${file}.yml is retired.`,
      ]
    ) {
      assert(message.includes(part), `${path}: the message says: ${part}`)
    }
    // set_identity_to_active passed the staked key of the controller on stdin for its agave and jito hosts: it is retired
    // for the checks it left out, and the message must not say it read a key on the node
    assertEquals(
      message.includes('sets the identity from a staked key on the node'),
      false,
      `${path}: the message gives a reason that does not hold`,
    )
    if (file === 'set_identity_to_active') {
      assert(
        message.includes(
          'set the identity without the checks that the set:identity command of slv makes first',
        ),
        `${path}: the message gives the checks it left out`,
      )
    }
  }
  // nodowntime_migrate imports the play of testnet switch_on_firedancer_identity: one host that fails ends the run
  assertEquals(
    readPlaybook(
      'ansible/testnet-validator/switch_on_firedancer_identity.yml',
    )[0]
      .any_errors_fatal,
    true,
  )
})

Deno.test('keyless: no task of the template writes the staked key to a node', () => {
  const written: string[] = []
  for (const file of listYamlFiles('ansible/')) {
    for (const list of taskLists(parse(readText(file)))) {
      for (const task of list) {
        for (const module of ['copy', 'template', 'synchronize', 'fetch']) {
          const args = moduleArgs(task, module) as Entry | undefined
          if (
            args &&
            /(?:mainnet|testnet)-validator-keypair\.json/.test(
              String(args.dest),
            )
          ) {
            written.push(`${file}: ${task.name}`)
          }
        }
      }
    }
  }
  assertEquals(written, [], 'a staked key is written to a node')
})

// A node must not come back on the staked identity: every playbook of the two validator networks that starts or restarts
// the validator imports cmn/assert_unstaked_identity.yml before the first task that stops, starts or restarts it, so that
// a node whose identity.json or start script leads to the staked key stops there, with nothing stopped or started. The
// census follows the imports (a playbook that starts the validator through another one is found as well), and the list
// below is the answer to "which playbooks start or restart the validator": a new one has to be added to it, with its check.
type ServiceEvent = 'assert' | 'stop' | 'start'
const identityAssert = 'ansible/cmn/assert_unstaked_identity.yml'
const unitName = /^(?:solv|firedancer)(?:\.service)?$/

const serviceEventOf = (task: Entry): ServiceEvent | undefined => {
  for (const module of ['systemd', 'service']) {
    const args = moduleArgs(task, module) as Entry | undefined
    if (args && unitName.test(String(args.name)) && args.state !== undefined) {
      return String(args.state) === 'stopped' ? 'stop' : 'start'
    }
  }
  const command = commandOf(task)
  if (/systemctl\s+stop\s+(?:solv|firedancer)\b/.test(command)) return 'stop'
  // agave-validator exit ends the process and systemd starts it again
  if (
    /systemctl\s+(?:start|restart)\s+(?:solv|firedancer)\b/.test(command) ||
    /agave-validator\b[^\n]*\sexit\b/.test(command)
  ) {
    return 'start'
  }
  return undefined
}

const taskEvents = (tasks: Entry[]): ServiceEvent[] =>
  tasks.flatMap((task) => {
    const nested = ['block', 'rescue', 'always'].flatMap((key) =>
      Array.isArray(task[key]) ? taskEvents(task[key] as Entry[]) : []
    )
    const own = serviceEventOf(task)
    return own ? [own, ...nested] : nested
  })

const serviceEvents = (path: string, trail: string[] = []): ServiceEvent[] => {
  // an import of a playbook that is not there (the legacy init-jito.yml and init-allnodes-jito.yml import a
  // wget_snapshot.yml that their directory does not have) runs nothing
  if (trail.includes(path) || !existsSync(new URL(path, templateRoot))) {
    return []
  }
  return readPlaybook(path).flatMap((entry) => {
    if (entry.import_playbook !== undefined) {
      const target = new URL(
        String(entry.import_playbook),
        new URL(path, templateRoot),
      )
      const relative = target.href.slice(templateRoot.href.length)
      return relative === identityAssert
        ? ['assert' as ServiceEvent]
        : serviceEvents(relative, [...trail, path])
    }
    return ['pre_tasks', 'tasks', 'post_tasks'].flatMap((key) =>
      Array.isArray(entry[key]) ? taskEvents(entry[key] as Entry[]) : []
    )
  })
}

const startsOrRestartsTheValidator = [
  'ansible/mainnet-validator/init-allnodes-jito.yml',
  'ansible/mainnet-validator/init-firedancer.yml',
  'ansible/mainnet-validator/init-jito.yml',
  'ansible/mainnet-validator/init.yml',
  'ansible/mainnet-validator/restart_node.yml',
  'ansible/mainnet-validator/start-solv-service.yml',
  'ansible/mainnet-validator/start_firedancer.yml',
  'ansible/mainnet-validator/start_node.yml',
  'ansible/mainnet-validator/start_solv.yml',
  'ansible/testnet-validator/init-agave.yml',
  'ansible/testnet-validator/init-firedancer.yml',
  'ansible/testnet-validator/init.yml',
  'ansible/testnet-validator/restart_agave_with_rm_ledger.yml',
  'ansible/testnet-validator/restart_firedancer.yml',
  'ansible/testnet-validator/restart_firedancer_with_rm_ledger.yml',
  'ansible/testnet-validator/restart_node.yml',
  'ansible/testnet-validator/restart_solv.yml',
  'ansible/testnet-validator/start_firedancer.yml',
  'ansible/testnet-validator/start_node.yml',
  'ansible/testnet-validator/start_solv.yml',
]

Deno.test('unstaked identity: a playbook that starts or restarts the validator checks the identity before it stops or starts anything', () => {
  const found: string[] = []
  for (const network of validatorNetworks) {
    for (const file of listYamlFiles(`ansible/${network}/`)) {
      const events = serviceEvents(file)
      if (!events.includes('start')) continue
      found.push(file)
      const check = events.indexOf('assert')
      const first = events.findIndex((event) => event !== 'assert')
      assert(
        check >= 0 && check < first,
        `${file}: the identity is not checked before the first stop or start (${
          events.join(' ')
        })`,
      )
    }
  }
  assertEquals(found.sort(), startsOrRestartsTheValidator)
})

// every task that reads a key file from the controller keeps what it reads out of the log, and a missing key
// file is still reported by a task of its own
const taskLists = (value: unknown): Entry[][] => {
  const lists: Entry[][] = []
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      if (node.every((item) => item !== null && typeof item === 'object')) {
        lists.push(node as Entry[])
      }
      node.forEach(walk)
    } else if (node !== null && typeof node === 'object') {
      Object.values(node as Entry).forEach(walk)
    }
  }
  walk(value)
  return lists
}
const readsKeyFile = (task: Entry): boolean => {
  const slurp = moduleArgs(task, 'slurp') as Entry | undefined
  if (slurp && /local_key_path|\.slv\/keys/.test(String(slurp.src))) {
    return true
  }
  for (const module of ['copy', 'fetch', 'template']) {
    const args = moduleArgs(task, module) as Entry | undefined
    if (args && /\.slv\/keys/.test(String(args.src))) return true
  }
  return false
}

Deno.test('no_log: every task that reads a key file from the controller has it, and a missing key file is reported by a task of its own', () => {
  let seen = 0
  const files = listYamlFiles('ansible/').filter((file) =>
    !file.startsWith('ansible/cmn/firewall/')
  )
  for (const file of files) {
    for (const list of taskLists(parse(readText(file)))) {
      list.forEach((task, index) => {
        if (!readsKeyFile(task)) return
        seen += 1
        assertEquals(
          task.no_log,
          true,
          `${file}: "${task.name}" reads a key file and must not log it`,
        )
        const missing = list.slice(0, index).some((before) =>
          hasModule(before, 'fail') &&
          normalized(before).includes('Key file not found')
        )
        assert(
          missing,
          `${file}: "${task.name}" has no stop for a missing key file before it`,
        )
      })
    }
  }
  // set_identity_key and switch_on_identity of both networks read the key with slurp; mainnet-rpc/copy_keys and
  // cmn/copy_rpc_keys copy the key of an RPC node. The validators have no copy_keys.yml (deploy never copies a staked key
  // to a node), and set_identity_to_active is retired.
  assertEquals(seen, 6, 'the tasks that read a key file')
})

// a task that passes a key on stdin keeps its arguments out of the log (ansible-core 2.16 prints them at -vvv, and
// stdin is the key), does not fail by itself, and the task after it fails when the return code is not 0 and says
// what the command printed, so that what agave said stays visible and the key does not. The authorized-voter add of
// the TowerBFT paths is the exception: it never stops a run on a return code, and the task after it says when the step
// did not run to its end
const listAnsibleFiles = (directory: string): string[] =>
  [...Deno.readDirSync(new URL(directory, templateRoot))].flatMap((entry) =>
    entry.isDirectory
      ? listAnsibleFiles(`${directory}${entry.name}/`)
      : /\.ya?ml$/.test(entry.name)
      ? [`${directory}${entry.name}`]
      : []
  )
// the lists of tasks that sit in a block with a rescue: a task that fails there is reported by the rescue
const rescuedLists = (value: unknown): Set<Entry[]> => {
  const lists = new Set<Entry[]>()
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      node.forEach(walk)
    } else if (node !== null && typeof node === 'object') {
      const entry = node as Entry
      if (Array.isArray(entry.block) && Array.isArray(entry.rescue)) {
        lists.add(entry.block as Entry[])
      }
      Object.values(entry).forEach(walk)
    }
  }
  walk(value)
  return lists
}
const stdinOf = (task: Entry): unknown => {
  for (const value of Object.values(task)) {
    if (
      value !== null && typeof value === 'object' && !Array.isArray(value) &&
      'stdin' in value
    ) {
      return (value as Entry).stdin
    }
  }
  return undefined
}

Deno.test('no_log: every task that passes a key on stdin has it and does not fail by itself, and the task after it fails with what the command printed', () => {
  const seen: string[] = []
  const lenient: string[] = []
  const files = listAnsibleFiles('ansible/').filter((file) =>
    !file.startsWith('ansible/cmn/firewall/')
  )
  for (const file of files) {
    const parsed = parse(readText(file))
    const rescued = rescuedLists(parsed)
    for (const list of taskLists(parsed)) {
      list.forEach((task, index) => {
        if (stdinOf(task) === undefined) return
        const label = `${file}: ${task.name}`
        seen.push(label)
        assertEquals(
          task.no_log,
          true,
          `${label} passes a key on stdin and must not log its arguments`,
        )
        assertEquals(
          task.failed_when,
          false,
          `${label} must not fail by itself, its failure would show nothing`,
        )
        const register = String(task.register ?? '')
        const next = list[index + 1]
        const text = next === undefined ? '' : normalized(next)
        const reports = register.length > 0 && next !== undefined &&
          hasModule(next, 'fail') &&
          conditionsOf(next).includes(`(${register}.rc | default(1)) != 0`) &&
          [`${register}.stdout`, `${register}.stderr`].every((part) =>
            text.includes(part)
          )
        if (!reports) {
          // the authorized-voter add of the TowerBFT paths never stops a run on a return code; a step that did not run
          // to its end (no return code) is reported by the task after it
          lenient.push(label)
          assertEquals(
            task.ignore_errors,
            true,
            `${label} never stops the play on a return code, and a step that does not run to its end is reported by the task after it`,
          )
          assert(
            register.length > 0 && next !== undefined &&
              hasModule(next, 'fail') &&
              conditionsOf(next).includes(`${register} is failed`) &&
              text.includes(`${register}.msg`),
            `${label}: the task after it says what the step said when it did not run to its end`,
          )
        }
        // a step that runs out of time (timeout) has no return code, and the failure of the step itself would show nothing:
        // outside a rescue the task after it reports that too
        if (reports && task.timeout !== undefined && !rescued.has(list)) {
          assertEquals(
            task.ignore_errors,
            true,
            `${label} runs out of time without a return code, and the task after it says so`,
          )
        }
      })
    }
  }
  // set_identity_key (2) and switch_on_identity (4) of both networks, and the public key of WireGuard
  assertEquals(seen.length, 13, 'the tasks that pass a key on stdin')
  // the authorized-voter add of the TowerBFT path of switch_on_identity never stopped a run on a return code, it still does not
  assertEquals(
    lenient.sort(),
    validatorNetworks.map((network) =>
      `ansible/${network}/switch_on_identity.yml: Add Authorized Voter via stdin`
    ).sort(),
    'the tasks that do not stop the play on a return code',
  )
})

// the WireGuard tasks that handle the private key: no_log keeps the key out of the log (a result prints at -v), the two
// copies that write it return no diff (copy masks `content` in its arguments, but --diff shows it), and a failure that
// no_log hides is reported by the task after it
Deno.test('no_log: the WireGuard tasks that handle the private key keep it out of the log, and a failure they would hide is reported by the task after them', () => {
  const tasks = (parse(
    readText('ansible/cmn/software/install-wireguard.yaml'),
  ) as Entry[]).flatMap(tasksOf)
  const handlesKey = (task: Entry): boolean =>
    /wg_private_key_value|existing_priv|new_priv|wg genkey|wg_private_key_path/
      .test(JSON.stringify(task))
  const handled: string[] = []
  for (const task of tasks) {
    // the stops and the assert say a text of their own, never a value
    if (hasModule(task, 'fail') || hasModule(task, 'assert')) continue
    if (!handlesKey(task) && stdinOf(task) === undefined) continue
    handled.push(String(task.name))
    const copy = moduleArgs(task, 'copy') as Entry | undefined
    if (copy?.content !== undefined) {
      assertEquals(
        task.diff,
        false,
        `${task.name} writes the private key and must not return a diff`,
      )
      continue
    }
    assertEquals(
      task.no_log,
      true,
      `${task.name} handles the private key and must not log it`,
    )
  }
  assertEquals(handled, [
    'Read existing private key if present',
    'Set private key if exists',
    'Generate new private key if missing or invalid',
    'Set private key from newly generated key',
    'Save private key',
    'Generate public key',
    'Create WireGuard config',
  ])
  const after = (name: string): Entry => {
    const index = tasks.findIndex((task) => task.name === name)
    assert(index >= 0, name)
    return tasks[index + 1]
  }
  const named = (name: string): Entry => {
    const task = tasks.find((candidate) => candidate.name === name)
    assert(task, name)
    return task
  }
  // the key in the file: a missing file is no failure (the key is generated), a fact that fails says why
  assertEquals(
    named('Read existing private key if present').ignore_errors,
    true,
  )
  const fact = named('Set private key if exists')
  assertEquals([fact.register, fact.ignore_errors], ['wg_existing_key', true])
  const factStop = after('Set private key if exists')
  assert(
    hasModule(factStop, 'fail') &&
      conditionsOf(factStop).includes('wg_existing_key is failed') &&
      normalized(factStop).includes('wg_existing_key.msg'),
    'a private key in the file that cannot be read is reported',
  )
  // wg genkey prints the key: its stop shows the return code and what went wrong, never its stdout
  const genkey = named('Generate new private key if missing or invalid')
  assertEquals([genkey.register, genkey.failed_when], ['new_priv', false])
  const genkeyStop = after('Generate new private key if missing or invalid')
  assert(
    hasModule(genkeyStop, 'fail') &&
      conditionsOf(genkeyStop).includes('(new_priv.rc | default(1)) != 0'),
    'a wg genkey that fails is reported',
  )
  assert(
    !normalized(genkeyStop).includes('new_priv.stdout') &&
      normalized(genkeyStop).includes('new_priv.stderr'),
    'the report of wg genkey never shows its stdout, which is the key',
  )
})

// copy masks `content` in its arguments, but --diff prints it: a copy that writes a private key returns no diff
Deno.test('no_log: every copy that writes a private key from its content returns no diff', () => {
  const writesKey = /private key|origin_key|wg_private_key_value|PrivateKey/i
  const found: string[] = []
  const files = listAnsibleFiles('ansible/').filter((file) =>
    !file.startsWith('ansible/cmn/firewall/')
  )
  for (const file of files) {
    for (const list of taskLists(parse(readText(file)))) {
      for (const task of list) {
        const copy = moduleArgs(task, 'copy') as Entry | undefined
        if (copy?.content === undefined) continue
        if (!writesKey.test(JSON.stringify(task))) continue
        found.push(`${file}: ${task.name}`)
        assertEquals(
          task.diff,
          false,
          `${file}: "${task.name}" writes a private key and must not return a diff`,
        )
      }
    }
  }
  assertEquals(found.sort(), [
    'ansible/cmn/software/install-nginx.yaml: Write caller-supplied origin private key',
    'ansible/cmn/software/install-wireguard.yaml: Create WireGuard config',
    'ansible/cmn/software/install-wireguard.yaml: Save private key',
  ])
})

Deno.test('the last vote reader refuses a vote account of another identity, and every caller says whose it is', () => {
  const reader = readText('ansible/cmn/tasks/vote_history_last_vote.yml')
  const tasks = parse(reader) as Entry[]
  const refusal = tasks.find((task) =>
    hasModule(task, 'fail') && normalized(task).includes('nodePubkey')
  )
  assert(refusal, 'the reader refuses a vote account of another identity')
  assertEquals(conditionsOf(refusal), [
    "slv_lv_identity | default('', true) | length > 0",
    "slv_lv_node | default('', true) | length > 0",
    'slv_lv_node != slv_lv_identity',
  ])
  const deadPrimary = parse(
    readText('ansible/cmn/tasks/vote_history_dead_primary.yml'),
  ) as Entry[]
  const read = deadPrimary.find((task) =>
    moduleArgs(task, 'import_tasks') === 'vote_history_last_vote.yml'
  )
  assert(read, 'the dead primary checks read the last vote')
  assertEquals((read.vars as Entry).slv_lv_identity, '{{ slv_dp_identity }}')
})

Deno.test('the dead primary checks read the last vote from the RPC of the host as well and use the larger one', () => {
  const tasks = parse(
    readText('ansible/cmn/tasks/vote_history_dead_primary.yml'),
  ) as Entry[]
  const own = tasks.find((task) =>
    hasModule(task, 'uri') &&
    normalized(task).includes('getVoteAccounts') &&
    normalized(task).includes('slv_target_rpc_url')
  )
  assert(own, 'this host is asked for the last vote of the vote account')
  assertEquals(own.no_log, true)
  const larger = tasks.find((task) =>
    hasModule(task, 'set_fact') &&
    (moduleArgs(task, 'set_fact') as Entry).slv_dp_last !== undefined
  )
  assert(larger, 'the larger last vote is kept')
  assert(
    normalized(larger).includes('slv_lv_last') &&
      normalized(larger).includes('slv_dp_own_last') &&
      normalized(larger).includes('| max'),
    'the cluster and the host are compared with max',
  )
  // an unreadable answer of the cluster still stops the play: the host cannot make up for it
  assert(
    normalized(larger).includes('if (slv_lv_last | int(-1)) >= 0 else -1'),
    'the host does not stand in for an unreadable answer of the cluster',
  )
  for (
    const name of [
      'Check that nothing votes with the identity',
      'Check that this host has caught up',
    ]
  ) {
    const check = tasks.find((task) => task.name === name)
    assert(check, name)
    assert(
      normalized(check).includes('slv_dp_last | int(-1)') &&
        !normalized(check).includes('slv_lv_last'),
      `${name}: judged on the larger last vote`,
    )
  }
  // the host is the second opinion, not an extra: an answer of the host that cannot be read, or that does not list the
  // vote account, fails check 1 and is not made up for by the value of the cluster
  const quiet = normalized(
    tasks.find((task) =>
      task.name === 'Check that nothing votes with the identity'
    ),
  )
  assert(
    quiet.includes('(slv_dp_own_last | int(-1)) < 0'),
    'check 1 fails when the host shows no last vote',
  )
  for (
    const text of [
      'the RPC of this host did not give a readable answer to getVoteAccounts',
      'the RPC of this host does not list the vote account',
    ]
  ) {
    assert(quiet.includes(text), `check 1 says what the host did: ${text}`)
  }
})

Deno.test('the gossip check compares the gossip socket of the entry of the identity only', () => {
  const text = readText('ansible/cmn/tasks/vote_history_dead_primary.yml')
  const code = text.split('\n').filter((line) => !line.trim().startsWith('#'))
    .join('\n')
  assert(code.includes("node['gossip']"), 'the gossip socket is read')
  for (
    const socket of [
      'tpuQuic',
      'tpuForwards',
      'tpuVote',
      'serveRepair',
      'pubsub',
    ]
  ) {
    assert(!code.includes(socket), `no code compares the ${socket} socket`)
  }
})

Deno.test('the texts of the playbooks that name slv v set:identity or slv v switch name the network of the run', () => {
  for (const file of listYamlFiles('ansible/')) {
    if (file.startsWith('ansible/cmn/firewall/')) continue
    const lines = readText(file).split('\n')
    lines.forEach((line, number) => {
      if (line.trim().startsWith('#')) return
      for (const match of line.matchAll(/slv v (set:identity|switch)/g)) {
        const rest = line.slice((match.index ?? 0) + match[0].length)
        assert(
          rest.startsWith(' -n '),
          `${file}:${number + 1}: "${match[0]}" is named without -n: ${
            line.trim().slice(0, 120)
          }`,
        )
      }
    })
  }
})

Deno.test('alpenglow state: the probe asks the cluster from the controller and the freeze is written once', () => {
  const path = 'ansible/cmn/tasks/alpenglow_state.yml'
  const tasks = readPlaybook(path)
  const requests = tasks.filter((task) => hasModule(task, 'uri'))
  assertEquals(
    requests.map((task) =>
      (moduleArgs(task, 'uri') as { body: { method: string } }).body.method
    ),
    ['getAgGenesisCert', 'getAccountInfo', 'getEpochInfo'],
  )
  for (const task of requests) {
    const uri = moduleArgs(task, 'uri') as Entry
    assertEquals(String(uri.method).toUpperCase(), 'POST')
    assertEquals(uri.body_format, 'json')
    assertEquals((uri.body as Entry).jsonrpc, '2.0')
    assertEquals(task.delegate_to, 'localhost', `${task.name}: delegate_to`)
    assertEquals(task.run_once, true, `${task.name}: run_once`)
    assertEquals(task.check_mode, false, `${task.name}: check_mode`)
    assertEquals(task.become, false, `${task.name}: become`)
    assertEquals(task.failed_when, false, `${task.name}: failed_when`)
    assertEquals(
      task.no_log,
      true,
      `${task.name}: no_log keeps a keyed URL out`,
    )
  }
  assertEquals(
    ((moduleArgs(requests[1], 'uri') as Entry).body as Entry).params,
    [
      'A1pengvuM6JEcyNuTnMqepBKhwHE3N6PmUrdATGawhJS',
      {
        encoding: 'base64',
        dataSlice: { offset: 0, length: 1 },
        commitment: 'processed',
      },
    ],
  )
  assertEquals(
    ((moduleArgs(requests[2], 'uri') as Entry).body as Entry).params,
    [{ commitment: 'processed' }],
  )
  assertEquals(conditionsOf(requests[2]), [
    "slv_ag_feature_kind == 'inactive'",
  ])
  const text = readText(path)
  assert(text.includes('slv_alpenglow_margin_slots | default(3000)'), path)
  for (
    const url of [
      'https://api.mainnet-beta.solana.com',
      'https://api.testnet.solana.com',
      'https://api.devnet.solana.com',
    ]
  ) {
    assert(text.includes(url), `${path}: public RPC ${url}`)
  }
  const refusals = tasks.filter((task) =>
    /^Stop (the|an) identity change/.test(String(task.name))
  )
  assertEquals(refusals.length, 3, `${path}: three refusals`)
  const freeze = 'slv_alpenglow_freeze | default(false) | bool'
  for (const refusal of refusals) {
    assert(hasModule(refusal, 'assert'), `${path}: the refusals are asserts`)
  }
  // unknown does not stop a promotion that goes on without a reading (see the demotion test)
  assertEquals(conditionsOf(refusals[0]), [
    freeze,
    'not (slv_ag_resume | default(false) | bool)',
  ])
  assertEquals(conditionsOf(refusals[1]), [freeze])
  assertEquals(conditionsOf(refusals[2]), [freeze])
  assert(normalized(refusals[0]).includes(freezeText))
  assert(normalized(refusals[0]).includes("not in ['window', 'unknown']"))
  assert(normalized(refusals[1]).includes(imminentText))
  assert(normalized(refusals[1]).includes("slv_alpenglow_state != 'imminent'"))
  assert(normalized(refusals[2]).includes(fdctlMoveText))
  assert(
    normalized(refusals[2]).includes(
      "slv_alpenglow_state != 'alpenglow' or (slv_alpenglow_move_types | default([])",
    ),
  )
  for (const type of ['firedancer-agave', 'firedancer-jito', 'frankendancer']) {
    assert(normalized(refusals[2]).includes(`'${type}'`), `refuses ${type}`)
  }

  for (
    const sentence of [freezeText, imminentText, demotedText, fdctlMoveText]
  ) {
    const writers = listYamlFiles('ansible/').filter((file) =>
      readText(file).includes(sentence)
    )
    assertEquals(writers, [path], `"${sentence}" has one author`)
  }
})

Deno.test('alpenglow demotion: nodowntime_migrate tells the switch_on plays which source host it demoted', () => {
  for (const network of validatorNetworks) {
    const entries = readPlaybook(`ansible/${network}/nodowntime_migrate.yml`)
    const imports = entries.filter((entry) =>
      entry.import_playbook !== undefined
    )
    assertEquals(imports.length, 4)
    for (const entry of imports) {
      const demoted = (entry.vars as Entry).slv_alpenglow_demoted_source
      if (String(entry.import_playbook).startsWith('switch_on_')) {
        assertEquals(
          demoted,
          '{{ source_host }}',
          `${network}: ${entry.import_playbook}`,
        )
      } else {
        assertEquals(demoted, undefined, `${network}: ${entry.import_playbook}`)
      }
    }
  }
})

Deno.test('alpenglow demotion: the probe is patient after a demotion, and a promotion goes on with the tower or the vote history file only when the cluster stays unread and the run is young', () => {
  const path = 'ansible/cmn/tasks/alpenglow_state.yml'
  const tasks = readPlaybook(path)
  const named = (prefix: string): number => {
    const index = tasks.findIndex((task) =>
      String(task.name).startsWith(prefix)
    )
    assert(index >= 0, `${path}: no task named "${prefix}"`)
    return index
  }

  // patience: only for a probe with the freeze on after a demotion that followed a reading
  const patience = named(
    'Work out how long a call that cannot be read is retried',
  )
  const facts = moduleArgs(tasks[patience], 'set_fact') as Entry
  for (
    const part of [
      'slv_alpenglow_freeze | default(false) | bool',
      "slv_alpenglow_demoted_source | default('', true) != ''",
      "hostvars[slv_alpenglow_demoted_source].slv_pre_demotion_state | default('')) in ['towerbft', 'alpenglow']",
      'slv_alpenglow_patience_seconds | default(60)',
    ]
  ) {
    assert(
      normalized(facts.slv_ag_give_up_at).includes(part),
      `patience: ${part}`,
    )
  }
  assert(
    normalized(facts.slv_ag_patient_retries).includes(
      'slv_alpenglow_rpc_delay',
    ),
    'patience: retries follow the delay',
  )
  const requests = tasks.filter((task) => hasModule(task, 'uri'))
  assertEquals(requests.length, 3)
  for (const task of requests) {
    assert(
      tasks.indexOf(task) > patience,
      `${task.name}: asked after the patience is set`,
    )
    assert(
      normalized(task.until).includes('slv_ag_give_up_at'),
      `${task.name}: the deadline ends the retries`,
    )
    assert(
      normalized(task.retries).includes('slv_ag_patient_retries'),
      `${task.name}: patient retries`,
    )
  }

  // the decision: unknown, after a TowerBFT or an Alpenglow reading, less than half of the margin
  // at 0.4 s a slot, and never into the vote history path with a Firedancer host
  const decide = named('Decide which consensus the cluster runs')
  const resume = named(
    'Work out whether the promotion goes on although the cluster could not be read',
  )
  assert(resume > decide, `${path}: the decision follows the state`)
  const resumeFacts = moduleArgs(tasks[resume], 'set_fact') as Entry
  for (
    const part of [
      "slv_alpenglow_state == 'unknown'",
      'slv_ag_give_up_at | default(0) | int) > 0',
      "hostvars[slv_alpenglow_demoted_source].slv_pre_demotion_state | default('')) in ['towerbft', 'alpenglow']",
      'slv_pre_demotion_probe_at',
      '(slv_alpenglow_margin_slots | default(3000) | int) * (slv_alpenglow_min_slot_seconds | default(0.2) | float) / 2',
      "== 'towerbft' or (slv_alpenglow_move_types | default([]) | intersect(['firedancer-agave', 'firedancer-jito', 'frankendancer']) | length) == 0",
    ]
  ) {
    assert(
      String(resumeFacts.slv_ag_resume).replaceAll(/\s+/g, ' ').includes(part),
      `resume: ${part}`,
    )
  }
  assert(
    normalized(resumeFacts.slv_ag_resume_mode).includes(
      'hostvars[slv_alpenglow_demoted_source].slv_pre_demotion_state',
    ),
    'resume: the mode is what the cluster ran at the reading',
  )
  const refusal = named('Stop the identity change while the cluster is between')
  assert(refusal > resume, `${path}: the decision comes before the refusals`)
  const say = named(
    'Say that the promotion goes on although the cluster could not be read',
  )
  assertEquals(conditionsOf(tasks[say]), [
    'slv_alpenglow_freeze | default(false) | bool',
    'slv_ag_resume | default(false) | bool',
  ])

  // the switch_off plays keep the reading right before the demotion; switch_on follows it
  for (const network of validatorNetworks) {
    for (
      const file of ['switch_off_identity', 'switch_off_firedancer_identity']
    ) {
      const playbook = `ansible/${network}/${file}.yml`
      const list = tasksOf(readPlaybook(playbook)[0])
      const factOf = (name: string): number =>
        list.findIndex((task) =>
          hasModule(task, 'set_fact') &&
          (moduleArgs(task, 'set_fact') as Entry)[name] !== undefined
        )
      const probes = list.flatMap((task, index) =>
        moduleArgs(task, 'import_tasks') === probeFile ? [index] : []
      )
      const at = factOf('slv_pre_demotion_probe_at')
      const state = factOf('slv_pre_demotion_state')
      const demotion = firstIndex(
        list,
        (task) => /set-identity/.test(commandOf(task)),
      )
      assert(
        at >= 0 && at < probes[1] && at > probes[0],
        `${playbook}: the time is taken before the probe right before the demotion`,
      )
      assertEquals(
        (moduleArgs(list[at], 'set_fact') as Entry).slv_pre_demotion_probe_at,
        '{{ now(utc=true).timestamp() | int }}',
      )
      assert(
        state > probes[1] && state < demotion,
        `${playbook}: the state is kept after the probe and before the demotion`,
      )
      assertEquals(
        (moduleArgs(list[state], 'set_fact') as Entry).slv_pre_demotion_state,
        '{{ slv_alpenglow_state }}',
      )
      // nothing is kept for a demotion that the guards refuse
      assert(
        list.slice(probes[1] + 1, state).some((task) =>
          hasModule(task, 'assert')
        ),
        `${playbook}: a guard stands between the probe and the facts`,
      )
    }
    const onTasks = tasksOf(
      readPlaybook(`ansible/${network}/switch_on_identity.yml`)[0],
    )
    const mode = onTasks.find((task) =>
      hasModule(task, 'set_fact') &&
      (moduleArgs(task, 'set_fact') as Entry).slv_switch_mode !== undefined
    )
    assert(mode)
    assertEquals(
      (moduleArgs(mode, 'set_fact') as Entry).slv_switch_mode,
      '{{ slv_ag_resume_mode if (slv_ag_resume | default(false) | bool) else slv_alpenglow_state }}',
      `${network}: switch_on takes the path of the reading before the demotion when the promotion goes on without a reading`,
    )
  }
})

const identityPlaybooks = [
  'switch_off_identity',
  'switch_off_firedancer_identity',
  'switch_on_identity',
  'switch_on_firedancer_identity',
  'set_identity_key',
  'set_unstaked_key',
  'set_identity_to_active',
  'nodowntime_migrate',
]

// the validator types that take part in an identity move: the probe stops a Firedancer or
// Frankendancer host in one while the cluster runs Alpenglow
const moveTypesOf = (file: string): Entry => {
  if (
    [
      'switch_off_identity',
      'switch_off_firedancer_identity',
      'switch_on_identity',
      'switch_on_firedancer_identity',
      'set_identity_key',
    ].includes(file)
  ) {
    return { slv_alpenglow_move_types: ["{{ validator_type | default('') }}"] }
  }
  if (file === 'nodowntime_migrate') {
    return {
      slv_alpenglow_move_types: [
        "{{ hostvars[source_host].validator_type | default('') }}",
        "{{ hostvars[target_host].validator_type | default('') }}",
      ],
    }
  }
  return {}
}

Deno.test('alpenglow freeze: every identity playbook imports the probe with the freeze on before it changes anything', () => {
  for (const network of validatorNetworks) {
    for (const file of identityPlaybooks) {
      // a playbook that only refuses changes no identity and asks the cluster nothing
      if (isKeylessRefusal(network, file)) continue
      const path = `ansible/${network}/${file}.yml`
      const tasks = tasksOf(readPlaybook(path)[0])
      const probe = firstIndex(
        tasks,
        (task) => moduleArgs(task, 'import_tasks') === probeFile,
      )
      assert(probe >= 0, `${path}: imports the probe`)
      assertEquals(
        tasks[probe].vars,
        {
          slv_alpenglow_network: network.replace('-validator', ''),
          slv_alpenglow_freeze: true,
          ...moveTypesOf(file),
        },
        `${path}: probe variables`,
      )
      for (const before of tasks.slice(0, probe)) {
        assert(
          hasModule(before, 'assert') || hasModule(before, 'fail') ||
            hasModule(before, 'set_fact'),
          `${path}: "${before.name}" runs before the probe`,
        )
      }
    }
  }
})

Deno.test('alpenglow fdctl: mainnet refuses Firedancer and Frankendancer as an identity target, testnet does not', () => {
  const message = 'Firedancer and Frankendancer cannot take a mainnet identity'
  const fdctlTypes = ['firedancer-agave', 'firedancer-jito', 'frankendancer']
  const isChange = (task: Entry) =>
    hasModule(task, 'shell') || hasModule(task, 'copy') ||
    hasModule(task, 'fetch') || hasModule(task, 'ping')
  const refusalOf = (path: string, tasks: Entry[]) => {
    const refusal = firstIndex(
      tasks,
      (task) =>
        (hasModule(task, 'assert') || hasModule(task, 'fail')) &&
        normalized(task).includes(message),
    )
    assert(refusal >= 0, `${path}: refuses an fdctl target`)
    assert(
      refusal < firstIndex(tasks, isChange),
      `${path}: refuses before it changes anything`,
    )
    return tasks[refusal]
  }

  const mainnet = (file: string) => `ansible/mainnet-validator/${file}.yml`
  // switch_on_firedancer_identity is an fdctl target by definition: no condition
  const unconditional = refusalOf(
    mainnet('switch_on_firedancer_identity'),
    tasksOf(readPlaybook(mainnet('switch_on_firedancer_identity'))[0]),
  )
  assert(hasModule(unconditional, 'fail'))
  assertEquals(conditionsOf(unconditional), [])

  for (const file of ['set_identity_key']) {
    const task = refusalOf(
      mainnet(file),
      tasksOf(readPlaybook(mainnet(file))[0]),
    )
    assert(hasModule(task, 'assert'))
    for (const type of fdctlTypes) {
      assert(normalized(task).includes(`'${type}'`), `${file}: ${type}`)
    }
    assert(normalized(task).includes('validator_type not in'), file)
  }

  // nodowntime_migrate says so in its first play, before switch_off demotes the source
  const migrate = refusalOf(
    mainnet('nodowntime_migrate'),
    tasksOf(readPlaybook(mainnet('nodowntime_migrate'))[0]),
  )
  assert(
    normalized(migrate).includes('hostvars[target_host].validator_type'),
    'nodowntime_migrate: the target decides',
  )
  for (const type of fdctlTypes) {
    assert(normalized(migrate).includes(`'${type}'`))
  }

  for (const file of [...identityPlaybooks, 'change_identity_and_restart']) {
    const path = `ansible/testnet-validator/${file}.yml`
    try {
      assert(!readText(path).includes(message), `${path}: testnet is unchanged`)
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error
    }
  }
})

Deno.test('addendum 12: init.yml and update_startup_config.yml stop on a missing or unknown validator_type and never default to Frankendancer', () => {
  for (const network of validatorNetworks) {
    for (const file of ['init.yml', 'update_startup_config.yml']) {
      const path = `ansible/${network}/${file}`
      assertNoTypeFallback(path)
      const entries = readPlaybook(path)
      assertTypeGate(
        firstTypeTask(tasksOf(withoutBootstrapImport(entries)[0])),
        path,
      )
      assert(!readText(path).includes('Set validator type fact'), path)
    }
    assertEquals(
      withoutBootstrapImport(readPlaybook(`ansible/${network}/init.yml`))[0]
        .any_errors_fatal,
      true,
      `${network} init.yml: one bad host ends the run`,
    )
  }
})

const taskKeywords = new Set([
  'name',
  'when',
  'register',
  'become',
  'become_user',
  'failed_when',
  'changed_when',
  'check_mode',
  'ignore_unreachable',
  'ignore_errors',
  'args',
  'vars',
  'loop',
  'delegate_to',
  'run_once',
  'timeout',
  'environment',
])

Deno.test('behavior 6: read_running_identity prints one marker line per host and cannot fail or change a host', () => {
  const path = 'ansible/cmn/read_running_identity.yml'
  const plays = readPlaybook(path)
  assertEquals(plays.length, 1)
  assertEquals(plays[0].hosts, 'all')
  const tasks = tasksOf(plays[0])

  const modules = tasks.map((task) =>
    Object.keys(task).find((key) => !taskKeywords.has(key))?.replace(
      'ansible.builtin.',
      '',
    )
  )
  for (const module of modules) {
    assert(
      ['shell', 'command', 'set_fact', 'debug'].includes(String(module)),
      `${path}: unexpected module ${module}`,
    )
  }

  const reads = tasks.filter((task) =>
    hasModule(task, 'shell') || hasModule(task, 'command')
  )
  const agaveRead = reads.find((task) =>
    commandOf(task).includes(
      'agave-validator -l /mnt/ledger contact-info --output json',
    )
  )
  const frankendancerRead = reads.find((task) =>
    commandOf(task).includes(
      'fdctl get-identity --config /home/solv/firedancer-config.toml',
    )
  )
  assert(agaveRead && frankendancerRead, `${path}: both reads are required`)
  assertEquals(reads.length, 2)
  assertEquals(familyOf(gateOf(agaveRead)), 'agave')
  assertEquals(familyOf(gateOf(frankendancerRead)), 'frankendancer')
  for (const read of reads) {
    assertEquals(read.failed_when, false, `${read.name}: failed_when`)
    assertEquals(read.changed_when, false, `${read.name}: changed_when`)
  }

  const reports = tasks.filter((task) => hasModule(task, 'debug'))
  assertEquals(reports.length, 1)
  const message = String((moduleArgs(reports[0], 'debug') as Entry).msg)
  assertEquals(
    message,
    'SLV_RUNNING_IDENTITY {{ inventory_hostname }} {{ running_identity }}',
  )
  const reportVars = reports[0].vars as Entry
  assert(
    String(reportVars.running_identity).includes("or 'unknown'"),
    `${path}: the report must fall back to unknown`,
  )
  assert(tasks.indexOf(reports[0]) === tasks.length - 1, `${path}: last task`)
})

const resolveTag = (template: string, configured: string): string => {
  const rendered = template
    .replace(
      /\{\{\s*'([^']*)' if '([^']*)' in allnodes_jito_version_configured else '([^']*)'\s*\}\}/g,
      (_match, whenTrue, needle, whenFalse) =>
        configured.includes(needle) ? whenTrue : whenFalse,
    )
    .replace(/\{\{\s*allnodes_jito_version_configured\s*\}\}/g, configured)
  assert(!rendered.includes('{{'), `unsupported template: ${template}`)
  return rendered
}

Deno.test('behavior 7: the allnodes tag keeps an upstream suffix and adds -allnodes otherwise', () => {
  const build = tasksOf(readPlaybook('ansible/cmn/build_allnodes_jito.yml')[0])
  const buildTag = build
    .map((task) => moduleArgs(task, 'set_fact') as Entry | undefined)
    .map((facts) => facts?.allnodes_jito_version_resolved)
    .find((value) => value !== undefined)
  const installPlay = readPlaybook(
    'ansible/mainnet-validator/install_allnodes_jito.yml',
  ).find((play) => play.import_playbook === undefined)
  assert(installPlay, 'the install play is not in install_allnodes_jito.yml')
  const installVars = installPlay.vars as Entry
  const installTag = installVars.allnodes_jito_version
  for (
    const [source, template] of [['build', buildTag], ['install', installTag]]
  ) {
    assert(typeof template === 'string', `${source}: tag template not found`)
    assertEquals(resolveTag(template, '4.3.0-allnodes.1'), 'v4.3.0-allnodes.1')
    assertEquals(resolveTag(template, '4.2.2'), 'v4.2.2-allnodes')
  }
})

Deno.test('behavior 8: patch_sha256 clones a fixed commit and never overwrites an earlier backup', () => {
  const patchPlay = readPlaybook('ansible/cmn/patch_sha256.yml').find((play) =>
    play.name === 'Patch Solana Validator with optimized SHA256 (no restart)'
  )
  assert(patchPlay, 'the patch play is not in patch_sha256.yml')
  const tasks = tasksOf(patchPlay)
  const clone = tasks.find((task) =>
    hasModule(task, 'git') &&
    String((moduleArgs(task, 'git') as Entry).repo).includes(
      'kagren/solana-sha256-hasher-optimized',
    )
  )
  assert(clone, 'hasher clone not found')
  assertEquals(
    (moduleArgs(clone, 'git') as Entry).version,
    '7cf3153b860751d8c8ba3c65128880ea4b62aba6',
  )

  const backupIndex = tasks.findIndex((task) =>
    hasModule(task, 'copy') &&
    String((moduleArgs(task, 'copy') as Entry).dest).endsWith('.orig')
  )
  assert(backupIndex >= 0, 'backup task not found')
  const backup = tasks[backupIndex]
  const args = moduleArgs(backup, 'copy') as Entry
  assertEquals(args.dest, '{{ deploy_binary_path }}.{{ solana_version }}.orig')
  assertEquals(args.src, '{{ deploy_binary_path }}')
  assert([true, 'yes'].includes(args.remote_src as boolean | string))
  assert([false, 'no'].includes(args.force as boolean | string))
  assert(
    ![true, 'yes'].includes(backup.ignore_errors as boolean | string),
    'a failed backup must stop the patch',
  )
  const deployIndex = tasks.findIndex((task) =>
    hasModule(task, 'copy') &&
    String((moduleArgs(task, 'copy') as Entry).src).includes(
      'patched_binary_path',
    )
  )
  assert(deployIndex > backupIndex, 'deploy must come after the backup')
})

const geyserRpcTypes = "rpc_type in ['Geyser gRPC', 'Index RPC + gRPC']"

// Replaces {{ name }} with the value in vars, as far as the playbooks here nest them.
const expandVars = (value: unknown, vars: Record<string, unknown>): string => {
  let expanded = String(value)
  for (let round = 0; round < 4; round++) {
    expanded = expanded.replace(
      /\{\{\s*(\w+)\s*\}\}/g,
      (match, name) => name in vars ? String(vars[name]) : match,
    )
  }
  return expanded
}

Deno.test('behavior 9: update_startup_config writes geyser.json for the plugin library installed on the host, keeps the old file, and reads port_rpc from host vars', () => {
  const path = 'ansible/mainnet-rpc/update_startup_config.yml'
  assert(
    !readText(path).includes('mainnet_rpcs.port_rpc'),
    `${path}: inventory port_rpc`,
  )
  const play = readPlaybook(path)[0]
  const vars = (play.vars ?? {}) as Record<string, string>
  const tasks = tasksOf(play)
  const named = (name: string): Entry => {
    const task = tasks.find((entry) => entry.name === name)
    assert(task, `${path}: task "${name}" not found`)
    return task
  }

  // the two libraries are the ones the build playbooks make and the configs load
  // (the play follows the import of the richat check)
  const richatBuild = readPlaybook(
    'ansible/mainnet-rpc/geyser_richat_build.yml',
  ).find((entry) => entry.import_playbook === undefined)
  assert(richatBuild, 'geyser_richat_build.yml has a play')
  const richatVars = richatBuild.vars as Record<string, string>
  assertEquals(
    expandVars(vars.richat_lib_path, vars),
    expandVars(richatVars.richat_symlink_path, richatVars),
  )
  assertEquals(vars.richat_config_template, richatVars.richat_config_template)
  assert(
    readText('jinja/mainnet-rpc/geyser-richat.json.j2').includes(
      `"libpath": "${vars.richat_lib_path}"`,
    ),
  )
  const yellowstoneBuild =
    readPlaybook('ansible/mainnet-rpc/geyser_build.yml')[0]
  const yellowstoneVars = yellowstoneBuild.vars as Record<string, string>
  assertEquals(
    vars.geyser_config_template,
    yellowstoneVars.geyser_config_template,
  )
  assertEquals(vars.geyser_config_path, yellowstoneVars.geyser_config_path)
  const builtLibrary = expandVars(
    yellowstoneVars.geyser_lib_path,
    yellowstoneVars,
  )
  const libraryDefault = (text: string) =>
    /geyser_lib_path \| default\('([^']+)'\)/.exec(text)?.[1]
  assertEquals(libraryDefault(vars.yellowstone_lib_path), builtLibrary)
  assertEquals(
    libraryDefault(readText('jinja/mainnet-rpc/geyser.json.j2')),
    builtLibrary,
  )

  // both libraries are looked for, links followed, whenever geyser.json is in play
  for (
    const [name, variable, register] of [
      [
        'Look for the Richat geyser plugin library',
        'richat_lib_path',
        'richat_lib',
      ],
      [
        'Look for the Yellowstone geyser plugin library',
        'yellowstone_lib_path',
        'yellowstone_lib',
      ],
    ]
  ) {
    const look = named(name)
    const args = moduleArgs(look, 'stat') as Entry
    assertEquals(args.path, `{{ ${variable} }}`)
    assertEquals(args.follow, true)
    assertEquals(look.register, register)
    assertEquals(conditionsOf(look), [geyserRpcTypes])
  }

  // one answer for each of the four states, in a fact that is not named like the
  // inventory variable (geyser_plugin) with which init.yml chooses the plugin
  const decide = named('Decide which geyser plugin this host runs')
  assertEquals(conditionsOf(decide), [geyserRpcTypes])
  assertEquals(
    Object.keys(moduleArgs(decide, 'set_fact') as Entry),
    ['geyser_plugin_installed'],
  )
  for (const task of tasks) {
    assert(
      !/\bgeyser_plugin\b/.test(conditionsOf(task).join(' ')),
      `${path}: "${task.name}" reads the inventory variable geyser_plugin`,
    )
  }
  const expression = /^\{\{\s*([\s\S]+?)\s*\}\}$/.exec(
    String((moduleArgs(decide, 'set_fact') as Entry).geyser_plugin_installed),
  )
  assert(expression, `${path}: geyser_plugin_installed is not an expression`)
  const chain = expression[1].split(/\s+else\s+/)
  const pluginFor = (richat: boolean, yellowstone: boolean): string => {
    const facts: Record<string, boolean> = {
      'richat_lib.stat.exists': richat,
      'yellowstone_lib.stat.exists': yellowstone,
    }
    for (const link of chain) {
      const [value, condition] = link.split(/\s+if\s+/)
      const holds = condition === undefined || condition.replaceAll(/[()]/g, '')
        .split(/\s+and\s+/).every((term) => {
          assert(term in facts, `${path}: unknown term ${term}`)
          return facts[term]
        })
      if (holds) return value.replaceAll("'", '')
    }
    throw new Error(`${path}: geyser_plugin_installed has no final answer`)
  }
  assertEquals(pluginFor(true, false), 'richat')
  assertEquals(pluginFor(false, true), 'yellowstone')
  assertEquals(pluginFor(false, false), 'none')
  assertEquals(pluginFor(true, true), 'both')

  // neither library: stop and name the playbooks that make one, Yellowstone's
  // first; both: stop
  const none = named('Stop when neither geyser plugin library is installed')
  assertEquals(conditionsOf(none), [
    geyserRpcTypes,
    "geyser_plugin_installed == 'none'",
  ])
  const noneMessage = String((moduleArgs(none, 'fail') as Entry).msg)
  for (
    const playbook of [
      'geyser_build.yml',
      'geyser_richat_build.yml',
      'install_richat.yml',
    ]
  ) {
    assert(
      noneMessage.includes(playbook),
      `${path}: message misses ${playbook}`,
    )
  }
  const both = named('Stop when both geyser plugin libraries are installed')
  assertEquals(conditionsOf(both), [
    geyserRpcTypes,
    "geyser_plugin_installed == 'both'",
  ])
  assert(String((moduleArgs(both, 'fail') as Entry).msg).includes('Remove'))

  // each library gets its own config, the old geyser.json is kept, and the host's
  // settings feed the Yellowstone template as before (no extra vars)
  for (
    const [name, template, plugin] of [
      [
        'Copy the geyser.json configuration file for Richat',
        'richat_config_template',
        'richat',
      ],
      [
        'Copy the geyser.json configuration file for Yellowstone',
        'geyser_config_template',
        'yellowstone',
      ],
    ]
  ) {
    const task = named(name)
    const args = moduleArgs(task, 'template') as Entry
    assertEquals(args.src, `{{ ${template} }}`)
    assertEquals(args.dest, '{{ geyser_config_path }}')
    assertEquals(args.backup, true, `${name}: keep the previous geyser.json`)
    assertEquals(conditionsOf(task), [
      geyserRpcTypes,
      `geyser_plugin_installed == '${plugin}'`,
    ])
    assertEquals(task.vars, undefined)
  }
  assertEquals(
    expandVars('{{ richat_config_template }}', vars),
    '~/.slv/mainnet-rpc/geyser-richat.json.j2',
  )
  assertEquals(vars.geyser_config_template, '~/.slv/mainnet-rpc/geyser.json.j2')
  assertEquals(vars.geyser_config_path, '/home/solv/geyser.json')

  // nothing is written before both stops have had their say
  const firstWrite = firstIndex(
    tasks,
    (task) =>
      hasModule(task, 'template') || hasModule(task, 'copy') ||
      hasModule(task, 'file'),
  )
  for (const stop of [none, both]) {
    assert(tasks.indexOf(decide) < tasks.indexOf(stop), `${path}: decide first`)
    assert(tasks.indexOf(stop) < firstWrite, `${path}: stop before any write`)
  }

  const startScript = tasks.find((task) =>
    hasModule(task, 'template') &&
    String((moduleArgs(task, 'template') as Entry).dest).endsWith(
      'start-validator.sh',
    )
  )
  assert(startScript, `${path}: start-validator.sh task not found`)
  assertEquals(
    (startScript.vars as Entry).port_rpc,
    '{{ hostvars[inventory_hostname].port_rpc }}',
  )
})

const playbookPlays = (path: string): { path: string; play: Entry }[] =>
  readPlaybook(path).flatMap((entry) => {
    if (entry.import_playbook === undefined) return [{ path, play: entry }]
    const imported = new URL(
      String(entry.import_playbook),
      new URL(path, templateRoot),
    )
    return playbookPlays(imported.href.slice(templateRoot.href.length))
  })

Deno.test('addendum 9: nodowntime_migrate stops the whole run when any host fails, in every play it runs', () => {
  for (const network of validatorNetworks) {
    const plays = playbookPlays(`ansible/${network}/nodowntime_migrate.yml`)
    assertEquals(
      plays.map(({ path }) => path.split('/').pop()),
      [
        'nodowntime_migrate.yml',
        'switch_off_identity.yml',
        'switch_off_firedancer_identity.yml',
        'switch_on_identity.yml',
        'switch_on_firedancer_identity.yml',
      ],
    )
    for (const { path, play } of plays) {
      assertEquals(
        play.any_errors_fatal,
        true,
        `${path}: play "${play.name}" needs any_errors_fatal`,
      )
    }
  }
})

Deno.test('addendum 10: the testnet validator wipes and both validator restarters keep tower and vote history', async () => {
  const testnet = 'ansible/testnet-validator'
  const { tasks: rmLedger } = assertRefusesBeforeWipe(
    `${testnet}/rm_ledger.yml`,
  )
  assertEquals(
    rmLedger,
    tasksOf(readPlaybook('ansible/cmn/rm_ledger.yml')[0]),
    'testnet-validator/rm_ledger.yml must refuse like cmn/rm_ledger.yml',
  )

  for (
    const file of [
      'rm_ledger.yml',
      'restart_agave_with_rm_ledger.yml',
      'restart_firedancer_with_rm_ledger.yml',
    ]
  ) {
    const path = `${testnet}/${file}`
    // the first play that has tasks: the restart playbooks start with the import of the identity check
    const tasks = tasksOf(
      readPlaybook(path).find((entry) => entry.tasks !== undefined) as Entry,
    )
    const wipes = tasks.filter((task) =>
      /find \/mnt\/ledger\//.test(commandOf(task))
    )
    assertEquals(wipes.length, 1, `${path}: one ledger wipe`)
    assertEquals(
      await survivorsAfterFind(findArgumentsOf(commandOf(wipes[0]))),
      keptFiles,
      `${path}: wipe must keep the consensus files`,
    )
    if (file !== 'rm_ledger.yml') {
      const stop = firstIndex(
        tasks,
        (task) =>
          hasModule(task, 'systemd') &&
          (moduleArgs(task, 'systemd') as Entry).state === 'stopped',
      )
      assert(
        stop >= 0 && stop < tasks.indexOf(wipes[0]),
        `${path}: the service is stopped before the wipe`,
      )
    }
  }

  for (const network of validatorNetworks) {
    const path = `jinja/${network}/restart.sh.j2`
    const script = readText(path)
    const stop = script.indexOf('systemctl stop')
    assert(
      stop >= 0 && stop < script.indexOf('sudo find /mnt/ledger/'),
      `${path}: the service is stopped before the wipe`,
    )
    assertEquals(
      await survivorsAfterFind(findArgumentsOf(script)),
      keptFiles,
      `${path}: wipe must keep the consensus files`,
    )
  }
})

const distRoot = new URL('../../../dist/oss-skills/', import.meta.url)

const startScriptSections: Record<string, string> = {
  'mainnet-validator/start-validator.sh.j2': 'mainnet_validators',
  'testnet-validator/start-validator.sh.j2': 'testnet_validators',
  'testnet-validator/start-validator-agave.sh.j2': 'testnet_validators',
  'testnet-validator/start-validator-jito.sh.j2': 'testnet_validators',
  'mainnet-rpc/start-validator.sh.j2': 'mainnet_rpcs',
  'testnet-rpc/start-validator.sh.j2': 'testnet_rpcs',
  'devnet-rpc/start-validator.sh.j2': 'devnet_rpcs',
}

// The playbooks that print the host's `name` var next to its address.
const displayNameFiles = [
  'ansible/cmn/start_solv.yml',
  'ansible/cmn/stop_solv.yml',
  'ansible/cmn/stop_firedancer.yml',
  'ansible/cmn/start_firedancer.yml',
  'ansible/mainnet-validator/start_solv.yml',
  'ansible/mainnet-validator/stop_solv.yml',
  'ansible/mainnet-validator/stop_firedancer.yml',
  'ansible/testnet-validator/stop_solv.yml',
  'ansible/testnet-validator/stop_firedancer.yml',
  'ansible/testnet-validator/start_solv.yml',
  'ansible/testnet-validator/restart_solv.yml',
  'ansible/mainnet-rpc/stop_solv.yml',
  'ansible/mainnet-rpc/stop_firedancer.yml',
]

const isStartScriptTemplate = (task: Entry): boolean =>
  hasModule(task, 'template') &&
  /\/start-validator[^/'"]*\.sh\.j2(?:$|['"])/.test(
    String((moduleArgs(task, 'template') as Entry).src),
  )

const startScriptPlays = (): { path: string; play: Entry }[] =>
  [
    'mainnet-validator',
    'testnet-validator',
    'mainnet-rpc',
    'testnet-rpc',
    'devnet-rpc',
  ].flatMap((network) =>
    [...Deno.readDirSync(new URL(`ansible/${network}/`, templateRoot))]
      .filter((entry) => entry.isFile && entry.name.endsWith('.yml'))
      .sort((a, b) => a.name.localeCompare(b.name))
      .flatMap((entry) => {
        const path = `ansible/${network}/${entry.name}`
        return readPlaybook(path)
          .filter((play) => tasksOf(play).some(isStartScriptTemplate))
          .map((play) => ({ path, play }))
      })
  )

const changedTemplates = [
  ...validatorNetworks.flatMap((network) =>
    [
      'set_unstaked_key',
      'set_identity_key',
      'restart_node',
      'stop_node',
      'start_node',
      'nodowntime_migrate',
      'switch_off_identity',
      'switch_off_firedancer_identity',
      'switch_on_identity',
      'switch_on_firedancer_identity',
    ].map((file) => `ansible/${network}/${file}.yml`)
  ),
  'ansible/mainnet-validator/install_allnodes_jito.yml',
  'ansible/cmn/tasks/alpenglow_state.yml',
  'ansible/cmn/tasks/vote_history_take.yml',
  'ansible/cmn/tasks/vote_history_confirm.yml',
  'ansible/cmn/tasks/vote_history_last_vote.yml',
  'ansible/cmn/tasks/vote_history_dead_primary.yml',
  ...[
    'rm_ledger',
    'restart_agave_with_rm_ledger',
    'restart_firedancer_with_rm_ledger',
    'change_identity_and_restart',
  ].map((file) => `ansible/testnet-validator/${file}.yml`),
  ...[
    'rm_ledger',
    'build_allnodes_jito',
    'patch_sha256',
    'read_running_identity',
  ]
    .map((file) => `ansible/cmn/${file}.yml`),
  'ansible/mainnet-rpc/update_startup_config.yml',
  'jinja/cmn/restart.sh.j2',
  'jinja/mainnet-validator/restart.sh.j2',
  'jinja/testnet-validator/restart.sh.j2',
  'ansible/mainnet-validator/create-start-validator-sh.yml',
  'ansible/mainnet-validator/update_startup_config.yml',
  'ansible/testnet-validator/create-start-validator-sh-agave.yml',
  'ansible/testnet-validator/create-start-validator-sh-jito.yml',
  'ansible/testnet-validator/deploy-start-validator-sh.yml',
  'ansible/testnet-validator/update_startup_config.yml',
  'ansible/mainnet-rpc/create-start-validator-sh.yml',
  'ansible/testnet-rpc/create-start-validator-sh.yml',
  'ansible/testnet-rpc/update_startup_config.yml',
  'ansible/devnet-rpc/create-start-validator-sh.yml',
  'ansible/devnet-rpc/update_startup_config.yml',
  ...Object.keys(startScriptSections).map((script) => `jinja/${script}`),
  ...displayNameFiles,
]

// Dist copies of the files above that were byte-identical to their template
// source at 08acbaf3, each with the sha256 the file had then.
const refreshedCopies: Record<string, string> = {
  'slv-grpc-geyser/ansible/mainnet-rpc/update_startup_config.yml':
    '9ba7e0f3de29e2527cd26270579878169f3dfb84774cbfeb1b3d974e7c662394',
  'slv-grpc-geyser/jinja/cmn/restart.sh.j2':
    '8ad49c4d53885f01d374bd25d7fe7dde6caad116068474125988923be70e949e',
  'slv-rpc/ansible/mainnet-rpc/update_startup_config.yml':
    '9ba7e0f3de29e2527cd26270579878169f3dfb84774cbfeb1b3d974e7c662394',
  'slv-rpc/jinja/cmn/restart.sh.j2':
    '8ad49c4d53885f01d374bd25d7fe7dde6caad116068474125988923be70e949e',
  'slv-validator/ansible/mainnet-validator/set_identity_key.yml':
    'a987a1d58db2220d844a1334174328764d526f701843ada1d6341d0323d1894b',
  'slv-validator/ansible/mainnet-validator/set_unstaked_key.yml':
    '2fad6e9da6b1e7ce6609e2299d2375afadfe4a7b807cdaf9b05d80db965817bc',
  'slv-validator/ansible/mainnet-validator/switch_off_firedancer_identity.yml':
    '010a8aba6b6b0d8af8fdc65e178bd98a8d866311800b3cfb55417631b53cfa80',
  'slv-validator/ansible/mainnet-validator/switch_off_identity.yml':
    '9e80cec2e1030746eb8801372bee962def6c151d2fcf4f2ee73664c86936d059',
  'slv-validator/ansible/mainnet-validator/switch_on_firedancer_identity.yml':
    '5b96d89e758e835b426db527a5c46e3b06362aaa81e4b8ec40d50a10bbe82485',
  'slv-validator/ansible/mainnet-validator/switch_on_identity.yml':
    'b03c4462e22a619e8a09d1bcd2395adbf6244693ba852f734a7e47fb4f167dc2',
  'slv-validator/ansible/testnet-validator/change_identity_and_restart.yml':
    '283c705c78eeb02ea77e6f0fe990e87a402040cb9349c63446de3e3b5ac2b56d',
  'slv-validator/ansible/testnet-validator/restart_agave_with_rm_ledger.yml':
    '22af42a193ef431ef62b23c8baea5acfe888650cede30ed58b10716f1e8fd7b5',
  'slv-validator/ansible/testnet-validator/restart_firedancer_with_rm_ledger.yml':
    'cf54b4dd4a92d701bd439d51a747b5c270d38462fca48e880d2e3edbd6cb418f',
  'slv-validator/ansible/testnet-validator/rm_ledger.yml':
    '8a6487ab23e5a999a13f5f25da4165a30887591082507d6a69f80b3f887fc546',
  'slv-validator/ansible/testnet-validator/switch_off_firedancer_identity.yml':
    '010a8aba6b6b0d8af8fdc65e178bd98a8d866311800b3cfb55417631b53cfa80',
  'slv-validator/ansible/testnet-validator/switch_off_identity.yml':
    '9e80cec2e1030746eb8801372bee962def6c151d2fcf4f2ee73664c86936d059',
  'slv-validator/ansible/testnet-validator/switch_on_firedancer_identity.yml':
    '6bcb5ba6206ec80523752934471778bd47885c924e35271b2dff30f99c762fdb',
  'slv-validator/ansible/testnet-validator/switch_on_identity.yml':
    '4038e69e31b03ef12c25d70cb343f1f2a5e41ae6fa8416c456e2fc2d709ed903',
  'slv-validator/jinja/cmn/restart.sh.j2':
    '8ad49c4d53885f01d374bd25d7fe7dde6caad116068474125988923be70e949e',
  'slv-validator/jinja/mainnet-validator/restart.sh.j2':
    'f87713f2d7df1d2ea77ef619187425fcb964e48483ec5ccca1444c7cf1498107',
  'slv-validator/jinja/testnet-validator/restart.sh.j2':
    '4a61cb1bc63fc2f4f2b4216f08f5c3919cc6fe497732ed8ffce60d02529442fc',
  'slv-grpc-geyser/ansible/mainnet-rpc/create-start-validator-sh.yml':
    '9b7f5a52bdaa1424e4101be280152a7851a62f9ec8a9239ea57e762cc755a3bb',
  'slv-rpc/ansible/devnet-rpc/create-start-validator-sh.yml':
    'cdb798c016d65d8aaf4e8340e0f2a0c1c4ac2bcbe3f295f982bc8451c081297f',
  'slv-rpc/ansible/mainnet-rpc/create-start-validator-sh.yml':
    '9b7f5a52bdaa1424e4101be280152a7851a62f9ec8a9239ea57e762cc755a3bb',
  'slv-rpc/ansible/testnet-rpc/create-start-validator-sh.yml':
    '09e25cc6391b1d8fc8336f3abc90d257fca00005495f09156ba629cc42db0670',
  'slv-validator/ansible/mainnet-validator/create-start-validator-sh.yml':
    'fce1b6b56f7d0faaad8381241e2ee5e2c105774779a1e94836d40dbf2b06dafc',
  'slv-validator/ansible/testnet-validator/create-start-validator-sh-agave.yml':
    '75a4a85bf51d862fbb336f101121b65f041b57c2b894af984c46d8ebec8487f4',
  'slv-validator/ansible/testnet-validator/create-start-validator-sh-jito.yml':
    'bf3b364867b55398b9892eba693e1854f8d6c14eca2406001a5afeb3573736cf',
  'slv-validator/ansible/testnet-validator/deploy-start-validator-sh.yml':
    'ec1c3d403cfca24faddc561211d4762d77a192d17e5808b5282c8910ee957f41',
  'slv-validator/ansible/testnet-validator/update_startup_config.yml':
    '5d7397c114c2ef5c0ad8ba6b7901302f179e1b988373d97683ed3bfcea03c7cd',
  'slv-grpc-geyser/ansible/cmn/start_firedancer.yml':
    'f100643e444af6552c2e604cb0a3205e1a5a114ba0b2fc05da7a1538ac49c3ff',
  'slv-grpc-geyser/ansible/cmn/start_solv.yml':
    '70246dfaa267428f8e38bf78f0acab7a7129a2b3daff3c5ea717d5231d468a89',
  'slv-grpc-geyser/ansible/cmn/stop_firedancer.yml':
    'bffef1b22debd56c0a1d18be6b6390c2e52653020980037c2b5d140d34c397ba',
  'slv-grpc-geyser/ansible/cmn/stop_solv.yml':
    '6104ea77795787bda419280a6279d139a8a4c2957171c0e7a6ef7393437815cf',
  'slv-grpc-geyser/ansible/mainnet-rpc/stop_firedancer.yml':
    'bffef1b22debd56c0a1d18be6b6390c2e52653020980037c2b5d140d34c397ba',
  'slv-grpc-geyser/ansible/mainnet-rpc/stop_solv.yml':
    '6104ea77795787bda419280a6279d139a8a4c2957171c0e7a6ef7393437815cf',
  'slv-rpc/ansible/cmn/start_firedancer.yml':
    'f100643e444af6552c2e604cb0a3205e1a5a114ba0b2fc05da7a1538ac49c3ff',
  'slv-rpc/ansible/cmn/start_solv.yml':
    '70246dfaa267428f8e38bf78f0acab7a7129a2b3daff3c5ea717d5231d468a89',
  'slv-rpc/ansible/cmn/stop_firedancer.yml':
    'bffef1b22debd56c0a1d18be6b6390c2e52653020980037c2b5d140d34c397ba',
  'slv-rpc/ansible/cmn/stop_solv.yml':
    '6104ea77795787bda419280a6279d139a8a4c2957171c0e7a6ef7393437815cf',
  'slv-rpc/ansible/mainnet-rpc/stop_firedancer.yml':
    'bffef1b22debd56c0a1d18be6b6390c2e52653020980037c2b5d140d34c397ba',
  'slv-rpc/ansible/mainnet-rpc/stop_solv.yml':
    '6104ea77795787bda419280a6279d139a8a4c2957171c0e7a6ef7393437815cf',
  'slv-validator/ansible/mainnet-validator/start_solv.yml':
    '70246dfaa267428f8e38bf78f0acab7a7129a2b3daff3c5ea717d5231d468a89',
  'slv-validator/ansible/mainnet-validator/stop_firedancer.yml':
    'accb34601532398b009094e7084c82fab39c66836b58d6ac5d7d6e103d060367',
  'slv-validator/ansible/mainnet-validator/stop_solv.yml':
    '6104ea77795787bda419280a6279d139a8a4c2957171c0e7a6ef7393437815cf',
  'slv-validator/ansible/testnet-validator/restart_solv.yml':
    '07690e0edd03ed2a56dd901ab45e8d836c61d84d4c58cde6715a0b597b718091',
  'slv-validator/ansible/testnet-validator/start_solv.yml':
    '70246dfaa267428f8e38bf78f0acab7a7129a2b3daff3c5ea717d5231d468a89',
  'slv-validator/ansible/testnet-validator/stop_firedancer.yml':
    '9d0a8f40fb6da0c082d2e35e01f1e202964c5f5dbf75bd7bb4cccaf94ff0c56a',
  'slv-validator/ansible/testnet-validator/stop_solv.yml':
    '6104ea77795787bda419280a6279d139a8a4c2957171c0e7a6ef7393437815cf',
}

// Dist copies of those files that already differed from their template source
// at 08acbaf3.
const differedAtBase = new Set([
  'slv-validator/ansible/mainnet-validator/restart_node.yml',
  'slv-validator/ansible/mainnet-validator/start_node.yml',
  'slv-validator/ansible/mainnet-validator/stop_node.yml',
  'slv-validator/ansible/testnet-validator/nodowntime_migrate.yml',
  'slv-validator/ansible/testnet-validator/restart_node.yml',
  'slv-validator/ansible/testnet-validator/set_identity_key.yml',
  'slv-validator/ansible/testnet-validator/set_unstaked_key.yml',
  'slv-validator/ansible/testnet-validator/start_node.yml',
  'slv-validator/ansible/testnet-validator/stop_node.yml',
  'slv-grpc-geyser/jinja/mainnet-rpc/start-validator.sh.j2',
  'slv-rpc/ansible/devnet-rpc/update_startup_config.yml',
  'slv-rpc/ansible/testnet-rpc/update_startup_config.yml',
  'slv-rpc/jinja/devnet-rpc/start-validator.sh.j2',
  'slv-rpc/jinja/mainnet-rpc/start-validator.sh.j2',
  'slv-rpc/jinja/testnet-rpc/start-validator.sh.j2',
  'slv-validator/ansible/mainnet-validator/update_startup_config.yml',
  'slv-validator/jinja/mainnet-validator/start-validator.sh.j2',
  'slv-validator/jinja/testnet-validator/start-validator-agave.sh.j2',
  'slv-validator/jinja/testnet-validator/start-validator-jito.sh.j2',
  'slv-validator/jinja/testnet-validator/start-validator.sh.j2',
])

const readBytes = (url: URL): Uint8Array<ArrayBuffer> | undefined => {
  try {
    return Deno.readFileSync(url)
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return undefined
    throw error
  }
}

const sha256Hex = async (bytes: Uint8Array<ArrayBuffer>): Promise<string> =>
  [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')

Deno.test('addendum 11: dist/oss-skills copies that matched their template source at 08acbaf3 match it again', async () => {
  const skills = [...Deno.readDirSync(distRoot)]
    .filter((entry) => entry.isDirectory)
    .map((entry) => entry.name)
  for (const skill of skills) {
    for (const template of changedTemplates) {
      const key = `${skill}/${template}`
      const copy = readBytes(new URL(key, distRoot))
      if (copy === undefined || differedAtBase.has(key)) continue
      assertEquals(
        copy,
        Deno.readFileSync(new URL(template, templateRoot)),
        `${key} must be byte-identical to its template source`,
      )
    }
  }
  for (const [key, baseSha256] of Object.entries(refreshedCopies)) {
    const template = key.slice(key.indexOf('/') + 1)
    const source = Deno.readFileSync(new URL(template, templateRoot))
    assertEquals(
      readBytes(new URL(key, distRoot)),
      source,
      `${key} must exist and be byte-identical to its template source`,
    )
    assert(
      await sha256Hex(source) !== baseSha256,
      `${template} still has its 08acbaf3 content`,
    )
  }
})

Deno.test('xdp flags: the playbooks that render an agave start script read versions.yml when it exists, and each script reads its own section', () => {
  for (const [script, section] of Object.entries(startScriptSections)) {
    const text = readText(`jinja/${script}`)
    assert(
      text.includes(`${section} | default({})`),
      `${script}: must read the ${section} section of versions.yml`,
    )
    assert(
      text.includes("mandatory('Cannot tell which agave version"),
      `${script}: must refuse when the agave version cannot be found`,
    )
  }
  const plays = startScriptPlays()
  for (const { path, play } of plays) {
    assert(
      [(play.vars_files ?? []) as unknown[]].flat(2).includes(
        '~/.slv/versions.yml',
      ),
      `${path}: the play that renders a start script must load versions.yml`,
    )
  }
  assertEquals(plays.length, 12, 'playbooks that render an agave start script')
})

const probeName =
  'Read the version of the agave-validator installed on this host'
const probeStopName =
  'Stop when the installed agave-validator does not report its version'
const activeReleaseBin =
  '/home/solv/.local/share/solana/install/active_release/bin'

const probesOf = (): {
  path: string
  probe: Entry
  stop: Entry
  play: Entry
}[] =>
  startScriptPlays().map(({ path, play }) => {
    const tasks = tasksOf(play)
    const probe = tasks.find((task) => task.name === probeName)
    const stop = tasks.find((task) => task.name === probeStopName)
    assert(probe && stop, `${path}: needs the probe and its stop task`)
    return { path, probe, stop, play }
  })

const assertInitPlaybooksInstallBeforeTheyRender = (): void => {
  const installers = new Set([
    'build_solana.yml',
    'install_solana.yml',
    'install_agave.yml',
    'install_jito.yml',
    'install_allnodes_jito.yml',
  ])
  const renderers = new Set(
    startScriptPlays().map(({ path }) => path.split('/').pop()),
  )
  let checked = 0
  for (
    const network of [
      'mainnet-validator',
      'testnet-validator',
      'mainnet-rpc',
      'testnet-rpc',
      'devnet-rpc',
    ]
  ) {
    for (
      const entry of Deno.readDirSync(
        new URL(`ansible/${network}/`, templateRoot),
      )
    ) {
      if (!/^init.*\.yml$/.test(entry.name)) continue
      const path = `ansible/${network}/${entry.name}`
      const imports = readPlaybook(path)
        .filter((play) => play.import_playbook !== undefined)
        .map((play) => String(play.import_playbook).split('/').pop() as string)
      for (const [position, name] of imports.entries()) {
        if (!renderers.has(name)) continue
        checked++
        assert(
          imports.slice(0, position).some((earlier) => installers.has(earlier)),
          `${path}: ${name} renders the start script before any install or build`,
        )
      }
    }
  }
  assert(checked >= 8, `only ${checked} renders in init playbooks were checked`)
}

Deno.test('installed agave: every play that renders a start script reads the installed agave-validator before it writes anything, and every init playbook installs before it renders', () => {
  const quoted = (conditions: string[]) =>
    new Set(conditions.join(' ').match(/'[^']+'/g) ?? [])
  const scripts = new Set<string>()
  for (const { path, probe, stop, play } of probesOf()) {
    const tasks = tasksOf(play)
    assert(hasModule(probe, 'shell'), `${path}: the probe runs a command`)
    assertEquals(probe.register, 'agave_installed')
    assertEquals(
      probe.check_mode,
      false,
      `${path}: read-only, so check mode runs it`,
    )
    assertEquals(probe.changed_when, false)
    assertEquals(probe.failed_when, false, `${path}: the stop task reports it`)
    scripts.add(commandOf(probe))

    assert(hasModule(stop, 'fail'), `${path}: the stop task fails`)
    assertEquals(conditionsOf(stop), [
      ...conditionsOf(probe),
      'agave_installed.rc != 0',
    ])
    assert(
      String((moduleArgs(stop, 'fail') as Entry).msg).includes(
        '{{ agave_installed.stderr | trim }}',
      ),
      `${path}: the stop message carries what the probe said`,
    )

    // the probe runs wherever a script is rendered, and the script gets its answer
    const renders = tasks.filter(isStartScriptTemplate)
    assert(renders.length > 0, `${path}: no start script task`)
    for (const render of renders) {
      assertEquals(
        (render.vars as Entry | undefined)?.installed_agave_version,
        '{{ agave_installed.stdout | trim }}',
        `${path}: "${render.name}" does not pass the installed version`,
      )
      const covered = quoted(conditionsOf(render))
      const probed = quoted(conditionsOf(probe))
      assert(
        [...covered].every((value) => probed.has(value)),
        `${path}: the probe does not cover "${render.name}"`,
      )
      if (conditionsOf(render).length === 0) {
        assertEquals(conditionsOf(probe), [], `${path}: probe guard`)
      }
    }

    // nothing is written, so a stop leaves the host as it was
    const changes = (task: Entry) =>
      task !== probe &&
      ['file', 'template', 'copy', 'shell', 'command'].some((module) =>
        hasModule(task, module)
      )
    const firstChange = firstIndex(tasks, changes)
    assert(
      firstChange > tasks.indexOf(stop),
      `${path}: a task writes before the stop`,
    )
    assert(
      tasks.indexOf(probe) < tasks.indexOf(stop),
      `${path}: probe before stop`,
    )
  }
  assertEquals(scripts.size, 1, 'the probe is the same text in every play')
  assertInitPlaybooksInstallBeforeTheyRender()
})

type ProbeCase = {
  name: string
  // what systemctl says the solv unit sets PATH to; '' means no unit
  unitPath: (root: string) => string
  // fake agave-validator files: path under the root, what it prints, its exit status
  binaries: Record<string, [string, number]>
  dangling?: string
  stdout: string
  exit: number
  stderr?: (root: string) => string[]
}

const detail = 'src:0123abcd; feat:00000001, client:'
const probeCases: ProbeCase[] = [
  {
    name:
      'an older binary than the configured version: its version is the answer',
    unitPath: (root) => `${root}/unit/bin`,
    binaries: {
      'unit/bin': [`agave-validator 3.1.10 (${detail}Agave)`, 0],
    },
    stdout: '3.1.10\n',
    exit: 0,
  },
  {
    name: 'a newer binary',
    unitPath: (root) => `${root}/unit/bin`,
    binaries: {
      'unit/bin': [`agave-validator 4.3.0 (${detail}Agave)`, 0],
    },
    stdout: '4.3.0\n',
    exit: 0,
  },
  {
    name: 'a pre-release prints X.Y.Z of the line it belongs to',
    unitPath: (root) => `${root}/unit/bin`,
    binaries: {
      'unit/bin': [`agave-validator 4.4.0-beta.0 (${detail}Agave)`, 0],
    },
    stdout: '4.4.0\n',
    exit: 0,
  },
  {
    name: 'a version printed with a leading v',
    unitPath: (root) => `${root}/unit/bin`,
    binaries: {
      'unit/bin': [`agave-validator v4.3.0 (${detail}Agave)`, 0],
    },
    stdout: '4.3.0\n',
    exit: 0,
  },
  {
    name: 'a Jito build',
    unitPath: (root) => `${root}/unit/bin`,
    binaries: {
      'unit/bin': [`agave-validator 3.1.10 (${detail}JitoLabs)`, 0],
    },
    stdout: '3.1.10\n',
    exit: 0,
  },
  {
    name: 'a warning line before the version line',
    unitPath: (root) => `${root}/unit/bin`,
    binaries: {
      'unit/bin': [
        `warning: low memlock limit\nagave-validator 3.1.10 (${detail}Agave)`,
        0,
      ],
    },
    stdout: '3.1.10\n',
    exit: 0,
  },
  {
    name: 'the unit lists several directories: the first with a binary wins',
    unitPath: (root) => `${root}/other/bin:${root}/unit/bin`,
    binaries: {
      'unit/bin': [`agave-validator 4.3.0 (${detail}Agave)`, 0],
    },
    stdout: '4.3.0\n',
    exit: 0,
  },
  {
    name: 'no unit yet: the active_release link is used',
    unitPath: () => '',
    binaries: {
      'default/bin': [`agave-validator 4.3.0 (${detail}Agave)`, 0],
    },
    stdout: '4.3.0\n',
    exit: 0,
  },
  {
    name:
      'the unit names a directory without a binary: the link is not consulted',
    unitPath: (root) => `${root}/unit/bin`,
    binaries: {
      'default/bin': [`agave-validator 4.3.0 (${detail}Agave)`, 0],
    },
    stdout: '',
    exit: 0,
  },
  {
    name:
      'no binary installed yet: nothing is said and the configured version applies',
    unitPath: () => '',
    binaries: {},
    stdout: '',
    exit: 0,
  },
  {
    name: 'a binary that cannot run stops the play',
    unitPath: (root) => `${root}/unit/bin`,
    binaries: {
      'unit/bin': [
        'error while loading shared libraries: libudev.so.1: cannot open shared object file',
        127,
      ],
    },
    stdout: '',
    exit: 1,
    stderr: (root) => [
      `${root}/unit/bin/agave-validator`,
      'did not report a version (exit 127)',
      'error while loading shared libraries',
    ],
  },
  {
    name: 'a binary that prints nothing stops the play',
    unitPath: (root) => `${root}/unit/bin`,
    binaries: { 'unit/bin': ['', 0] },
    stdout: '',
    exit: 1,
    stderr: (
      root,
    ) => [
      `${root}/unit/bin/agave-validator`,
      'did not report a version (exit 0)',
    ],
  },
  {
    name: 'a binary that prints text without a version stops the play',
    unitPath: (root) => `${root}/unit/bin`,
    binaries: { 'unit/bin': ['agave-validator (unknown build)', 0] },
    stdout: '',
    exit: 1,
    stderr: () => ['did not report a version (exit 0)', 'unknown build'],
  },
  {
    name: 'a binary that prints a version but fails stops the play',
    unitPath: (root) => `${root}/unit/bin`,
    binaries: { 'unit/bin': [`agave-validator 4.3.0 (${detail}Agave)`, 1] },
    stdout: '',
    exit: 1,
    stderr: () => ['did not report a version (exit 1)'],
  },
  {
    name: 'a link to a binary that is gone stops the play',
    unitPath: (root) => `${root}/unit/bin`,
    binaries: {},
    dangling: 'unit/bin',
    stdout: '',
    exit: 1,
    stderr: (
      root,
    ) => [`${root}/unit/bin/agave-validator`, 'did not report a version'],
  },
]

Deno.test('installed agave: the probe reads X.Y.Z from the binary the solv unit runs, and stops when it cannot', async () => {
  const [{ probe }] = probesOf()
  const script = commandOf(probe)
  assert(
    script.includes(activeReleaseBin),
    'the probe falls back to the active_release link the installers fill',
  )
  const dir = await Deno.makeTempDir({ prefix: 'slv-w0-probe-' })
  try {
    for (const [index, probeCase] of probeCases.entries()) {
      const root = `${dir}/${index}`
      await Deno.mkdir(`${root}/bin`, { recursive: true })
      await Deno.writeTextFile(
        `${root}/bin/systemctl`,
        '#!/bin/sh\nif [ "$1" = show ] && [ "$2" = solv ]; then\n  [ -z "$FAKE_UNIT_ENV" ] || printf \'%s\\n\' "$FAKE_UNIT_ENV"\n  exit 0\nfi\nexit 1\n',
        { mode: 0o755 },
      )
      for (
        const [relative, [output, status]] of Object.entries(probeCase.binaries)
      ) {
        await Deno.mkdir(`${root}/${relative}`, { recursive: true })
        await Deno.writeTextFile(
          `${root}/${relative}/agave-validator`,
          `#!/bin/sh\ncat <<'EOF'\n${output}\nEOF\nexit ${status}\n`,
          { mode: 0o755 },
        )
      }
      if (probeCase.dangling !== undefined) {
        await Deno.mkdir(`${root}/${probeCase.dangling}`, { recursive: true })
        await Deno.symlink(
          `${root}/gone`,
          `${root}/${probeCase.dangling}/agave-validator`,
        )
      }
      const unitPath = probeCase.unitPath(root)
      const { code, stdout, stderr } = await new Deno.Command('/bin/bash', {
        args: [
          '-c',
          script.replaceAll(activeReleaseBin, `${root}/default/bin`),
        ],
        clearEnv: true,
        env: {
          PATH: `${root}/bin:/usr/bin:/bin`,
          FAKE_UNIT_ENV: unitPath === ''
            ? ''
            : `PATH=${unitPath} SOLANA_METRICS_CONFIG=host=https://metrics.solana.com:8086,db=mainnet-beta,u=u,p=p`,
        },
        stdout: 'piped',
        stderr: 'piped',
      }).output()
      const said = new TextDecoder().decode(stderr)
      assertEquals(
        code,
        probeCase.exit,
        `${probeCase.name}: exit status\n${said}`,
      )
      assertEquals(
        new TextDecoder().decode(stdout),
        probeCase.stdout,
        probeCase.name,
      )
      for (const part of probeCase.stderr?.(root) ?? []) {
        assert(
          said.includes(part),
          `${probeCase.name}: stderr lacks "${part}": ${said}`,
        )
      }
    }
  } finally {
    await Deno.remove(dir, { recursive: true })
  }
})

Deno.test('installed agave: the start script templates take the installed version before the configured one', () => {
  for (const script of Object.keys(startScriptSections)) {
    const text = readText(`jinja/${script}`)
    const line =
      "{% set _client_version = installed_agave_version | default('', true) or _client_version %}"
    assertEquals(
      text.split(line).length - 1,
      1,
      `${script}: installed version line`,
    )
    const configured = text.indexOf('{% set _client_version')
    const installed = text.indexOf(line)
    const digits = text.indexOf('{% set _digits')
    assert(
      configured >= 0 && configured < installed && installed < digits,
      `${script}: the installed version has to come after the configured one is set and before it is read`,
    )
  }
})

const playbooksUnder = (directory: URL): URL[] =>
  [...Deno.readDirSync(directory)]
    .sort((a, b) => a.name.localeCompare(b.name))
    .flatMap((entry) =>
      entry.isDirectory
        ? playbooksUnder(new URL(`${entry.name}/`, directory))
        : /\.ya?ml$/.test(entry.name)
        ? [new URL(entry.name, directory)]
        : []
    )

// hostvars[inventory_hostname].name and hostvars[inventory_hostname]['name'],
// with or without a `| default(` right behind them.
const hostNameLookup =
  /hostvars\s*\[\s*inventory_hostname\s*\]\s*(?:\.\s*name\b|\[\s*(['"])name\1\s*\])/g

Deno.test('display names: no template playbook reads the host name var without a default', () => {
  const withoutDefault: string[] = []
  const withDefault = new Map<string, number>()
  const ansibleRoot = new URL('ansible/', templateRoot)
  for (const file of playbooksUnder(ansibleRoot)) {
    const text = Deno.readTextFileSync(file)
    const path = `ansible/${file.href.slice(ansibleRoot.href.length)}`
    for (const match of text.matchAll(hostNameLookup)) {
      const index = match.index ?? 0
      if (/^\s*\|\s*default\(/.test(text.slice(index + match[0].length))) {
        withDefault.set(path, (withDefault.get(path) ?? 0) + 1)
      } else {
        const line = text.slice(0, index).split('\n').length
        withoutDefault.push(`${path}:${line}`)
      }
    }
  }
  assertEquals(
    withoutDefault,
    [],
    'a read of the inventory name var with no default fails when the inventory has none',
  )
  for (const path of displayNameFiles) {
    assertEquals(
      withDefault.get(path),
      1,
      `${path} must print the host name with a default`,
    )
  }
})

// A `vars:` entry of a play, block or task that reads its own name ("x: {{ x | default('a') }}") fails on every run with
// "recursive loop detected in template string", whether or not the inventory sets x: the entry is x, so x reads itself.
// The way to take a value from the caller with a default is an entry of its own name that reads the caller's variable
// (slv_x: "{{ x | default('a') }}"). A set_fact is not a `vars:` entry: it stores the value it reads, and may read its own name.
const jinjaSegments = /\{\{[\s\S]*?\}\}|\{%[\s\S]*?%\}/g
const stringLiterals = /'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"/g
const stringsOf = (value: unknown): string[] =>
  typeof value === 'string'
    ? [value]
    : Array.isArray(value)
    ? value.flatMap(stringsOf)
    : value !== null && typeof value === 'object'
    ? Object.values(value).flatMap(stringsOf)
    : []
const readsItself = (name: string, value: unknown): boolean => {
  // the name as a variable of an expression: not behind a dot (an attribute), not inside a string literal
  const read = new RegExp(
    `(?<![\\w.])${name.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?!\\w)`,
  )
  return stringsOf(value).some((text) =>
    (text.match(jinjaSegments) ?? []).some((segment) =>
      read.test(segment.replaceAll(stringLiterals, "''"))
    )
  )
}
const varsReadingThemselves = (node: unknown): string[] => {
  if (Array.isArray(node)) return node.flatMap(varsReadingThemselves)
  if (node === null || typeof node !== 'object') return []
  const entry = node as Entry
  const own = entry.vars !== null && typeof entry.vars === 'object' &&
      !Array.isArray(entry.vars)
    ? Object.entries(entry.vars as Entry)
      .filter(([name, value]) => readsItself(name, value))
      .map(([name]) => name)
    : []
  return [...own, ...Object.values(entry).flatMap(varsReadingThemselves)]
}

Deno.test('vars: no play, block or task variable of the template reads its own name', () => {
  // what the detector refuses and what it lets through, so that an empty result below means something
  assertEquals(
    varsReadingThemselves(parse(`
- hosts: all
  vars:
    loops: "{{ loops | default('a') }}"
    loops_in_a_list: ["{{ loops_in_a_list }}"]
    loops_in_a_block: "{% if loops_in_a_block %}x{% endif %}"
    fine_other_name: "{{ loops_in_a_block | default('b') }}"
    fine_attribute: "{{ item.fine_attribute }}"
    fine_hostvars: "{{ hostvars[inventory_hostname].fine_hostvars }}"
    fine_text: "fine_text is a name, not an expression"
    fine_literal: "{{ other | default('fine_literal') }}"
    fine_prefix: "{{ fine_prefix_of_another }}"
  tasks:
    - name: a task
      ansible.builtin.set_fact:
        validator_type: "{{ validator_type | default('agave') }}"
      vars:
        task_loops: "{{ task_loops }}"
`)),
    ['loops', 'loops_in_a_list', 'loops_in_a_block', 'task_loops'],
  )
  const found: string[] = []
  for (const file of listAnsibleFiles('')) {
    for (const name of varsReadingThemselves(parse(readText(file)))) {
      found.push(`${file}: ${name}`)
    }
  }
  assertEquals(
    found,
    [],
    'an entry of vars: that reads its own name fails with "recursive loop detected in template string": give it a name of its own that reads the caller variable',
  )
})
