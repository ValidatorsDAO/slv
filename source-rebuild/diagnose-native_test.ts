import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import {
  type ArtifactExpectation,
  classifySidCandidates,
  DIAGNOSTIC_PROTOCOL,
  diagnosticControlSummary,
  parseDiagnosticArgs,
  parseDiagnosticContext,
  parseProcStat,
  runBoundedChild,
  runBoundedObservationUtility,
  runDiagnosticControlPhase,
  runMandatoryControls,
  sameBirth,
  selectDiagnosticTimeout,
  startDiagnosticDeadline,
  validateDiagnosticContext,
  validateStoredArtifact,
  writeDiagnosticSummary,
} from './diagnose-native.ts'

function requireFixture(
  condition: unknown,
  message: string,
): asserts condition {
  if (!condition) throw new Error(message)
}

function digest(value: Uint8Array | string): string {
  return createHash('sha256').update(value).digest('hex')
}

async function fileDigest(path: string): Promise<string> {
  return digest(await Deno.readFile(path))
}

async function writeJson(path: string, value: unknown): Promise<string> {
  await Deno.mkdir(path.slice(0, path.lastIndexOf('/')), { recursive: true })
  await Deno.writeTextFile(path, JSON.stringify(value, null, 2) + '\n')
  return await fileDigest(path)
}

async function writeFile(path: string, value: string): Promise<void> {
  await Deno.mkdir(path.slice(0, path.lastIndexOf('/')), { recursive: true })
  await Deno.writeTextFile(path, value)
}

const transportNames = [
  'baseline-denort',
  'baseline-v8-archive',
  'baseline-ninja',
  'baseline-probe',
  'baseline-derived-relink-Cargo.lock',
  'baseline-slv',
  'baseline-bridge',
  'tls-localhost.crt',
  'tls-localhost.key',
  'tls-root-ca.pem',
  'modified-denort',
  'modified-v8-archive',
  'modified-ninja',
  'modified-probe',
] as const

type Fixture = {
  artifact: string
  build: string
  manifest: string
  denort: string
  probe: string
  expectation: ArtifactExpectation
}

async function artifactFixture(
  root: string,
  mutate?: (
    build: Record<string, unknown>,
    manifest: Record<string, unknown>,
  ) => void,
): Promise<Fixture> {
  const target = 'aarch64-unknown-linux-gnu'
  const artifact = `${root}/artifact`
  const transport = `${artifact}/source-proofs/${target}/transport`
  const entries: Record<
    string,
    { path: string; sha256: string; size: number }
  > = {}
  for (const name of transportNames) {
    const bytes = `${name} fixture payload\n`
    await writeFile(`${transport}/${name}`, bytes)
    entries[name] = { path: name, sha256: digest(bytes), size: bytes.length }
  }
  const artifacts = {
    baseline: {
      denort_sha256: entries['baseline-denort'].sha256,
      v8_archive_sha256: entries['baseline-v8-archive'].sha256,
      ninja_sha256: entries['baseline-ninja'].sha256,
      probe_standalone_sha256: entries['baseline-probe'].sha256,
      derived_relink_cargo_lock_sha256:
        entries['baseline-derived-relink-Cargo.lock'].sha256,
      slv_executable_sha256: entries['baseline-slv'].sha256,
      bridge_standalone_sha256: entries['baseline-bridge'].sha256,
    },
    modified: {
      denort_sha256: entries['modified-denort'].sha256,
      v8_archive_sha256: entries['modified-v8-archive'].sha256,
      ninja_sha256: entries['modified-ninja'].sha256,
      probe_standalone_sha256: entries['modified-probe'].sha256,
    },
  }
  const sourceReceipt = 'f'.repeat(64)
  const manifest: Record<string, unknown> = {
    schema_version: 1,
    kind: 'slv-source-native-transport',
    target,
    source_receipt_sha256: sourceReceipt,
    artifacts,
    entries,
  }
  const build: Record<string, unknown> = {
    schema_version: 1,
    kind: 'slv-source-build-receipt',
    target,
    source_commit: 'a'.repeat(40),
    source_receipt_sha256: sourceReceipt,
    transport: { manifest: 'transport/manifest.json' },
    artifacts,
    split_build: {
      schema_version: 1,
      kind: 'slv-source-split-build-evidence',
    },
  }
  mutate?.(build, manifest)
  const manifestPath = `${transport}/manifest.json`
  const manifestSha256 = await writeJson(manifestPath, manifest)
  ;(build.transport as Record<string, string>).manifest_sha256 = manifestSha256
  const buildPath = `${artifact}/source-proofs/${target}/build-receipt.json`
  const buildSha256 = await writeJson(buildPath, build)
  return {
    artifact,
    build: buildPath,
    manifest: manifestPath,
    denort: `${transport}/baseline-denort`,
    probe: `${transport}/baseline-probe`,
    expectation: {
      buildReceiptSha256: buildSha256,
      manifestSha256,
      sourceCommit: 'a'.repeat(40),
      target,
      programs: {
        denort: {
          name: 'baseline-denort',
          sha256: entries['baseline-denort'].sha256,
          size: entries['baseline-denort'].size,
        },
        probe: {
          name: 'baseline-probe',
          sha256: entries['baseline-probe'].sha256,
          size: entries['baseline-probe'].size,
        },
      },
    },
  }
}

