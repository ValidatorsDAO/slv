import { createHash } from 'node:crypto'
import {
  type ArtifactExpectation,
  DIAGNOSTIC_PROTOCOL,
  diagnosticControlSummary,
  parseDiagnosticArgs,
  parseDiagnosticContext,
  runBoundedChild,
  runDiagnosticControlPhase,
  runMandatoryControls,
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
      denoEval('await new Promise(() => setInterval(() => {}, 1_000))'),
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
  const watchdog = startDiagnosticDeadline(60)
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