async function expectReject(
  action: () => Promise<unknown>,
  expected: string,
): Promise<void> {
  try {
    await action()
  } catch (error) {
    if (error instanceof Error && error.message.includes(expected)) return
    throw error
  }
  throw new Error(`expected rejection containing: ${expected}`)
}

function denoEval(source: string): { executable: string; args: string[] } {
  return { executable: Deno.execPath(), args: ['eval', source] }
}

type ProcessSnapshot = {
  pid: number
  pgrp: number
  sid: number
  state: string
}

async function processSnapshot(
  pid: number,
): Promise<ProcessSnapshot | undefined> {
  const result = await runBoundedObservationUtility(
    '/usr/bin/cat',
    [`/proc/${pid}/stat`],
    Date.now() + 100,
    4096,
  )
  if (!result.complete || result.exitCode !== 0 || result.stderr.bytes !== 0) {
    return undefined
  }
  const identity = parseProcStat(
    pid,
    new TextDecoder().decode(result.stdout.data),
  )
  return identity
    ? {
      pid: identity.pid,
      pgrp: identity.pgrp,
      sid: identity.sid,
      state: identity.state,
    }
    : undefined
}

async function waitForJson(path: string): Promise<Record<string, unknown>> {
  for (let attempt = 0; attempt < 80; attempt++) {
    const value = await Deno.readTextFile(path).catch(() => undefined)
    if (value) return JSON.parse(value) as Record<string, unknown>
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(`fixture did not write ${path}`)
}

function pipeHolderInvocation(
  recordPath: string,
  options: {
    childChangesPgrp: boolean
    leaderSleepMs?: number
    wrapperTimeoutSeconds?: string
  },
): { executable: string; args: string[] } {
  const child = [
    'import json,os,time',
    options.childChangesPgrp ? 'os.setpgrp()' : '',
    'stat=open("/proc/self/stat").read().split() ',
    `open(${
      JSON.stringify(recordPath)
    }, "w").write(json.dumps({"pid":os.getpid(),"pgrp":os.getpgrp(),"sid":os.getsid(0),"starttime":stat[21]}))`,
    'print("pipe-holder-ready", flush=True)',
    'time.sleep(1.5)',
  ].filter(Boolean).join('; ')
  const leader = [
    'import subprocess,time',
    `subprocess.Popen(["/usr/bin/python3","-c",${JSON.stringify(child)}])`,
    options.leaderSleepMs ? `time.sleep(${options.leaderSleepMs / 1000})` : '',
  ].filter(Boolean).join('; ')
  return {
    executable: '/usr/bin/prlimit',
    args: [
      '--core=0:0',
      '--',
      '/usr/bin/timeout',
      '--kill-after=0.05s',
      options.wrapperTimeoutSeconds ?? '0.15s',
      '/usr/bin/python3',
      '-c',
      leader,
    ],
  }
}

async function terminateFixture(pid: number | undefined): Promise<void> {
  if (!pid) return
  if (await processSnapshot(pid)) {
    try {
      Deno.kill(pid, 'SIGKILL')
    } catch {
      // The fixture already exited after the supervisor assertion.
    }
  }
}

async function waitForSpawn(
  child: ReturnType<typeof spawn>,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    child.once('spawn', resolve)
    child.once('error', reject)
  })
}

async function waitForExit(child: ReturnType<typeof spawn>): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return
  await new Promise<void>((resolve) => {
    const settled = () => {
      child.removeListener('exit', settled)
      resolve()
    }
    child.once('exit', settled)
    if (child.exitCode !== null || child.signalCode !== null) settled()
  })
}

type UtilityFixtureOutput = {
  bytes?: number
  retained_bytes?: number
  truncated?: boolean
  data?: Uint8Array
}
type UtilityFixtureOptions = {
  complete?: boolean
  exitCode?: number | null
  signal?: string | null
  stdout?: UtilityFixtureOutput
  stderr?: UtilityFixtureOutput
  reason?: string
}

function sidUtilityResult(options: UtilityFixtureOptions = {}) {
  const empty = {
    bytes: 0,
    retained_bytes: 0,
    truncated: false,
    data: new Uint8Array(),
  }
  return {
    complete: options.complete ?? true,
    exitCode: options.exitCode ?? 1,
    signal: options.signal ?? null,
    stdout: { ...empty, ...options.stdout },
    stderr: { ...empty, ...options.stderr },
    reason: options.reason,
  }
}

Deno.test('SID-empty classifier distinguishes verified absence from failed empty utility acquisition', () => {
  const sid = 123
  for (
    const [label, result] of [
      [
        'prior incomplete-empty stream failure',
        sidUtilityResult({
          complete: false,
          reason: 'utility stdout stream failed',
        }),
      ],
      [
        'signalled exit-one utility',
        sidUtilityResult({ signal: 'SIGKILL' }),
      ],
      [
        'deadline-expired empty utility',
        sidUtilityResult({
          complete: false,
          reason: 'utility acquisition deadline expired',
        }),
      ],
      [
        'truncated empty utility',
        sidUtilityResult({ stdout: { truncated: true } }),
      ],
      [
        'error-marked empty utility',
        sidUtilityResult({ reason: 'utility stderr stream failed' }),
      ],
      [
        'partial observed empty-retention utility',
        sidUtilityResult({ stdout: { bytes: 1 } }),
      ],
    ] as const
  ) {
    const classified = classifySidCandidates(result, sid)
    requireFixture(
      !classified.complete && classified.candidates.length === 0,
      `${label} was misclassified as a verified empty SID`,
    )
  }
  const verifiedEmpty = classifySidCandidates(sidUtilityResult(), sid)
  requireFixture(
    verifiedEmpty.complete && verifiedEmpty.candidates.length === 0,
    'completed GNU ps exit-one empty selection was not accepted as absence',
  )
  const row = new TextEncoder().encode('456 1 456 123 Ss\n')
  const validRows = classifySidCandidates(
    sidUtilityResult({
      exitCode: 0,
      stdout: {
        bytes: row.byteLength,
        retained_bytes: row.byteLength,
        data: row,
      },
    }),
    sid,
  )
  requireFixture(
    validRows.complete && validRows.candidates.length === 1 &&
      validRows.candidates[0].pid === 456 &&
      validRows.candidates[0].pgrp === 456,
    'valid SID-only ps rows no longer reach the exact-stat identity path',
  )
})

Deno.test('unprivileged observation uses fixed cat ticks and SID-only ps rows', async () => {
  const child = spawn('/usr/bin/python3', [
    '-c',
    'import time; time.sleep(2)',
  ], {
    detached: true,
    shell: false,
    stdio: 'ignore',
  })
  await waitForSpawn(child)
  const pid = child.pid
  requireFixture(pid !== undefined, 'detached observation fixture has no PID')
  try {
    let directProcDenied = false
    try {
      await Deno.readTextFile(`/proc/${pid}/stat`)
    } catch (error) {
      directProcDenied = error instanceof Deno.errors.NotCapable
    }
    requireFixture(
      directProcDenied,
      'test must use the same permission-compatible observation path as production',
    )
    const until = Date.now() + 500
    const cat = await runBoundedObservationUtility(
      '/usr/bin/cat',
      [`/proc/${pid}/stat`],
      until,
      4096,
    )
    requireFixture(
      cat.complete && cat.exitCode === 0 && cat.stderr.bytes === 0,
      'fixed cat did not acquire the detached child stat within its bound',
    )
    const identity = parseProcStat(
      pid,
      new TextDecoder().decode(cat.stdout.data),
    )
    requireFixture(
      identity?.pid === pid && identity.pgrp === pid && identity.sid === pid &&
        /^[0-9]+$/.test(identity.starttime),
      'fixed cat did not retain exact raw kernel start ticks and detached identity',
    )
    const selected = await runBoundedObservationUtility(
      '/usr/bin/ps',
      ['--sid', String(identity.sid), '-o', 'pid=,ppid=,pgid=,sid=,stat='],
      until,
      64 * 1024,
    )
    requireFixture(
      selected.complete && selected.exitCode === 0 &&
        selected.stderr.bytes === 0 &&
        new TextDecoder().decode(selected.stdout.data).split('\n').some(
          (line) => {
            const fields = line.trim().split(/\s+/)
            return fields.length === 5 && Number(fields[0]) === pid &&
              Number(fields[2]) === identity.pgrp &&
              Number(fields[3]) === identity.sid
          },
        ),
      'SID-only ps did not select the exact detached identity',
    )
    requireFixture(
      !sameBirth(identity, {
        ...identity,
        starttime: `${identity.starttime}1`,
      }) &&
        !sameBirth(identity, { ...identity, sid: identity.sid + 1 }) &&
        !parseProcStat(
          pid,
          `${pid} (bad) S not-a-pid 1 1 0 0 0 0 0 0 0 0 0 0 0 0 0 0`,
        ),
      'changed birth/SID or malformed metadata became eligible for ownership',
    )
  } finally {
    try {
      Deno.kill(-pid, 'SIGKILL')
    } catch {
      // The detached fixture may have exited before test cleanup.
    }
    await waitForExit(child)
  }
})

Deno.test('bounded observation utility caps oversized output and reaps a hanging fixed fixture', async () => {
  const hangingStarted = Date.now()
  const hanging = await runBoundedObservationUtility(
    '/usr/bin/python3',
    ['-c', 'import time; time.sleep(2)'],
    Date.now() + 40,
    4096,
  )
  requireFixture(
    !hanging.complete && Date.now() - hangingStarted < 250,
    'hanging utility acquired a fresh timeout or remained unreaped',
  )
  const oversized = await runBoundedObservationUtility(
    Deno.execPath(),
    [
      'eval',
      'await Deno.stdout.write(new TextEncoder().encode("x".repeat(200000))); await Deno.stderr.write(new TextEncoder().encode("y".repeat(200000)))',
    ],
    Date.now() + 500,
    1024,
  )
  requireFixture(
    !oversized.complete &&
      oversized.stdout.bytes + oversized.stderr.bytes >= 200000 &&
      oversized.stdout.retained_bytes + oversized.stderr.retained_bytes <= 1024,
    'oversized utility output exceeded its bounded retained capture',
  )
})

Deno.test('diagnostic protocol pins the old artifact separately from the reviewed helper source', () => {
  requireFixture(
    DIAGNOSTIC_PROTOCOL.oldRunId === '38628703267' &&
      DIAGNOSTIC_PROTOCOL.oldArtifactId === '11935008486' &&
      DIAGNOSTIC_PROTOCOL.oldSourceCommit ===
        '65f20c1220729edf43403cf88d825c086b9b6cab',
    'old artifact constants drifted',
  )
  requireFixture(
    DIAGNOSTIC_PROTOCOL.rawBuildReceiptSha256 ===
        '34524b1002ce72fa2b6fc80f66fc71f1e2e7faed82d427ccd34ed8cc7ada2ffc' &&
      DIAGNOSTIC_PROTOCOL.baselineProbe.size === 194123800,
    'stored-byte execution identity drifted',
  )
  const parsed = parseDiagnosticArgs([
    '--artifact-root',
    'artifact',
    '--out',
    'out',
    '--diagnostic-context',
    'context.json',
    '--reviewed-sha',
    'a'.repeat(40),
  ])
  requireFixture(
    parsed['--out'] === 'out',
    'entrypoint parser lost explicit output',
  )
  for (
    const argv of [
      ['--out', 'out'],
      [
        '--out',
        'one',
        '--out',
        'two',
        '--artifact-root',
        'artifact',
        '--diagnostic-context',
        'context',
        '--reviewed-sha',
        'a'.repeat(40),
      ],
      [
        '--unknown',
        'x',
        '--out',
        'out',
        '--artifact-root',
        'artifact',
        '--diagnostic-context',
        'context',
        '--reviewed-sha',
        'a'.repeat(40),
      ],
    ]
  ) {
    let rejected = false
    try {
      parseDiagnosticArgs(argv)
    } catch {
      rejected = true
    }
    requireFixture(
      rejected,
      'protocol parser accepted a non-exact argument set',
    )
  }
})

Deno.test('real child signal retains provenance and does not skip the packaged control', async () => {
  const root = await Deno.makeTempDir({ prefix: 'slv-diagnostic-signal-' })
  try {
    const controls = await runMandatoryControls(
      denoEval('Deno.kill(Deno.pid, "SIGTERM")'),
      denoEval('console.log(JSON.stringify({ output: 0.124 }))'),
      { cwd: root, home: `${root}/home`, timeoutMs: 2_000, outputLimit: 4096 },
    )
    requireFixture(
      controls.bare.signal === 'SIGTERM' || controls.bare.exit_code !== 0,
      'real child signal/nonzero status was not retained',
    )
    requireFixture(
      controls.bare.stdout.bytes === 0 && controls.bare.stderr.bytes === 0 &&
        controls.bare.stdout.retained_bytes === 0 &&
        controls.bare.stderr.retained_bytes === 0,
      'empty-output child status did not retain explicit zero log counters',
    )
    requireFixture(
      controls.probe.exit_code === 0 &&
        new TextDecoder().decode(controls.probe.stdout.data).includes('0.124'),
      'second packaged control did not run after the signal',
    )
    requireFixture(
      !controls.complete,
      'signalled bare control became diagnostic success',
    )
  } finally {
    await Deno.remove(root, { recursive: true })
  }
})

Deno.test('first fixed-control launch failure is recorded while the packaged control still runs', async () => {
  const root = await Deno.makeTempDir({ prefix: 'slv-diagnostic-launch-' })
  try {
    const controls = await runMandatoryControls(
      { executable: `${root}/missing-denort`, args: [] },
      denoEval('console.log("packaged control ran after launch error")'),
      { cwd: root, home: `${root}/home`, timeoutMs: 2_000, outputLimit: 4096 },
    )
    requireFixture(
      typeof controls.bare.acquisition_error === 'string' &&
        controls.bare.exit_code === null,
      'failed first launch did not retain an acquisition error record',
    )
    requireFixture(
      controls.probe.exit_code === 0 &&
        new TextDecoder().decode(controls.probe.stdout.data).includes(
          'packaged control ran after launch error',
        ),
      'packaged control was skipped after the bare launch error',
    )
    requireFixture(
      !controls.complete,
      'launch failure became diagnostic completion',
    )
  } finally {
    await Deno.remove(root, { recursive: true })
  }
})

Deno.test('expected bare-like exit and packaged result complete acquisition without creating proof output', async () => {
  const root = await Deno.makeTempDir({ prefix: 'slv-diagnostic-bare-' })
  try {
    const controls = await runMandatoryControls(
      denoEval(
        'console.error("Could not find standalone binary section."); Deno.exit(1)',
      ),
      denoEval('console.log(JSON.stringify({ output: 0.124 }))'),
      { cwd: root, home: `${root}/home`, timeoutMs: 2_000, outputLimit: 4096 },
    )
    requireFixture(
      controls.bare.expected_bare_result,
      'ordinary bare exit was not recognized as diagnostic evidence',
    )
    requireFixture(
      controls.complete,
      'valid two-control acquisition did not complete',
    )
    const proof = await Deno.lstat(`${root}/native-proof.json`).catch(() =>
      undefined
    )
    requireFixture(
      !proof,
      'low-level acquisition control created a native proof',
    )
  } finally {
    await Deno.remove(root, { recursive: true })
  }
})

Deno.test('bounded children drain oversized output and reap a hung child before the second control', async () => {
  const root = await Deno.makeTempDir({ prefix: 'slv-diagnostic-bounds-' })
  try {
    const oversized = await runBoundedChild(
      Deno.execPath(),
      [
        'eval',
        'await Deno.stdout.write(new TextEncoder().encode("x".repeat(200000))); await Deno.stderr.write(new TextEncoder().encode("y".repeat(200000)))',
      ],
      { cwd: root, home: `${root}/home`, timeoutMs: 2_000, outputLimit: 4096 },
    )
    requireFixture(
      oversized.stdout.bytes === 200000 && oversized.stderr.bytes === 200000 &&
        oversized.stdout.truncated && oversized.stderr.truncated &&
        oversized.stdout.retained_bytes + oversized.stderr.retained_bytes <=
          4096,
      'oversized output was not drained with a bounded retained prefix',
    )
    const controls = await runMandatoryControls(
      {
        executable: '/usr/bin/python3',
        args: ['-c', 'import time; time.sleep(10)'],
      },
      denoEval('console.log("second control ran")'),
      { cwd: root, home: `${root}/home`, timeoutMs: 80, outputLimit: 4096 },
    )
    requireFixture(
      controls.bare.timed_out,
      'hung child was not marked timed out',
    )
    requireFixture(
      controls.probe.exit_code === 0 &&
        new TextDecoder().decode(controls.probe.stdout.data).includes(
          'second control ran',
        ),
      'second mandatory control did not run after timeout/reap',
    )
  } finally {
    await Deno.remove(root, { recursive: true })
  }
})

Deno.test('absolute timeout selection preserves a local cause before, during, and without global bootstrap budget', async () => {
  const root = await Deno.makeTempDir({ prefix: 'slv-diagnostic-local-cause-' })
  const sleeping = [
    '--core=0:0',
    '--',
    '/usr/bin/python3',
    '-c',
    'import time; time.sleep(2)',
  ]
  const watchdog = startDiagnosticDeadline(2_000)
  try {
    const result = await runBoundedChild('/usr/bin/prlimit', sleeping, {
      cwd: root,
      home: `${root}/home`,
      timeoutMs: 70,
      outputLimit: 4096,
      deadline: watchdog.deadline,
    })
    const globalRemaining = watchdog.deadline.cleanupAt - Date.now()
    requireFixture(
      result.timed_out && result.deadline_expired !== true &&
        !watchdog.deadline.expired && globalRemaining > 1_000 &&
        result.capture_complete === false &&
        result.capture_incomplete_reason?.includes('local control timeout') &&
        (result.signal === 'SIGKILL' || result.exit_code !== 0),
      'local timeout was relabeled as a global deadline while global budget remained',
    )

    const bootstrapConsumed = await runBoundedChild(
      '/usr/bin/prlimit',
      sleeping,
      {
        cwd: root,
        home: `${root}/home`,
        timeoutMs: 1,
        outputLimit: 4096,
        deadline: watchdog.deadline,
      },
    )
    requireFixture(
      bootstrapConsumed.timed_out &&
        bootstrapConsumed.deadline_expired !== true &&
        bootstrapConsumed.capture_incomplete_reason?.includes(
          'local control timeout',
        ),
      'a local boundary consumed by bootstrap was not retained in the zero-remaining path',
    )

    const withoutGlobal = await runBoundedChild(
      '/usr/bin/prlimit',
      sleeping,
      {
        cwd: root,
        home: `${root}/home`,
        timeoutMs: 70,
        outputLimit: 4096,
      },
    )
    requireFixture(
      withoutGlobal.timed_out && withoutGlobal.deadline_expired !== true &&
        withoutGlobal.capture_incomplete_reason?.includes(
          'local control timeout',
        ),
      'a no-global local timeout was not classified as local',
    )
  } finally {
    watchdog.stop()
    await Deno.remove(root, { recursive: true })
  }
})

Deno.test('absolute timeout selector keeps global precedence for ties and consumed boundaries', () => {
  const withoutGlobal = selectDiagnosticTimeout(1_000, 70)
  const tie = selectDiagnosticTimeout(1_000, 70, 1_070)
  const consumedLocal = selectDiagnosticTimeout(1_000, 70, 2_000)
  const consumedGlobal = selectDiagnosticTimeout(1_000, 500, 1_100)
  requireFixture(
    withoutGlobal.cause === 'local' &&
      tie.cause === 'global' && tie.selectedSignalAt === 1_070 &&
      consumedLocal.cause === 'local' &&
      Math.max(0, consumedLocal.selectedSignalAt - 1_200) === 0 &&
      consumedGlobal.cause === 'global' &&
      Math.max(0, consumedGlobal.selectedSignalAt - 1_200) === 0,
    'absolute deadline selection did not retain its earliest cause after bootstrap elapsed',
  )
})

Deno.test('actual prlimit timeout leader cleanup preserves exit zero, terminates its changed-PGRP pipe holder, and persists partial evidence', async () => {
  const root = await Deno.makeTempDir({ prefix: 'slv-diagnostic-owned-tree-' })
  const out = `${root}/out`
  const recordPath = `${root}/descendant.json`
  const watchdog = startDiagnosticDeadline(1_200)
  let descendantPid: number | undefined
  let sentinel: ReturnType<typeof spawn> | undefined
  let sentinelPid: number | undefined
  try {
    await Deno.mkdir(out)
    sentinel = spawn('/usr/bin/python3', ['-c', 'import time; time.sleep(3)'], {
      detached: false,
      shell: false,
      stdio: 'ignore',
    })
    await waitForSpawn(sentinel)
    sentinelPid = sentinel.pid
    requireFixture(sentinelPid !== undefined, 'outside sibling has no PID')
    const invocation = pipeHolderInvocation(recordPath, {
      childChangesPgrp: true,
    })
    const started = Date.now()
    const phase = await runDiagnosticControlPhase(
      {
        bare: {
          ...invocation,
          targetArgv: [invocation.executable, ...invocation.args],
        },
        probe: {
          executable: '/usr/bin/python3',
          args: ['-c', 'print("second fixed control")'],
          targetArgv: ['/usr/bin/python3', 'probe', '0.125'],
        },
        cwd: root,
        home: `${root}/home`,
        out,
        deadline: watchdog.deadline,
        timeoutMs: 250,
        outputLimit: 4096,
      },
      async () => ({
        status: 'unavailable',
        reason: 'fixture debugger omitted',
      }),
    )
    const elapsed = Date.now() - started
    const descendant = await waitForJson(recordPath)
    descendantPid = Number(descendant.pid)
    await writeDiagnosticSummary(out, {
      schema_version: 1,
      kind: 'slv-native-diagnostic',
      status: 'acquisition-failed',
      ...diagnosticControlSummary(phase),
    })
    const persisted = JSON.parse(
      await Deno.readTextFile(`${out}/diagnostic-summary.json`),
    )
    const bare = phase.controls.bare
    requireFixture(
      elapsed < 1_100 && bare.exit_code === 0 && bare.signal === null &&
        bare.capture_complete === false &&
        bare.cleanup_incomplete !== true &&
        typeof bare.capture_incomplete_reason === 'string',
      'early timeout leader did not retain exit zero with bounded partial capture',
    )
    requireFixture(
      bare.owned_process?.pid === bare.owned_process?.pgrp &&
        bare.owned_process?.pid === bare.owned_process?.sid &&
        descendant.pgrp !== descendant.sid &&
        descendant.sid === bare.owned_process?.sid,
      'detached supervisor did not prove its session or changed-PGRP descendant',
    )
    requireFixture(
      !(await processSnapshot(descendantPid)) &&
        !!(await processSnapshot(sentinelPid)),
      'owned cleanup leaked a descendant or signalled an outside sibling',
    )
    requireFixture(
      persisted.controls.bare.exit_code === 0 &&
        persisted.controls.bare.capture_complete === false &&
        persisted.controls.probe.exit_code === 0,
      'actual control orchestration did not persist partial bare evidence and its second control',
    )
  } finally {
    watchdog.stop()
    await terminateFixture(descendantPid)
    if (sentinel) {
      await terminateFixture(sentinel.pid)
      await waitForExit(sentinel)
    }
    await Deno.remove(root, { recursive: true })
  }
})

Deno.test('global deadline wins a local-timeout race without leaving an owned pipe-holder', async () => {
  const root = await Deno.makeTempDir({ prefix: 'slv-diagnostic-global-tree-' })
  const recordPath = `${root}/descendant.json`
  const watchdog = startDiagnosticDeadline(350)
  let descendantPid: number | undefined
  try {
    const invocation = pipeHolderInvocation(recordPath, {
      childChangesPgrp: true,
      leaderSleepMs: 1_000,
      wrapperTimeoutSeconds: '5s',
    })
    const started = Date.now()
    const result = await runBoundedChild(
      invocation.executable,
      invocation.args,
      {
        cwd: root,
        home: `${root}/home`,
        timeoutMs: 1_000,
        outputLimit: 4096,
        deadline: watchdog.deadline,
      },
    )
    const elapsed = Date.now() - started
    const descendant = await waitForJson(recordPath)
    descendantPid = Number(descendant.pid)
    requireFixture(
      watchdog.deadline.expired && result.deadline_expired &&
        result.timed_out &&
        result.capture_complete === false &&
        result.capture_incomplete_reason?.includes(
          'global diagnostic deadline',
        ) &&
        result.cleanup_incomplete !== true && elapsed < 900,
      'global/local timeout race did not return bounded incomplete acquisition evidence',
    )
    requireFixture(
      !(await processSnapshot(descendantPid)) &&
        result.owned_process?.living_member_pids.length === 0,
      'global cleanup left a living process in its owned session',
    )
  } finally {
    watchdog.stop()
    await terminateFixture(descendantPid)
    await Deno.remove(root, { recursive: true })
  }
})

Deno.test('failed packaged control stays failed when a debugger-like child exits successfully', async () => {
  const root = await Deno.makeTempDir({
    prefix: 'slv-diagnostic-original-result-',
  })
  try {
    const controls = await runMandatoryControls(
      denoEval(
        'console.error("Could not find standalone binary section."); Deno.exit(1)',
      ),
      denoEval('Deno.exit(7)'),
      { cwd: root, home: `${root}/home`, timeoutMs: 2_000, outputLimit: 4096 },
    )
    const debuggerLike = await runBoundedChild(
      Deno.execPath(),
      ['eval', 'console.log("debugger collected")'],
      { cwd: root, home: `${root}/home`, timeoutMs: 2_000, outputLimit: 4096 },
    )
    requireFixture(
      debuggerLike.exit_code === 0,
      'debugger-like fixture did not complete',
    )
    requireFixture(
      !controls.complete && controls.probe.exit_code === 7,
      'debugger-like success overwrote original packaged failure',
    )
  } finally {
    await Deno.remove(root, { recursive: true })
  }
})

Deno.test('control phase persists original packaged failure after a successful debugger child', async () => {
  const root = await Deno.makeTempDir({
    prefix: 'slv-diagnostic-debugger-persist-',
  })
  const out = `${root}/out`
  await Deno.mkdir(out)
  const watchdog = startDiagnosticDeadline(2_000)
  try {
    const phase = await runDiagnosticControlPhase(
      {
        bare: {
          ...denoEval(
            'console.error("Could not find standalone binary section."); Deno.exit(1)',
          ),
          targetArgv: [Deno.execPath()],
        },
        probe: {
          ...denoEval('Deno.exit(7)'),
          targetArgv: [Deno.execPath(), 'probe', '0.125'],
        },
        cwd: root,
        home: `${root}/home`,
        out,
        deadline: watchdog.deadline,
      },
      async (target, args) => {
        const debuggerChild = await runBoundedChild(
          Deno.execPath(),
          ['eval', 'console.log("debugger child completed")'],
          {
            cwd: root,
            home: `${root}/home`,
            timeoutMs: 2_000,
            outputLimit: 4096,
          },
        )
        requireFixture(
          debuggerChild.exit_code === 0 && target === Deno.execPath() &&
            args.at(-1) === '0.125',
          'debugger orchestration did not retain the failed probe target argv',
        )
        return {
          status: 'attempted',
          result: {
            exit_code: debuggerChild.exit_code,
            signal: debuggerChild.signal,
          },
        }
      },
    )
    await writeDiagnosticSummary(out, {
      schema_version: 1,
      kind: 'slv-native-diagnostic',
      status: 'acquisition-failed',
      ...diagnosticControlSummary(phase),
    })
    const persisted = JSON.parse(
      await Deno.readTextFile(`${out}/diagnostic-summary.json`),
    )
    requireFixture(
      phase.controls.probe.exit_code === 7 &&
        persisted.controls.probe.exit_code === 7 &&
        persisted.debugger_records[0].status === 'attempted',
      'successful debugger record overwrote the original persisted probe failure',
    )
  } finally {
    watchdog.stop()
    await Deno.remove(root, { recursive: true })
  }
})

Deno.test('control phase persists unavailable debugger and global-deadline partial controls', async () => {
  const root = await Deno.makeTempDir({
    prefix: 'slv-diagnostic-deadline-persist-',
  })
  const out = `${root}/out`
  await Deno.mkdir(out)
  const watchdog = startDiagnosticDeadline(900)
  try {
    const phase = await runDiagnosticControlPhase(
      {
        bare: {
          ...denoEval('await new Promise(() => setInterval(() => {}, 1_000))'),
          targetArgv: [Deno.execPath()],
        },
        probe: {
          ...denoEval('console.log("must not be mistaken for completion")'),
          targetArgv: [Deno.execPath(), 'probe', '0.125'],
        },
        cwd: root,
        home: `${root}/home`,
        out,
        deadline: watchdog.deadline,
      },
      async () => ({
        status: 'unavailable',
        reason: 'trusted gdb is not installed',
      }),
    )
    await writeDiagnosticSummary(out, {
      schema_version: 1,
      kind: 'slv-native-diagnostic',
      status: 'acquisition-failed',
      ...diagnosticControlSummary(phase),
    })
    const persisted = JSON.parse(
      await Deno.readTextFile(`${out}/diagnostic-summary.json`),
    )
    requireFixture(
      watchdog.deadline.expired && phase.controls.bare.deadline_expired &&
        phase.controls.probe.deadline_expired &&
        typeof phase.controls.probe.acquisition_error === 'string',
      'global deadline did not kill/reap and explicitly record incomplete controls',
    )
    requireFixture(
      persisted.controls.probe.deadline_expired &&
        persisted.debugger_records[0].status === 'unavailable' &&
        persisted.missing_evidence.some((entry: string) =>
          entry.includes('global diagnostic deadline')
        ),
      'persisted partial summary omitted deadline or unavailable-debugger evidence',
    )
  } finally {
    watchdog.stop()
    await Deno.remove(root, { recursive: true })
  }
})

Deno.test('control phase retains direct records after debugger and control-log failures', async () => {
  const root = await Deno.makeTempDir({ prefix: 'slv-diagnostic-log-failure-' })
  const blockedOut = `${root}/blocked-output`
  const summaryOut = `${root}/summary-output`
  await Deno.writeTextFile(blockedOut, 'not a directory')
  await Deno.mkdir(summaryOut)
  const watchdog = startDiagnosticDeadline(2_000)
  try {
    const phase = await runDiagnosticControlPhase(
      {
        bare: {
          ...denoEval(
            'console.error("Could not find standalone binary section."); Deno.exit(1)',
          ),
          targetArgv: [Deno.execPath()],
        },
        probe: {
          ...denoEval('Deno.exit(7)'),
          targetArgv: [Deno.execPath(), 'probe', '0.125'],
        },
        cwd: root,
        home: `${root}/home`,
        out: blockedOut,
        deadline: watchdog.deadline,
      },
      async () => {
        throw new Error('debugger collector write failed')
      },
    )
    await writeDiagnosticSummary(summaryOut, {
      schema_version: 1,
      kind: 'slv-native-diagnostic',
      status: 'acquisition-failed',
      ...diagnosticControlSummary(phase),
    })
    const persisted = JSON.parse(
      await Deno.readTextFile(`${summaryOut}/diagnostic-summary.json`),
    )
    requireFixture(
      phase.controls.probe.exit_code === 7 &&
        persisted.controls.probe.exit_code === 7 &&
        persisted.debugger_records[0].status === 'acquisition-failed' &&
        persisted.missing_evidence.some((entry: string) =>
          entry.includes('log write failed')
        ),
      'log/debugger failure erased the original direct control result',
    )
  } finally {
    watchdog.stop()
    await Deno.remove(root, { recursive: true })
  }
})

Deno.test('stored-artifact validator uses raw bytes, manifest bindings, and safe filesystem paths before execution', async () => {
  const root = await Deno.makeTempDir({ prefix: 'slv-diagnostic-artifact-' })
  try {
    const valid = await artifactFixture(`${root}/valid`)
    const observed = await validateStoredArtifact(
      valid.artifact,
      valid.expectation,
    )
    requireFixture(
      observed.denort === valid.denort && observed.probe === valid.probe,
      'valid stored artifact did not resolve exact executable paths',
    )

    await Deno.writeTextFile(valid.build, '\n', { append: true })
    await expectReject(
      () => validateStoredArtifact(valid.artifact, valid.expectation),
      'build receipt raw bytes',
    )

    const manifestTamper = await artifactFixture(`${root}/manifest`)
    await Deno.writeTextFile(manifestTamper.manifest, '\n', { append: true })
    await expectReject(
      () =>
        validateStoredArtifact(
          manifestTamper.artifact,
          manifestTamper.expectation,
        ),
      'transport manifest raw bytes',
    )

    const bytesTamper = await artifactFixture(`${root}/program`)
    await Deno.writeTextFile(bytesTamper.denort, 'changed program bytes\n')
    await expectReject(
      () =>
        validateStoredArtifact(bytesTamper.artifact, bytesTamper.expectation),
      'bytes differ',
    )

    const sourceMismatch = await artifactFixture(`${root}/source`, (build) => {
      build.source_commit = 'b'.repeat(40)
    })
    await expectReject(
      () =>
        validateStoredArtifact(
          sourceMismatch.artifact,
          sourceMismatch.expectation,
        ),
      'fixed old source artifact',
    )

    const targetMismatch = await artifactFixture(`${root}/target`, (build) => {
      build.target = 'x86_64-unknown-linux-gnu'
    })
    await expectReject(
      () =>
        validateStoredArtifact(
          targetMismatch.artifact,
          targetMismatch.expectation,
        ),
      'fixed old source artifact',
    )

    const splitMismatch = await artifactFixture(`${root}/split`, (build) => {
      ;(build.split_build as Record<string, unknown>).kind = 'other-evidence'
    })
    await expectReject(
      () =>
        validateStoredArtifact(
          splitMismatch.artifact,
          splitMismatch.expectation,
        ),
      'split build evidence identity',
    )

    const traversal = await artifactFixture(
      `${root}/traversal`,
      (_build, manifest) => {
        const entries = manifest.entries as Record<
          string,
          Record<string, string>
        >
        entries['baseline-denort'].path = '../escaped'
      },
    )
    await expectReject(
      () => validateStoredArtifact(traversal.artifact, traversal.expectation),
      'basename-only',
    )

    const missing = await artifactFixture(`${root}/missing`)
    await Deno.remove(missing.probe)
    await expectReject(
      () => validateStoredArtifact(missing.artifact, missing.expectation),
      'missing or symlinked',
    )

    const symlink = await artifactFixture(`${root}/symlink`)
    await Deno.remove(symlink.denort)
    await Deno.symlink('../manifest.json', symlink.denort)
    await expectReject(
      () => validateStoredArtifact(symlink.artifact, symlink.expectation),
      'missing or symlinked',
    )

    const rootLink = `${root}/artifact-link`
    await Deno.symlink(symlink.artifact, rootLink)
    await expectReject(
      () => validateStoredArtifact(rootLink, symlink.expectation),
      'artifact root must be a real directory',
    )
  } finally {
    await Deno.remove(root, { recursive: true })
  }
})

Deno.test('context provenance rejects workflow, source, and checked-out-review mismatches before targets', () => {
  const reviewed = 'a'.repeat(40)
  const valid = {
    schema_version: 1,
    kind: 'slv-native-diagnostic-context',
    repository: 'ValidatorsDAO/slv',
    workflow_ref:
      'ValidatorsDAO/slv/.github/workflows/slv-remote-build.yml@refs/heads/codex/slv-eu-oss-delivery',
    workflow_sha: reviewed,
    diagnostic_source_commit: reviewed,
    run_id: '42',
    run_attempt: '1',
  }
  validateDiagnosticContext(parseDiagnosticContext(valid), reviewed, reviewed)
  for (
    const bad of [
      {
        ...valid,
        workflow_ref:
          'ValidatorsDAO/slv/.github/workflows/other.yml@refs/heads/codex/slv-eu-oss-delivery',
      },
      {
        ...valid,
        diagnostic_source_commit: DIAGNOSTIC_PROTOCOL.oldSourceCommit,
      },
    ]
  ) {
    let rejected = false
    try {
      validateDiagnosticContext(parseDiagnosticContext(bad), reviewed, reviewed)
    } catch {
      rejected = true
    }
    requireFixture(rejected, 'bad diagnostic context was accepted')
  }
  let checkoutRejected = false
  try {
    validateDiagnosticContext(
      parseDiagnosticContext(valid),
      reviewed,
      'b'.repeat(40),
    )
  } catch {
    checkoutRejected = true
  }
  requireFixture(
    checkoutRejected,
    'checked-out repository mismatch was accepted',
  )
})
