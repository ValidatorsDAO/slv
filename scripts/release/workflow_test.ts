import {
  assert,
  assertEquals,
  assertRejects,
  assertThrows,
} from 'jsr:@std/assert@1'
import {
  type CommandResult,
  guardDraftManifest,
  planDraftRecovery,
  publicationFor,
  resolveRelease,
  type ResolverRuntime,
  verifyBaselineRuntime,
  verifyWorkflowNeeds,
} from './workflow.ts'
import { manifest, payloadSpecs } from './release.ts'

const currentProductJobs = [
  'x86_64-unknown-linux-gnu',
  'aarch64-unknown-linux-gnu',
  'x86_64-apple-darwin',
  'aarch64-apple-darwin',
].map((target) => `build-${target}`)

const SHA = 'a'.repeat(40)
const BEFORE = 'b'.repeat(40)
const TAG_SHA = 'c'.repeat(40)
const versionFile = (version: string) => `export const VERSION = '${version}'\n`

function runtime(
  values: Record<string, string>,
  responses: Record<string, CommandResult>,
): ResolverRuntime {
  return {
    env(name) {
      return values[name]
    },
    async command(command, args) {
      const key = `${command} ${args.join(' ')}`
      const result = responses[key]
      if (!result) throw new Error(`unexpected command ${key}`)
      return result
    },
  }
}
const ok = (stdout = ''): CommandResult => ({ code: 0, stdout, stderr: '' })

async function releaseWorkflow(): Promise<string> {
  return await Deno.readTextFile(
    new URL('../../.github/workflows/slv-remote-build.yml', import.meta.url),
  )
}

function count(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1
}

function jobSection(workflow: string, name: string): string {
  const start = workflow.indexOf(`  ${name}:`)
  assert(start >= 0, `missing workflow job ${name}`)
  const remainder = workflow.slice(start + 1)
  const next = remainder.search(/\n  [a-z][a-z0-9_-]*:\n/)
  return workflow.slice(start, next === -1 ? undefined : start + 1 + next)
}

function stepShell(section: string, name: string): string {
  const start = section.indexOf(`      - name: ${name}\n`)
  assert(start >= 0, `missing workflow step ${name}`)
  const end = section.indexOf('\n      - ', start + 1)
  const step = section.slice(start, end === -1 ? undefined : end)
  const marker = '        run: |\n'
  const run = step.indexOf(marker)
  assert(run >= 0, `missing shell for ${name}`)
  return step.slice(run + marker.length).replace(/^          /gm, '')
}

async function runPrerequisiteShell(shell: string, needsJson: string) {
  return await new Deno.Command('bash', {
    args: ['-ceu', shell],
    clearEnv: true,
    env: {
      PATH: Deno.env.get('PATH') ?? '',
      NEEDS_JSON: needsJson,
    },
    stdout: 'piped',
    stderr: 'piped',
  }).output()
}

async function runDiagnosticGuard(
  shell: string,
  env: Record<string, string>,
) {
  return await new Deno.Command('bash', {
    args: ['-ceu', shell],
    clearEnv: true,
    env: {
      PATH: Deno.env.get('PATH') ?? '',
      ...env,
    },
    stdout: 'piped',
    stderr: 'piped',
  }).output()
}

function jobIf(section: string): string | undefined {
  return section.match(/^    if: (.+)$/m)?.[1]
}

function acquisitionController(workflow: string): string {
  const shell = stepShell(
    jobSection(workflow, 'source-native-diagnostic'),
    'Acquire existing or frozen official Ubuntu gdb',
  )
  const start = shell.indexOf('# BEGIN BOUNDED_GDB_ACQUISITION_CONTROLLER')
  const end = shell.indexOf('# END BOUNDED_GDB_ACQUISITION_CONTROLLER')
  assert(start >= 0 && end > start, 'missing bounded acquisition controller')
  return shell.slice(
    start,
    end + '# END BOUNDED_GDB_ACQUISITION_CONTROLLER'.length,
  )
}

async function runAcquisitionHarness(
  controller: string,
  harness: string,
) {
  const directory = await Deno.makeTempDir({ prefix: 'slv-acquisition-test-' })
  try {
    const controllerPath = `${directory}/controller.py`
    const harnessPath = `${directory}/harness.py`
    await Deno.writeTextFile(controllerPath, controller)
    await Deno.writeTextFile(harnessPath, harness)
    return await new Deno.Command('python3', {
      args: [harnessPath, controllerPath, directory],
      clearEnv: true,
      env: { PATH: Deno.env.get('PATH') ?? '' },
      stdout: 'piped',
      stderr: 'piped',
    }).output()
  } finally {
    await Deno.remove(directory, { recursive: true })
  }
}

function legacyOperationShell(workflow: string): string {
  const legacy = jobSection(workflow, 'legacy-bootstrap')
  const start = legacy.indexOf(
    '      - name: Replace the legacy bootstrap only after immutable release verification',
  )
  const end = legacy.indexOf(
    '      - name: Preserve legacy-bootstrap evidence on success or failure',
  )
  assert(start >= 0 && end > start, 'missing legacy operation step')
  const operation = legacy.slice(start, end)
  const match = operation.match(/        run: \|\n((?:          .*\n?)*)/)
  assert(match, 'missing legacy operation shell')
  return match[1].replace(/^          /gm, '')
}

async function executeLegacyOperation(
  shell: string,
  endpointHost: string,
  metadataFails = false,
) {
  const directory = await Deno.makeTempDir({ prefix: 'slv-workflow-test-' })
  const denoPath = `${directory}/deno`
  const argsPath = `${directory}/deno-args`
  const canary = 'bundle-canary-should-never-reach-process-output'
  await Deno.writeTextFile(
    denoPath,
    `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\0' "$@" >> "$FAKE_DENO_ARGS"
if [[ "$*" == *'r2-fixed-object.ts endpoint-host'* ]]; then
if [[ "\${FAKE_METADATA_FAIL:-}" = 1 ]]; then exit 1; fi
  printf '%s\\n' "$FAKE_ENDPOINT_HOST"
  exit 0
fi
if [[ "$*" == *'legacy-bootstrap.ts'* ]]; then exit 0; fi
exit 2
`,
  )
  await Deno.chmod(denoPath, 0o755)
  const result = await new Deno.Command('bash', {
    args: ['-ceu', shell],
    clearEnv: true,
    env: {
      PATH: `${directory}:${Deno.env.get('PATH') ?? ''}`,
      FAKE_DENO_ARGS: argsPath,
      FAKE_ENDPOINT_HOST: endpointHost,
      FAKE_METADATA_FAIL: metadataFails ? '1' : '0',
      OPERATION: 'legacy-bootstrap-preflight',
      VERSION: '2026.10.14',
      SOURCE_SHA: '',
      EXPECTED_PREIMAGE_SHA256: '',
      EXPECTED_PAYLOAD_SHA256: '',
      SLV_R2_CREDENTIALS_JSON: canary,
    },
    stdout: 'piped',
    stderr: 'piped',
  }).output()
  const args = await Deno.readTextFile(argsPath).catch(() => '')
  await Deno.remove(directory, { recursive: true })
  return { result, args, canary }
}

Deno.test('workflow persists one test-produced notice binding and makes every consumer verify it', async () => {
  const workflow = await releaseWorkflow()
  const graph =
    'deno run --frozen --allow-read --allow-write scripts/release/release.ts graph dist/release-inputs/deno-info.json'
  const prepare =
    'deno run --frozen --allow-read --allow-write scripts/release/release.ts prepare-licenses "$SOURCE_SHA" "$PRODUCER_RUN_ID" "$PRODUCER_RUN_ATTEMPT"'

  assert(workflow.indexOf(graph) < workflow.indexOf(prepare))
  assert(
    workflow.includes(
      'license_artifact_id: ${{ steps.upload-license-evidence.outputs.artifact-id }}',
    ),
  )
  assert(
    workflow.includes(
      'license_artifact_digest: ${{ steps.upload-license-evidence.outputs.artifact-digest }}',
    ),
  )
  assert(
    workflow.includes(
      'license_producer_attempt: ${{ steps.prepare-licenses.outputs.producer_attempt }}',
    ),
  )
  assert(
    workflow.includes(
      'license_notice_sha256: ${{ steps.prepare-licenses.outputs.notice_sha256 }}',
    ),
  )
  assert(
    workflow.includes(
      'name: slv-license-evidence-${{ github.run_id }}-${{ github.run_attempt }}',
    ),
  )
  assert(workflow.includes('dist/release-inputs/THIRD_PARTY_NOTICES'))
  assert(workflow.includes('dist/release-inputs/license-bundle.json'))
  assertEquals(
    count(
      workflow,
      'artifact-ids: ${{ needs.test.outputs.license_artifact_id }}',
    ),
    19,
  )
  assertEquals(
    count(
      workflow,
      'artifact-ids: ${{ needs.test.outputs.license_artifact_id }}\n          merge-multiple: true',
    ),
    2,
  )

  const verifyLines = workflow.split('\n').filter((line) =>
    line.includes('release.ts verify-licenses')
  )
  assertEquals(verifyLines.length, 15)
  for (const line of verifyLines) {
    assert(line.includes('${{ needs.test.outputs.license_producer_attempt }}'))
    assert(line.includes('${{ needs.test.outputs.license_notice_sha256 }}'))
    assert(!line.includes('github.run_attempt'))
  }
  const packageSection = jobSection(workflow, 'package')
  assert(!packageSection.includes('release.ts prepare-licenses'))
  assert(packageSection.includes('release.ts materialize-licenses'))
  assert(packageSection.includes(graph))
  for (
    const need of [
      'resolve',
      'test',
      'source-materials',
      'runtime-qualification',
      ...currentProductJobs,
    ]
  ) assert(packageSection.includes(need))
})

Deno.test('workflow binds notices into each native executable without runner credentials or global settings', async () => {
  const workflow = await releaseWorkflow()
  const test = jobSection(workflow, 'test')
  assert(test.includes('source-rebuild/verify-native_test.ts'))
  assert(test.includes('source-rebuild/verify-linux-product_test.ts'))
  assert(
    workflow.includes(
      '--include cli/lib/release/engine.py --include dist/release-inputs/THIRD_PARTY_NOTICES',
    ),
  )
  assert(
    workflow.includes(
      'env -i PATH="$PATH" HOME="$private_home" \'dist/slv-${{ matrix.target }}-exe\' licenses',
    ),
  )
  assert(
    workflow.includes(
      "cmp dist/release-inputs/THIRD_PARTY_NOTICES 'dist/slv-${{ matrix.target }}-licenses'",
    ),
  )
  assert(
    workflow.includes(
      'deno run --frozen --cached-only --allow-read --allow-write --allow-run --allow-env cli/lib/release/compiled_bridge_smoke.ts',
    ),
  )
})

Deno.test('source validation compiles only exact source-built Linux baseline runtimes', async () => {
  const workflow = await releaseWorkflow()
  const build = jobSection(workflow, 'source-validation-products')
  const packageSection = jobSection(workflow, 'package')

  for (
    const need of [
      'resolve',
      'test',
      'source-materials',
      'source-native-linux-x64',
      'source-native-macos-x64',
      'source-native-macos-arm64',
      'source-arm-build',
      'source-arm-merge',
    ]
  ) assert(build.includes(need))
  assert(!build.includes('"runner":"macos-15"'))
  assert(!build.includes('"runner":"macos-14"'))
  assert(build.includes('if: matrix.apple'))
  assert(
    build.includes(
      'DEVELOPER_DIR: /Applications/Xcode_16.2.app/Contents/Developer',
    ),
  )
  assert(build.includes("= 'Xcode 16.2'"))
  assert(build.includes('show-sdk-version)" = 15.2'))
  assert(build.includes('verify-baseline-runtime'))
  assert(build.includes('test -f "$runtime_path"'))
  assert(build.includes('test -f "$bridge_path"'))
  assert(build.includes('chmod u+x "$runtime_path" "$bridge_path"'))
  assert(build.includes('test -x "$runtime_path"'))
  assert(build.includes('test -x "$bridge_path"'))
  assert(
    build.indexOf('test "$runtime_sha256" = "$baseline_denort_sha256"') <
      build.indexOf('chmod u+x "$runtime_path" "$bridge_path"'),
  )
  assert(
    build.indexOf('test "$bridge_sha256" = "$baseline_bridge_sha256"') <
      build.indexOf('chmod u+x "$runtime_path" "$bridge_path"'),
  )
  assert(
    build.indexOf('chmod u+x "$runtime_path" "$bridge_path"') <
      build.indexOf('test -x "$runtime_path"'),
  )
  assert(build.includes('source-rebuild/verify-linux-product.ts'))
  assert(build.includes('--purpose execution'))
  assert(build.includes('linux-compatibility-receipt.json'))
  assert(build.includes('release-bridge-smoke'))
  assert(build.includes('product_executable="$(pwd -P)/dist/slv-$target-exe"'))
  assert(
    build.includes(
      '--executable "$product_executable" --bridge "$bridge_path"',
    ),
  )
  assert(
    build.includes(
      'cp "$bridge_path" "dist/release-inputs/product-runtime/$target/release-bridge-smoke"',
    ),
  )
  assert(!build.includes('--executable "dist/slv-$target-exe"'))
  assert(
    build.includes(
      "if [ '${{ matrix.target }}' = x86_64-unknown-linux-gnu ] || [ '${{ matrix.target }}' = aarch64-unknown-linux-gnu ]; then",
    ),
  )
  assert(!build.includes('--tls-cert'))
  assertEquals(
    count(
      build,
      'merge-multiple: true\n          path: dist/release-inputs/runtime-source/',
    ),
    4,
  )
  assert(
    build.includes('dist/release-inputs/product-runtime/${{ matrix.target }}'),
  )
  for (
    const target of [
      'x86_64-unknown-linux-gnu',
      'aarch64-unknown-linux-gnu',
      'x86_64-apple-darwin',
      'aarch64-apple-darwin',
    ]
  ) {
    assert(build.includes(`runtime-source/${target}`))
    assert(
      packageSection.includes(
        `artifact-ids: ${'${{ needs.build-'}${target}.outputs.artifact_id }}`,
      ),
    )
  }
  for (
    const [job, target] of [
      ['source-native-linux-x64', 'x86_64-unknown-linux-gnu'],
      ['source-native-macos-x64', 'x86_64-apple-darwin'],
      ['source-native-macos-arm64', 'aarch64-apple-darwin'],
      ['source-arm-build', 'aarch64-unknown-linux-gnu'],
    ] as const
  ) {
    const sourceJob = jobSection(workflow, job)
    assert(
      sourceJob.includes(`source-proofs/${target}/transport/baseline-bridge`),
    )
  }
  for (
    const target of [
      'x86_64-unknown-linux-gnu',
      'aarch64-unknown-linux-gnu',
    ]
  ) {
    const sourceJob = target === 'x86_64-unknown-linux-gnu'
      ? jobSection(workflow, 'source-native-linux-x64')
      : jobSection(workflow, 'source-arm-build')
    assert(
      sourceJob.includes(`source-proofs/${target}/transport/tls-localhost.crt`),
    )
    assert(
      sourceJob.includes(`source-proofs/${target}/transport/tls-localhost.key`),
    )
    assert(
      sourceJob.includes(`source-proofs/${target}/transport/tls-root-ca.pem`),
    )
  }
  for (
    const job of [
      'source-native-macos-x64',
      'source-native-macos-arm64',
    ]
  ) {
    assert(!jobSection(workflow, job).includes('tls-root-ca.pem'))
  }
  assertEquals(
    count(
      build,
      'DENORT_BIN="$runtime_path" deno compile --frozen --cached-only',
    ),
    1,
  )
  assert(!build.includes('deno compile --frozen --cached-only -A -o'))
  assert(build.includes('test "$runtime_sha256" = "$baseline_denort_sha256"'))
  assert(build.includes('test "$bridge_sha256" = "$baseline_bridge_sha256"'))
  assert(build.includes("'dist/slv-${{ matrix.target }}-exe' --version"))
  assert(
    build.includes("'dist/slv-${{ matrix.target }}-exe' --help >/dev/null"),
  )
  assert(
    build.includes(
      "cmp dist/release-inputs/THIRD_PARTY_NOTICES 'dist/slv-${{ matrix.target }}-licenses'",
    ),
  )
  assert(
    build.includes('schema_version: 1, kind: "slv-product-runtime-receipt"'),
  )
  assert(!packageSection.includes('path: downloaded'))
  assert(!packageSection.includes('find downloaded'))
})

Deno.test('product typecheck executes the workflow argv and rejects invalid TypeScript', async () => {
  const shell = stepShell(
    jobSection(await releaseWorkflow(), 'source-validation-products'),
    'Compile and execute the source-bound native target',
  )
  const commands = shell.match(/^deno check(?:[ \t]+[^\n]+)?$/gm) ?? []
  assertEquals(commands.length, 1, 'expected exactly one product check command')
  const command = commands[0]
  assert(command, 'missing product check command')
  const words = command.split(/\s+/)
  assert(
    words.every((word) => /^[\w./-]+$/.test(word)),
    'unsupported shell syntax in product check',
  )
  assertEquals(words.slice(0, 2), ['deno', 'check'])
  assertEquals(words.at(-1), 'cli/src/index.ts')
  assertEquals(words.filter((word) => word === 'cli/src/index.ts').length, 1)

  const directory = await Deno.makeTempDir({ prefix: 'slv-product-check-' })
  try {
    await Deno.mkdir(`${directory}/cli/src`, { recursive: true })
    await Deno.mkdir(`${directory}/home`)
    await Deno.writeTextFile(`${directory}/deno.json`, '{"lock":"deno.lock"}\n')
    const lock = '{"version":"5"}\n'
    const lockPath = `${directory}/deno.lock`
    await Deno.writeTextFile(lockPath, lock)
    const lockBytes = await Deno.readFile(lockPath)
    const entry = `${directory}/cli/src/index.ts`
    const runCheck = async (args: string[]) => {
      const result = await new Deno.Command(Deno.execPath(), {
        args,
        cwd: directory,
        clearEnv: true,
        env: {
          HOME: `${directory}/home`,
          DENO_DIR: `${directory}/cache`,
          DENO_NO_UPDATE_CHECK: '1',
        },
        stdout: 'piped',
        stderr: 'piped',
      }).output()
      assertEquals(
        await Deno.readFile(lockPath),
        lockBytes,
        'fixture lock changed',
      )
      return result
    }
    const output = (result: Deno.CommandOutput) =>
      new TextDecoder().decode(result.stdout) +
      new TextDecoder().decode(result.stderr)
    const args = words.slice(1)
    await Deno.writeTextFile(
      entry,
      'const value: number = 1\nconsole.log(value)\n',
    )
    const valid = await runCheck(args)
    assertEquals(valid.code, 0, output(valid))

    await Deno.writeTextFile(
      entry,
      'const value: number = "wrong"\nconsole.log(value)\n',
    )
    const invalid = await runCheck(args)
    assert(invalid.code !== 0, 'type error unexpectedly passed')
    assert(output(invalid).includes('TS2322'), output(invalid))

    const old = await runCheck([args[0], '--cached-only', ...args.slice(1)])
    assert(old.code !== 0, 'obsolete flag unexpectedly passed')
    assert(
      output(old).includes("unexpected argument '--cached-only'"),
      output(old),
    )
    assertEquals(words, ['deno', 'check', '--frozen', 'cli/src/index.ts'])
  } finally {
    await Deno.remove(directory, { recursive: true })
  }

  const install = 'deno install --frozen --allow-scripts=npm:protobufjs@7.4.0'
  const compile =
    "DENORT_BIN=\"$runtime_path\" deno compile --frozen --cached-only -A --include cli/lib/release/engine.py --include dist/release-inputs/THIRD_PARTY_NOTICES --target '${{ matrix.target }}' --output 'dist/slv-${{ matrix.target }}-exe' cli/src/index.ts"
  assertEquals(count(shell, install), 1)
  assertEquals(count(shell, compile), 1)
  assert(shell.indexOf(install) < shell.indexOf(command))
  assert(shell.indexOf(command) < shell.indexOf(compile))
})

Deno.test('all native execution tool acquisitions bind their target descriptors', async () => {
  const workflow = await releaseWorkflow()
  const acquisitions = workflow.split('\n').filter((line) =>
    line.includes('source-rebuild/prepare-tools.ts') &&
    line.includes('--purpose execution') &&
    line.includes('$RUNNER_TEMP/source-tools/execution')
  )
  assertEquals(acquisitions.length, 4)
  for (const acquisition of acquisitions) {
    assert(
      acquisition.includes(
        '--descriptor "dist/release-inputs/tool-pins/$TARGET.json"',
      ),
    )
  }
})

Deno.test('ARM merge restores the flattened execution receipt only through its exact artifact ID', async () => {
  const workflow = await releaseWorkflow()
  const merge = jobSection(workflow, 'source-arm-merge')
  assert(
    merge.includes('Download exact notice, source, and ARM build artifacts'),
  )
  assert(
    !merge.includes(
      '${{ needs.source-arm-build.outputs.artifact_id }},${{ needs.source-arm-execute.outputs.artifact_id }}',
    ),
  )
  assert(
    merge.includes(
      'Download the exact ARM execution receipt into its proof directory',
    ),
  )
  assert(
    merge.includes(
      'artifact-ids: ${{ needs.source-arm-execute.outputs.artifact_id }}',
    ),
  )
  assert(
    merge.includes(
      'path: dist/release-inputs/source-proofs/aarch64-unknown-linux-gnu',
    ),
  )
  assert(
    merge.includes(
      "test -n '${{ needs.source-arm-execute.outputs.artifact_digest }}'",
    ),
  )
  assert(merge.includes('source-proofs/$TARGET/execution-receipt.json'))
})

Deno.test('workflow keeps CI-only pull-request builds and permissions narrow', async () => {
  const workflow = await releaseWorkflow()
  const ciCondition =
    "needs.resolve.outputs.release_required == 'true' || github.event_name == 'pull_request'"

  assert(workflow.includes('permissions: {}'))
  assert(workflow.includes(ciCondition))
  assertEquals(count(workflow, 'id-token: write'), 2)
  assert(
    jobSection(workflow, 'qualification-promotion').includes('id-token: write'),
  )
  assert(jobSection(workflow, 'attest').includes('id-token: write'))
  const legacyBootstrap = jobSection(workflow, 'legacy-bootstrap')
  const normalWorkflow = workflow.replace(legacyBootstrap, '')
  assert(!normalWorkflow.includes('secrets.'))
  assertEquals(count(workflow, 'secrets.SLV_R2_CREDENTIALS_JSON'), 1)
  assert(!workflow.includes('CLOUDFLARE_ACCOUNT_ID'))
  assert(!workflow.includes('CLOUDFLARE_API_TOKEN'))
  assert(legacyBootstrap.includes("github.event_name == 'workflow_dispatch'"))
  assert(
    legacyBootstrap.includes(
      "inputs.operation == 'legacy-bootstrap-preflight'",
    ),
  )
  assert(
    legacyBootstrap.includes("inputs.operation == 'legacy-bootstrap-apply'"),
  )
  assert(legacyBootstrap.includes('test "$REF" = refs/heads/main'))
  assert(legacyBootstrap.includes('environment: release'))
  assert(legacyBootstrap.includes('contents: read'))
  assert(!legacyBootstrap.includes('contents: write'))
  assert(
    legacyBootstrap.includes(
      'group: slv-legacy-bootstrap-object-${{ github.repository }}-slv-install',
    ),
  )
  assert(legacyBootstrap.includes('cancel-in-progress: false'))
  assert(
    workflow.includes(
      "format('slv-legacy-bootstrap-dispatch-{0}', github.repository)",
    ),
  )
})

Deno.test('legacy bootstrap uses one step-local S3 bundle and exact network grants', async () => {
  const workflow = await releaseWorkflow()
  const legacy = jobSection(workflow, 'legacy-bootstrap')
  const normal = workflow.replace(legacy, '')
  const shell = legacyOperationShell(workflow)

  assertEquals(count(legacy, 'secrets.SLV_R2_CREDENTIALS_JSON'), 1)
  assert(
    legacy.includes(
      'SLV_R2_CREDENTIALS_JSON: ${{ secrets.SLV_R2_CREDENTIALS_JSON }}',
    ),
  )
  assert(!normal.includes('SLV_R2_CREDENTIALS_JSON'))
  assert(!legacy.includes('api.cloudflare.com'))
  assert(!legacy.includes('onepassword'))
  assert(!legacy.includes('GITHUB_ENV'))
  assert(!legacy.includes('GITHUB_OUTPUT'))
  assert(!shell.includes('set -x'))
  assert(
    shell.includes(
      'deno run --frozen --no-prompt --allow-env=SLV_R2_CREDENTIALS_JSON scripts/release/r2-fixed-object.ts endpoint-host',
    ),
  )
  assert(
    shell.includes(
      'deno run --frozen --no-prompt --allow-read --allow-write --allow-env=SLV_R2_CREDENTIALS_JSON --allow-net="$endpoint_host,api.github.com,storage.slv.dev" scripts/release/legacy-bootstrap.ts "${args[@]}"',
    ),
  )
  assert(
    shell.indexOf('r2-fixed-object.ts endpoint-host') <
      shell.indexOf('legacy-bootstrap.ts'),
  )
})

Deno.test('legacy bootstrap rejects invalid endpoint metadata before consumer invocation', async () => {
  const shell = legacyOperationShell(await releaseWorkflow())
  const hosts = [
    'a'.repeat(32) + '.r2.cloudflarestorage.com',
    'a'.repeat(32) + '.eu.r2.cloudflarestorage.com',
    'a'.repeat(32) + '.us.r2.cloudflarestorage.com',
    'a'.repeat(32) + '.fedramp.r2.cloudflarestorage.com',
  ]

  for (const host of hosts) {
    const { result, args, canary } = await executeLegacyOperation(shell, host)
    assertEquals(result.code, 0)
    const captured = new TextDecoder().decode(result.stdout) +
      new TextDecoder().decode(result.stderr) + args
    assert(!captured.includes(canary))
    assert(args.includes('--allow-env=SLV_R2_CREDENTIALS_JSON'))
    assert(args.includes(`--allow-net=${host},api.github.com,storage.slv.dev`))
  }

  for (
    const host of [
      'invalid.example.com',
      'a'.repeat(32) + '.r2.cloudflarestorage.com,attacker.example.com',
    ]
  ) {
    const { result, args, canary } = await executeLegacyOperation(shell, host)
    assertEquals(result.code, 65)
    assert(!args.includes('legacy-bootstrap.ts'))
    const captured = new TextDecoder().decode(result.stdout) +
      new TextDecoder().decode(result.stderr) + args
    assert(!captured.includes(canary))
  }

  const failedMetadata = await executeLegacyOperation(
    shell,
    hosts[0],
    true,
  )
  assertEquals(failedMetadata.result.code, 1)
  assert(!failedMetadata.args.includes('legacy-bootstrap.ts'))
  const captured = new TextDecoder().decode(failedMetadata.result.stdout) +
    new TextDecoder().decode(failedMetadata.result.stderr) + failedMetadata.args
  assert(!captured.includes(failedMetadata.canary))
})

Deno.test('workflow freezes source materials and uses exact identities for four native source proofs', async () => {
  const workflow = await releaseWorkflow()
  const packageSection = workflow.slice(workflow.indexOf('  package:'))
  const sourceMaterials = workflow.slice(
    workflow.indexOf('  source-materials:'),
    workflow.indexOf('  source-native-linux-x64:'),
  )

  assert(sourceMaterials.includes('runs-on: ubuntu-26.04'))
  assert(sourceMaterials.includes('timeout-minutes: 90'))
  assert(
    sourceMaterials.includes(
      'test -z "$(git status --porcelain --untracked-files=no)"',
    ),
  )
  assert(
    sourceMaterials.includes('scripts/release/source-materials.ts package'),
  )
  for (
    const archive of [
      'slv-source.tar.gz',
      'deno-source.tar.gz',
      'deno-cargo-vendor.tar.gz',
    ]
  ) assert(sourceMaterials.includes(`source-materials/${archive}`))
  assert(
    sourceMaterials.includes(
      'dist/release-inputs/source-materials-receipt.json',
    ),
  )
  assert(sourceMaterials.includes('compression-level: 0'))
  assert(!sourceMaterials.includes('find '))
  assert(
    sourceMaterials.includes(
      'artifact_id: ${{ steps.upload-source-materials.outputs.artifact-id }}',
    ),
  )
  assert(
    sourceMaterials.includes(
      'artifact_digest: ${{ steps.upload-source-materials.outputs.artifact-digest }}',
    ),
  )
  assert(
    sourceMaterials.includes('producer_attempt: ${{ github.run_attempt }}'),
  )

  const nativeJobs = [
    ['source-native-macos-arm64', 'macos-15', 'aarch64-apple-darwin'],
  ] as const
  for (const [job, runner, target] of nativeJobs) {
    const section = jobSection(workflow, job)
    assert(section.includes(`runs-on: ${runner}`))
    assert(section.includes('timeout-minutes: 350'))
    assert(
      section.includes(
        'artifact_id: ${{ steps.upload-proof.outputs.artifact-id }}',
      ),
    )
    assert(
      section.includes(
        'artifact_digest: ${{ steps.upload-proof.outputs.artifact-digest }}',
      ),
    )
    assert(section.includes('producer_attempt: ${{ github.run_attempt }}'))
    assert(section.includes(`source-proofs/${target}/native-proof.json`))
    assert(section.includes(`source-proofs/${target}/build-receipt.json`))
    assert(section.includes(`source-proofs/${target}/execution-receipt.json`))
    assert(section.includes(`tool-pins/${target}.json`))
    assert(
      section.includes(
        '--descriptor "dist/release-inputs/tool-pins/$TARGET.json"',
      ),
    )
    assert(section.includes('--phase build'))
    assert(section.includes('--phase execute'))
    assert(section.includes('--phase merge'))
    assert(
      !section.includes('verify-native.ts --phase build') ||
        !section.includes('--allow-net source-rebuild/verify-native.ts'),
    )
  }
  assert(workflow.includes('# matrix outputs to a last writer'))
  assert(!workflow.includes('source-native:\n    strategy:'))

  const armBuild = workflow.slice(
    workflow.indexOf('  source-arm-build:'),
    workflow.indexOf('  source-arm-execute:'),
  )
  const armExecute = workflow.slice(
    workflow.indexOf('  source-arm-execute:'),
    workflow.indexOf('  source-arm-merge:'),
  )
  const armMerge = workflow.slice(
    workflow.indexOf('  source-arm-merge:'),
    workflow.indexOf('  package:'),
  )
  assert(armBuild.includes('runs-on: ubuntu-26.04'))
  assert(armBuild.includes('timeout-minutes: 350'))
  assert(armBuild.includes('--phase join-build'))
  assert(!armBuild.includes('--purpose build'))
  assert(armBuild.includes('tool-pin.json'))
  assert(armExecute.includes('runs-on: ubuntu-26.04-arm'))
  assert(armExecute.includes('timeout-minutes: 30'))
  assert(armExecute.includes('--build-host "$BUILD_HOST" --purpose execution'))
  assert(armExecute.includes('no x64'))
  assert(armMerge.includes('runs-on: ubuntu-26.04'))
  assert(armMerge.includes('timeout-minutes: 15'))
  assert(armMerge.includes('--phase merge'))
  assert(armMerge.includes('execution_receipt_sha256'))

  const macArm = workflow.slice(
    workflow.indexOf('  source-native-macos-arm64:'),
    workflow.indexOf('  source-arm-build:'),
  )
  assert(
    macArm.includes(
      'DEVELOPER_DIR: /Applications/Xcode_16.2.app/Contents/Developer',
    ),
  )
  assert(macArm.includes("= 'Xcode 16.2'"))
  assert(macArm.includes('show-sdk-version)" = 15.2'))
  assert(macArm.includes('SLV_APPLE_SDK_PATH'))
  const macX64 = jobSection(workflow, 'source-native-macos-x64')
  assert(
    macX64.includes(
      'DEVELOPER_DIR: /Applications/Xcode_16.2.app/Contents/Developer',
    ),
  )
  assert(macX64.includes("= 'Xcode 16.2'"))
  assert(macX64.includes('show-sdk-version)" = 15.2'))
  assert(macX64.includes('SLV_APPLE_SDK_PATH'))
  assert(macX64.includes('--phase join-build'))
  assert(!macX64.includes('--purpose build'))

  assert(
    packageSection.includes('needs.runtime-qualification.outputs.artifact_id'),
  )
  assert(!packageSection.includes('needs.source-native-macos'))
  assert(!packageSection.includes('path: downloaded'))
  assert(!packageSection.includes('find downloaded'))
})

Deno.test('split native producers preserve the required facades and fail them closed', async () => {
  const workflow = await releaseWorkflow()
  const producerSpecs = [
    [
      'source-arm-baseline',
      'ubuntu-26.04',
      'aarch64-unknown-linux-gnu',
      'x86_64-unknown-linux-gnu',
      'baseline',
      320,
    ],
    [
      'source-arm-modified',
      'ubuntu-26.04',
      'aarch64-unknown-linux-gnu',
      'x86_64-unknown-linux-gnu',
      'modified',
      320,
    ],
    [
      'source-macos-x64-baseline',
      'macos-15-intel',
      'x86_64-apple-darwin',
      'x86_64-apple-darwin',
      'baseline',
      340,
    ],
    [
      'source-macos-x64-modified',
      'macos-15-intel',
      'x86_64-apple-darwin',
      'x86_64-apple-darwin',
      'modified',
      340,
    ],
  ] as const
  for (
    const [job, runner, target, buildHost, variant, timeout] of producerSpecs
  ) {
    const section = jobSection(workflow, job)
    assert(section.includes('needs: [resolve, test, source-materials]'))
    assert(
      section.includes(
        runner === 'ubuntu-26.04'
          ? "|| 'ubuntu-26.04' }}"
          : `runs-on: ${runner}`,
      ),
    )
    assert(section.includes('timeout-minutes: 350'))
    assert(section.includes('contents: read'))
    assert(section.includes(`TARGET: ${target}`))
    assert(section.includes(`BUILD_HOST: ${buildHost}`))
    assert(section.includes(`VARIANT: ${variant}`))
    assert(section.includes(`id: variant\n        timeout-minutes: ${timeout}`))
    assert(section.includes('--phase build-variant'))
    assert(
      section.includes(
        target.endsWith('linux-gnu')
          ? 'build_args=(--jobs 4)'
          : '--variant "$VARIANT" --jobs 4',
      ),
    )
    assert(section.includes('--purpose build'))
    assert(section.includes('producer-context.json'))
    assert(section.includes('variant_receipt_sha256'))
    assert(section.includes('id: upload-variant'))
    assert(section.includes('compression-level: 0'))
    assert(section.includes('if-no-files-found: error'))
    assert(section.includes('variant-receipt.json'))
    assert(section.includes('build-tools-receipt.json'))
    assert(section.includes('tool-pin.json'))
    assert(section.includes('/transport'))
    const upload = section.slice(
      section.indexOf('id: upload-variant'),
      section.indexOf('Preserve ', section.indexOf('id: upload-variant')),
    )
    assert(!upload.includes('if:'))
    assert(section.includes('if: ${{ always() && !cancelled() }}'))
    assert(section.includes('timeout-minutes: 5'))
    assert(!section.includes('--allow-net source-rebuild/verify-native.ts'))
  }

  const facades = [
    [
      'source-arm-build',
      [
        'resolve',
        'test',
        'source-materials',
        'source-arm-baseline',
        'source-arm-modified',
      ],
      'source-arm-baseline',
      'source-arm-modified',
      30,
    ],
    [
      'source-native-macos-x64',
      [
        'resolve',
        'test',
        'source-materials',
        'source-macos-x64-baseline',
        'source-macos-x64-modified',
      ],
      'source-macos-x64-baseline',
      'source-macos-x64-modified',
      60,
    ],
  ] as const
  for (const [job, needs, baseline, modified, joinTimeout] of facades) {
    const section = jobSection(workflow, job)
    assertEquals(
      jobIf(section),
      "${{ !cancelled() && (needs.resolve.outputs.mode == 'runtime-qualification'" +
        (job === 'source-arm-build'
          ? " || needs.resolve.outputs.linux_validation == 'true'"
          : '') +
        ') }}',
    )
    assert(section.includes(`timeout-minutes: ${joinTimeout}`))
    const firstStep = section.indexOf('      - name:')
    assert(
      section.slice(firstStep).startsWith(
        '      - name: Require every source prerequisite to succeed\n',
      ),
    )
    const prerequisite = stepShell(
      section,
      'Require every source prerequisite to succeed',
    )
    assert(prerequisite.includes('set -euo pipefail'))
    assert(
      prerequisite.includes(`--argjson expected '${JSON.stringify(needs)}'`),
    )
    assert(!prerequisite.includes('continue-on-error'))
    assert(section.indexOf('actions/checkout') > section.indexOf(prerequisite))
    assert(
      section.includes(
        'artifact-ids: ${{ needs.' + baseline + '.outputs.artifact_id }}',
      ),
    )
    assert(
      section.includes(
        'artifact-ids: ${{ needs.' + modified + '.outputs.artifact_id }}',
      ),
    )
    assert(section.includes('merge-multiple: true'))
    assert(section.includes('--phase join-build'))
    assert(!section.includes('--phase build "${common[@]}"'))
    assert(section.includes('materials: $baseline_materials'))
    assert(section.includes('materials: $modified_materials'))
    assert(!section.includes('baseline_materials "$baseline_root/transport"'))
    assert(section.includes('artifact_digest: $baseline_artifact_digest'))
    assert(section.includes('artifact_digest: $modified_artifact_digest'))

    const valid = Object.fromEntries(
      needs.map((need) => [need, { result: 'success', outputs: { x: '1' } }]),
    )
    assert(
      (await runPrerequisiteShell(prerequisite, JSON.stringify(valid))).success,
    )
    const negative = [
      '',
      'null',
      '[]',
      '{}',
      `${JSON.stringify(valid)}\n${JSON.stringify(valid)}`,
      JSON.stringify({ ...valid, extra: { result: 'success' } }),
      ...needs.map((missing) =>
        JSON.stringify(Object.fromEntries(
          Object.entries(valid).filter(([key]) => key !== missing),
        ))
      ),
      ...['failure', 'skipped', 'cancelled', 'neutral', '', null, false].map(
        (result) =>
          JSON.stringify({
            ...valid,
            [needs[0]]: { result },
          }),
      ),
      JSON.stringify({ ...valid, [needs[0]]: null }),
      JSON.stringify({ ...valid, [needs[0]]: [] }),
    ]
    for (const control of negative) {
      assert(!(await runPrerequisiteShell(prerequisite, control)).success)
    }
  }

  const arm = jobSection(workflow, 'source-arm-build')
  const mac = jobSection(workflow, 'source-native-macos-x64')
  assert(
    arm.includes(
      'runtime_artifact_id: ${{ steps.upload-runtime.outputs.artifact-id }}',
    ),
  )
  assert(
    mac.includes(
      'runtime_artifact_id: ${{ steps.upload-runtime.outputs.artifact-id }}',
    ),
  )
  assert(mac.includes('--purpose execution'))
  assert(mac.includes('--phase execute'))
  assert(mac.includes('--phase merge'))
  assert(arm.includes('if: ${{ always() && !cancelled() }}'))
  assert(mac.includes('if: ${{ always() && !cancelled() }}'))
})

Deno.test('Linux x64 cold producers isolate jobs2 builds and the facade binds both variants', async () => {
  const workflow = await releaseWorkflow()
  const target = 'x86_64-unknown-linux-gnu'
  const producerSpecs = [
    ['source-linux-x64-baseline', 'baseline'],
    ['source-linux-x64-modified', 'modified'],
  ] as const

  for (const [job, variant] of producerSpecs) {
    const section = jobSection(workflow, job)
    assert(section.includes('needs: [resolve, test, source-materials]'))
    assert(
      section.includes(
        "if: ${{ !cancelled() && (needs.resolve.outputs.mode == 'runtime-qualification' || needs.resolve.outputs.linux_validation == 'true') }}",
      ),
    )
    assert(section.includes("|| 'ubuntu-26.04' }}"))
    assert(section.includes('timeout-minutes: 350'))
    assert(section.includes('contents: read'))
    assert(section.includes(`TARGET: ${target}`))
    assert(section.includes(`BUILD_HOST: ${target}`))
    assert(section.includes(`VARIANT: ${variant}`))
    assert(section.includes('id: variant\n        timeout-minutes: 320'))
    assert(section.includes('--phase build-variant'))
    assert(section.includes('build_args=(--jobs 2)'))
    assert(section.includes('--variant "$VARIANT" "${build_args[@]}"'))
    assert(section.includes('test ! -e "$variant_out"'))
    assert(section.includes('producer-context.json'))
    assert(section.includes('variant_receipt_sha256'))
    assert(
      section.includes(
        `name: source-native-variant-${target}-${variant}-${'${{ github.run_id }}'}-${'${{ github.run_attempt }}'}`,
      ),
    )
    assert(
      section.includes(
        `name: source-native-variant-diagnostics-${target}-${variant}-${'${{ github.run_id }}'}-${'${{ github.run_attempt }}'}`,
      ),
    )
    assert(section.includes(`source-variants/${target}/${variant}/transport`))
    assert(section.includes('id: upload-variant'))
    assert(section.includes('timeout-minutes: 10'))
    assert(section.includes('if-no-files-found: error'))
    assert(section.includes('if: ${{ always() && !cancelled() }}'))
    assert(section.includes('timeout-minutes: 5'))
    assert(!section.includes('--allow-net source-rebuild/verify-native.ts'))
  }

  const facade = jobSection(workflow, 'source-native-linux-x64')
  const needs = [
    'resolve',
    'test',
    'source-materials',
    'source-linux-x64-baseline',
    'source-linux-x64-modified',
  ]
  assert(
    facade.includes(
      "if: ${{ !cancelled() && (needs.resolve.outputs.mode == 'runtime-qualification' || needs.resolve.outputs.linux_validation == 'true') }}",
    ),
  )
  assert(facade.includes('timeout-minutes: 350'))
  assert(facade.includes(`--argjson expected '${JSON.stringify(needs)}'`))
  assert(facade.includes('source-linux-x64-baseline.outputs.artifact_id'))
  assert(facade.includes('source-linux-x64-modified.outputs.artifact_id'))
  assert(facade.includes('source-linux-x64-baseline.outputs.artifact_digest'))
  assert(facade.includes('source-linux-x64-modified.outputs.artifact_digest'))
  assert(facade.includes('source-linux-x64-baseline.outputs.producer_job_id'))
  assert(facade.includes('source-linux-x64-modified.outputs.producer_job_id'))
  assert(facade.includes('test "$BASELINE_JOB_ID" = source-linux-x64-baseline'))
  assert(facade.includes('test "$MODIFIED_JOB_ID" = source-linux-x64-modified'))
  assert(facade.includes('--phase join-build'))
  assert(facade.includes('id: join\n        timeout-minutes: 60'))
  assert(facade.includes('id: proof\n        timeout-minutes: 60'))
  assert(facade.includes('--phase execute'))
  assert(facade.includes('--phase merge'))
  const diagnostics = facade.slice(
    facade.lastIndexOf(
      '      - name: Preserve failed native proof diagnostics separately',
    ),
  )
  assert(diagnostics.includes('if: failure()'))
  assert(diagnostics.includes('timeout-minutes: 5'))
  for (
    const output of [
      'artifact_id',
      'artifact_digest',
      'runtime_artifact_id',
      'runtime_artifact_digest',
      'producer_run_id',
      'producer_attempt',
      'proof_sha256',
      'baseline_runtime_sha256',
      'baseline_derived_lock_sha256',
      'build_receipt_sha256',
    ]
  ) assert(facade.includes(`${output}:`))
  assert(facade.includes(`source-proofs/${target}`))
  assert(facade.includes(`tool-pins/${target}.json`))
  assert(
    facade.includes(
      `name: slv-source-proof-${target}-${'${{ github.run_id }}'}`,
    ),
  )
  assert(
    facade.includes(
      `name: slv-source-runtime-${target}-${'${{ github.run_id }}'}-${'${{ github.run_attempt }}'}`,
    ),
  )

  const prerequisite = stepShell(
    facade,
    'Require every source prerequisite to succeed',
  )
  const valid = Object.fromEntries(
    needs.map((need) => [need, { result: 'success', outputs: { x: '1' } }]),
  )
  assert(
    (await runPrerequisiteShell(prerequisite, JSON.stringify(valid))).success,
  )
  for (
    const invalid of [
      JSON.stringify({ ...valid, extra: { result: 'success' } }),
      JSON.stringify({
        ...valid,
        'source-linux-x64-baseline': { result: 'failure' },
      }),
      JSON.stringify(Object.fromEntries(
        Object.entries(valid).filter(([job]) =>
          job !== 'source-linux-x64-modified'
        ),
      )),
    ]
  ) assert(!(await runPrerequisiteShell(prerequisite, invalid)).success)

  const producerMetadata = stepShell(
    facade,
    'Validate trusted Linux variant producer metadata',
  )
  const producerMetadataEnv = {
    BASELINE_ARTIFACT_ID: '1',
    BASELINE_ARTIFACT_DIGEST: 'a'.repeat(64),
    BASELINE_RECEIPT_SHA256: 'b'.repeat(64),
    BASELINE_REPOSITORY: 'ValidatorsDAO/slv',
    BASELINE_WORKFLOW:
      'ValidatorsDAO/slv/.github/workflows/slv-remote-build.yml@refs/heads/main',
    BASELINE_RUN_ID: '1',
    BASELINE_RUN_ATTEMPT: '1',
    BASELINE_JOB_ID: 'source-linux-x64-baseline',
    MODIFIED_ARTIFACT_ID: '2',
    MODIFIED_ARTIFACT_DIGEST: 'c'.repeat(64),
    MODIFIED_RECEIPT_SHA256: 'd'.repeat(64),
    MODIFIED_REPOSITORY: 'ValidatorsDAO/slv',
    MODIFIED_WORKFLOW:
      'ValidatorsDAO/slv/.github/workflows/slv-remote-build.yml@refs/heads/main',
    MODIFIED_RUN_ID: '2',
    MODIFIED_RUN_ATTEMPT: '1',
    MODIFIED_JOB_ID: 'source-linux-x64-modified',
    CURRENT_ATTEMPT: '1',
  }
  assert(
    (await runDiagnosticGuard(producerMetadata, producerMetadataEnv)).success,
  )
  for (
    const [label, invalid] of [
      ['zero artifact ID', {
        ...producerMetadataEnv,
        BASELINE_ARTIFACT_ID: '0',
      }],
      ['wrong digest', {
        ...producerMetadataEnv,
        MODIFIED_ARTIFACT_DIGEST: 'wrong',
      }],
      ['missing repository', {
        ...producerMetadataEnv,
        BASELINE_REPOSITORY: '',
      }],
      ['future attempt', { ...producerMetadataEnv, MODIFIED_RUN_ATTEMPT: '2' }],
      [
        'wrong job ID',
        {
          ...producerMetadataEnv,
          BASELINE_JOB_ID: 'source-linux-x64-modified',
        },
      ],
    ] as const
  ) {
    assert(
      !(await runDiagnosticGuard(producerMetadata, invalid)).success,
      `accepted invalid producer metadata: ${label}`,
    )
  }

  for (
    const job of ['source-macos-x64-baseline', 'source-macos-x64-modified']
  ) {
    const section = jobSection(workflow, job)
    assert(section.includes('id: variant\n        timeout-minutes: 340'))
    assert(section.includes('--variant "$VARIANT" --jobs 4'))
    assert(section.includes('timeout-minutes: 350'))
  }
  for (const job of ['source-arm-baseline', 'source-arm-modified']) {
    const section = jobSection(workflow, job)
    assert(section.includes('id: variant\n        timeout-minutes: 320'))
    assert(section.includes('build_args=(--jobs 4)'))
  }
})

Deno.test('split producers carry source-owned evidence through existing diagnostic logs', async () => {
  const workflow = await releaseWorkflow()
  const producerSpecs = [
    [
      'source-linux-x64-baseline',
      'x86_64-unknown-linux-gnu',
      'x86_64-unknown-linux-gnu',
      'baseline',
      '2',
    ],
    [
      'source-linux-x64-modified',
      'x86_64-unknown-linux-gnu',
      'x86_64-unknown-linux-gnu',
      'modified',
      '2',
    ],
    [
      'source-arm-baseline',
      'aarch64-unknown-linux-gnu',
      'x86_64-unknown-linux-gnu',
      'baseline',
      '4',
    ],
    [
      'source-arm-modified',
      'aarch64-unknown-linux-gnu',
      'x86_64-unknown-linux-gnu',
      'modified',
      '4',
    ],
    [
      'source-macos-x64-baseline',
      'x86_64-apple-darwin',
      'x86_64-apple-darwin',
      'baseline',
      '4',
    ],
    [
      'source-macos-x64-modified',
      'x86_64-apple-darwin',
      'x86_64-apple-darwin',
      'modified',
      '4',
    ],
  ] as const
  const decoder = new TextDecoder()

  for (const [job, target, buildHost, variant, jobs] of producerSpecs) {
    const section = jobSection(workflow, job)
    const shell = stepShell(section, 'Build cold source variant')
    const preamble = shell.split('\n').find((line) => line.trim())
    if (preamble === undefined) {
      throw new Error(`missing build preamble for ${job}`)
    }
    assertEquals(preamble, 'set -euo pipefail')
    const variantOut = shell.match(/^variant_out=.*$/m)?.[0]
    const common = shell.match(/^common=\(.*\)$/m)?.[0]
    const command = shell.match(
      /^deno run .*source-rebuild\/verify-native\.ts --phase build-variant .*$/m,
    )?.[0]
    assert(variantOut, `missing variant output setup for ${job}`)
    assert(common, `missing common build arguments for ${job}`)
    assert(command, `missing build-variant invocation for ${job}`)
    assertEquals(
      variantOut,
      'variant_out="dist/release-inputs/source-variants/$TARGET/$VARIANT"',
    )
    assertEquals(
      count(command, '--evidence-out'),
      1,
      `expected one source evidence destination for ${job}`,
    )
    assert(
      command.includes(
        '--evidence-out "$RUNNER_TEMP/source-logs/source-evidence-$VARIANT"',
      ),
    )
    assert(
      command.endsWith(
        '2>&1 | tee "$RUNNER_TEMP/source-logs/build-$VARIANT.log"',
      ),
    )
    assertEquals(count(section, 'source-evidence-$VARIANT'), 1)
    assertEquals(
      count(
        section,
        'uses: actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02',
      ),
      2,
    )
    const diagnostic = section.slice(
      section.lastIndexOf('      - name: Preserve'),
    )
    assert(diagnostic.includes('if: ${{ always() && !cancelled() }}'))
    assert(diagnostic.includes('timeout-minutes: 5'))
    assert(diagnostic.includes('path: ${{ runner.temp }}/source-logs'))
    assert(diagnostic.includes('if-no-files-found: warn'))
    assert(diagnostic.includes('retention-days: 7'))

    const profileSetup = shell.match(/^build_args=\(.*?^esac$/ms)?.[0] ?? ''
    const expectedArguments = (runnerTemp: string, profile: string) => [
      'run',
      '--frozen',
      '--allow-read',
      '--allow-write',
      '--allow-run',
      '--allow-env',
      'source-rebuild/verify-native.ts',
      '--phase',
      'build-variant',
      '--target',
      target,
      '--build-host',
      buildHost,
      '--out',
      `dist/release-inputs/source-variants/${target}/${variant}`,
      '--pins',
      'source-materials/pins.json',
      '--source-receipt',
      'dist/release-inputs/source-materials-receipt.json',
      '--slv-source',
      'dist/release-inputs/source-materials/slv-source.tar.gz',
      '--deno-source',
      'dist/release-inputs/source-materials/deno-source.tar.gz',
      '--cargo-vendor',
      'dist/release-inputs/source-materials/deno-cargo-vendor.tar.gz',
      '--notice-file',
      'dist/release-inputs/THIRD_PARTY_NOTICES',
      '--variant',
      variant,
      ...(profile === 'linux-16' ? ['--build-profile', 'linux-16'] : []),
      '--jobs',
      profile === 'linux-16' ? '16' : jobs,
      '--source-root',
      `${runnerTemp}/build-source-root`,
      '--work-dir',
      `${runnerTemp}/build-work`,
      '--tools-receipt',
      `${runnerTemp}/build-tools.json`,
      '--producer-context',
      `${runnerTemp}/producer-context.json`,
      '--evidence-out',
      `${runnerTemp}/source-logs/source-evidence-${variant}`,
    ]
    const executeCarrier = async (
      commandPreamble: string,
      exitCode: number,
      label: string,
      profile = '',
    ) => {
      const directory = await Deno.makeTempDir({
        prefix: 'slv evidence carrier ',
      })
      try {
        const runnerTemp = `${directory}/runner temp`
        const bin = `${directory}/bin`
        const argvPath = `${directory}/argv capture`
        await Deno.mkdir(`${runnerTemp}/source-logs`, { recursive: true })
        await Deno.mkdir(bin)
        await Deno.writeTextFile(
          `${bin}/deno`,
          '#!/bin/bash\nset -eu\nprintf \'%s\\0\' "$@" > "$ARGV_CAPTURE"\nprintf \'carrier stdout:%s\\n\' "$CARRIER_LABEL"\nprintf \'carrier stderr:%s\\n\' "$CARRIER_LABEL" >&2\nexit "$CARRIER_EXIT"\n',
        )
        await Deno.chmod(`${bin}/deno`, 0o755)
        const result = await new Deno.Command('bash', {
          args: [
            '-ceu',
            `${commandPreamble}\n${variantOut}\n${common}\n${profileSetup}\n${command}`,
          ],
          cwd: directory,
          clearEnv: true,
          env: {
            PATH: `${bin}:${Deno.env.get('PATH') ?? ''}`,
            RUNNER_TEMP: runnerTemp,
            TARGET: target,
            BUILD_HOST: buildHost,
            VARIANT: variant,
            ARGV_CAPTURE: argvPath,
            CARRIER_LABEL: label,
            LINUX_BUILD_PROFILE: profile,
            CARRIER_EXIT: String(exitCode),
          },
          stdout: 'piped',
          stderr: 'piped',
        }).output()
        return {
          code: result.code,
          stdout: decoder.decode(result.stdout),
          stderr: decoder.decode(result.stderr),
          log: await Deno.readTextFile(
            `${runnerTemp}/source-logs/build-${variant}.log`,
          ),
          argv: (await Deno.readTextFile(argvPath)).split('\0').slice(0, -1),
          expectedArguments: expectedArguments(runnerTemp, profile),
        }
      } finally {
        await Deno.remove(directory, { recursive: true })
      }
    }

    if (target.endsWith('linux-gnu')) {
      const accelerated = await executeCarrier(preamble, 0, job, 'linux-16')
      assertEquals(accelerated.code, 0)
      assertEquals(accelerated.argv, accelerated.expectedArguments)
    }

    for (const exitCode of [0, 17]) {
      const label = `${job}:${exitCode}`
      const observed = await executeCarrier(preamble, exitCode, label)
      assertEquals(observed.code, exitCode, `pipeline exit for ${label}`)
      const expectedOutput =
        `carrier stdout:${label}\ncarrier stderr:${label}\n`
      assertEquals(observed.stdout, expectedOutput)
      assertEquals(observed.stderr, '')
      assertEquals(observed.log, expectedOutput)
      assertEquals(observed.argv, observed.expectedArguments)
    }

    if (job === 'source-arm-baseline') {
      const missingPipefail = preamble.replace(' pipefail', '')
      assertEquals(missingPipefail, 'set -euo')
      const label = `${job}:pipefail-removed`
      const observed = await executeCarrier(missingPipefail, 17, label)
      assertEquals(
        observed.code,
        0,
        'removing only real pipefail masks exit 17',
      )
      const expectedOutput =
        `carrier stdout:${label}\ncarrier stderr:${label}\n`
      assert(observed.stdout.includes(expectedOutput))
      assertEquals(observed.stderr, '')
      assertEquals(observed.log, expectedOutput)
      assertEquals(observed.argv, observed.expectedArguments)
    }
  }
})

Deno.test('workflow isolates and bounds the fixed ARM native diagnostic operation', async () => {
  const workflow = await releaseWorkflow()
  const jobNames = [
    ...workflow.slice(workflow.indexOf('\njobs:\n')).matchAll(
      /^  ([a-z][a-z0-9_-]*):\n/gm,
    ),
  ].map((match) => match[1])
  assertEquals(jobNames.length, 30)
  for (const job of jobNames) {
    if (job === 'source-native-diagnostic') continue
    const expression = jobIf(jobSection(workflow, job))!.replace(
      /^\$\{\{ | \}\}$/g,
      '',
    )
    const rejected = productExpression(expression, productNeedsFixture(false), {
      operation: 'source-native-diagnostic',
    })
    assertEquals(rejected, false, job)
  }

  const diagnostic = jobSection(workflow, 'source-native-diagnostic')
  assertEquals(
    jobIf(diagnostic),
    "github.event_name == 'workflow_dispatch' && inputs.operation == 'source-native-diagnostic'",
  )
  assert(!/^    needs:/m.test(diagnostic))
  assert(diagnostic.includes('runs-on: ubuntu-26.04-arm'))
  assert(diagnostic.includes('timeout-minutes: 25'))
  const permissions = diagnostic.slice(
    diagnostic.indexOf('    permissions:'),
    diagnostic.indexOf('    steps:'),
  )
  assertEquals(
    permissions.trim(),
    'permissions:\n      contents: read\n      actions: read',
  )
  assertEquals(count(workflow, 'actions: read'), 3)
  assert(!diagnostic.includes('environment:'))
  assert(!diagnostic.includes('secrets.'))
  assert(!diagnostic.includes('outputs:'))
  assert(!diagnostic.includes('native-proof.json'))
  assert(!diagnostic.includes('release.ts'))

  const guardName =
    'Require the reviewed diagnostic revision before any acquisition'
  const firstStep = diagnostic.indexOf('      - ')
  assert(
    diagnostic.slice(firstStep).startsWith(`      - name: ${guardName}\n`),
  )
  const guard = stepShell(diagnostic, guardName)
  assert(guard.includes('set -euo pipefail'))
  for (
    const name of [
      'EXPECTED_REVIEWED_SHA',
      'ACTUAL_SHA',
      'WORKFLOW_SHA',
      'REPOSITORY',
      'EVENT_NAME',
      'OPERATION',
      'REF',
      'WORKFLOW_REF',
    ]
  ) assert(diagnostic.includes(name + ': ${{'))
  assert(guard.includes('[[ "$EXPECTED_REVIEWED_SHA" =~ ^[a-f0-9]{40}$ ]]'))
  assert(guard.includes('test "$ACTUAL_SHA" = "$EXPECTED_REVIEWED_SHA"'))
  assert(guard.includes('test "$WORKFLOW_SHA" = "$EXPECTED_REVIEWED_SHA"'))
  assert(guard.includes('test "$REPOSITORY" = ValidatorsDAO/slv'))
  assert(guard.includes('test "$EVENT_NAME" = workflow_dispatch'))
  assert(guard.includes('test "$OPERATION" = source-native-diagnostic'))
  assert(
    guard.includes('test "$REF" = refs/heads/codex/slv-eu-oss-delivery'),
  )
  assert(
    guard.includes(
      'test "$WORKFLOW_REF" = ValidatorsDAO/slv/.github/workflows/slv-remote-build.yml@refs/heads/codex/slv-eu-oss-delivery',
    ),
  )

  const reviewedSha = 'a'.repeat(40)
  const validGuardEnv = {
    EXPECTED_REVIEWED_SHA: reviewedSha,
    ACTUAL_SHA: reviewedSha,
    WORKFLOW_SHA: reviewedSha,
    REPOSITORY: 'ValidatorsDAO/slv',
    EVENT_NAME: 'workflow_dispatch',
    OPERATION: 'source-native-diagnostic',
    REF: 'refs/heads/codex/slv-eu-oss-delivery',
    WORKFLOW_REF:
      'ValidatorsDAO/slv/.github/workflows/slv-remote-build.yml@refs/heads/codex/slv-eu-oss-delivery',
  }
  assert((await runDiagnosticGuard(guard, validGuardEnv)).success)
  const missingSha: Record<string, string> = { ...validGuardEnv }
  delete missingSha.EXPECTED_REVIEWED_SHA
  for (
    const control of [
      missingSha,
      { ...validGuardEnv, EXPECTED_REVIEWED_SHA: '' },
      { ...validGuardEnv, EXPECTED_REVIEWED_SHA: 'A'.repeat(40) },
      { ...validGuardEnv, EXPECTED_REVIEWED_SHA: 'a'.repeat(39) },
      { ...validGuardEnv, ACTUAL_SHA: 'b'.repeat(40) },
      { ...validGuardEnv, WORKFLOW_SHA: 'c'.repeat(40) },
      { ...validGuardEnv, REPOSITORY: 'ValidatorsDAO/not-slv' },
      { ...validGuardEnv, EVENT_NAME: 'push' },
      { ...validGuardEnv, OPERATION: 'release' },
      { ...validGuardEnv, REF: 'refs/heads/main' },
      { ...validGuardEnv, WORKFLOW_REF: 'ValidatorsDAO/slv/other' },
    ]
  ) assert(!(await runDiagnosticGuard(guard, control)).success)
  const canaryDirectory = await Deno.makeTempDir({
    prefix: 'slv-diagnostic-guard-',
  })
  const canary = `${canaryDirectory}/unexpected-shell-expansion`
  assert(
    !(await runDiagnosticGuard(guard, {
      ...validGuardEnv,
      EXPECTED_REVIEWED_SHA: `${reviewedSha}; touch ${canary}`,
    })).success,
  )
  assertEquals(
    await Deno.stat(canary).then(() => true).catch(() => false),
    false,
  )
  await Deno.remove(canaryDirectory, { recursive: true })

  const checkout = diagnostic.indexOf(
    'actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683',
  )
  const contextName = 'Bind the diagnostic context to the checked-out revision'
  const context = stepShell(diagnostic, contextName)
  const download = diagnostic.indexOf(
    'Download the fixed ARM diagnostic artifact',
  )
  assert(checkout > diagnostic.indexOf(guardName))
  assert(diagnostic.includes('ref: ${{ github.sha }}'))
  assert(diagnostic.includes('fetch-depth: 1'))
  assert(diagnostic.includes('persist-credentials: false'))
  assert(
    diagnostic.includes(
      'denoland/setup-deno@01524fade784327df1a5ad1ead94235d392cd443',
    ),
  )
  assert(diagnostic.includes('deno-version: v2.9.3'))
  assert(diagnostic.indexOf(contextName) > checkout)
  assert(download > diagnostic.indexOf(contextName))
  assert(context.includes('actual_head="$(git rev-parse HEAD)"'))
  assert(context.includes('test "$actual_head" = "$REVIEWED_SHA"'))
  assert(context.includes('test "$ACTUAL_SHA" = "$REVIEWED_SHA"'))
  assert(context.includes('test "$WORKFLOW_SHA" = "$REVIEWED_SHA"'))
  assert(context.includes('[[ "$RUN_ID" =~ ^[1-9][0-9]*$ ]]'))
  assert(context.includes('[[ "$RUN_ATTEMPT" =~ ^[1-9][0-9]*$ ]]'))
  assert(
    context.includes(
      'mkdir "$RUNNER_TEMP/arm-diagnostic-input" "$RUNNER_TEMP/arm-diagnostic-output" "$RUNNER_TEMP/arm-diagnostic-acquisition" "$RUNNER_TEMP/arm-diagnostic-acquisition-work"',
    ),
  )
  for (
    const key of [
      'schema_version: 1',
      'kind: "slv-native-diagnostic-context"',
      'repository: $repository',
      'workflow_ref: $workflow_ref',
      'workflow_sha: $workflow_sha',
      'diagnostic_source_commit: $diagnostic_source_commit',
      'run_id: $run_id',
      'run_attempt: $run_attempt',
    ]
  ) assert(context.includes(key))
  assert(diagnostic.includes('timeout-minutes: 5'))
  assert(diagnostic.includes('repository: ValidatorsDAO/slv'))
  assert(diagnostic.includes('run-id: 38628703267'))
  assert(diagnostic.includes('artifact-ids: 11935008486'))
  assert(diagnostic.includes('github-token: ${{ github.token }}'))
  assert(diagnostic.includes('merge-multiple: true'))
  assert(diagnostic.includes('path: ${{ runner.temp }}/arm-diagnostic-input'))
  const downloadStep = diagnostic.slice(
    download,
    diagnostic.indexOf(
      '      - name: Acquire existing or frozen official Ubuntu gdb',
    ),
  )
  assert(!downloadStep.includes('name:'))
  assert(!downloadStep.includes('pattern:'))
  assert(!downloadStep.includes('latest:'))

  const helper = stepShell(diagnostic, 'Run bounded ARM native diagnostic')
  assert(diagnostic.includes('id: run_native_diagnostic'))
  assert(
    diagnostic.includes(
      "if: steps.acquire-debugger.outputs.runtime_unchanged == 'true'",
    ),
  )
  assert(diagnostic.includes('timeout-minutes: 13'))
  assert(
    helper.includes(
      'deno run --frozen --allow-read --allow-write --allow-run --allow-env source-rebuild/diagnose-native.ts --artifact-root "$RUNNER_TEMP/arm-diagnostic-input" --out "$RUNNER_TEMP/arm-diagnostic-output" --diagnostic-context "$RUNNER_TEMP/arm-diagnostic-context.json" --reviewed-sha "$REVIEWED_SHA"',
    ),
  )
  assert(!helper.includes('--allow-net'))
  assert(!helper.includes('continue-on-error'))
  assert(!helper.includes('|| true'))
  assert(!helper.includes('set +e'))
  const fakeToolDirectory = await Deno.makeTempDir({
    prefix: 'slv-diagnostic-helper-',
  })
  const fakeDeno = `${fakeToolDirectory}/deno`
  await Deno.writeTextFile(fakeDeno, '#!/bin/sh\nexit 73\n')
  await Deno.chmod(fakeDeno, 0o755)
  const helperFailure = await new Deno.Command('bash', {
    args: ['-ceu', helper],
    clearEnv: true,
    env: {
      PATH: `${fakeToolDirectory}:${Deno.env.get('PATH') ?? ''}`,
      RUNNER_TEMP: fakeToolDirectory,
      REVIEWED_SHA: reviewedSha,
    },
    stdout: 'piped',
    stderr: 'piped',
  }).output()
  assert(!helperFailure.success)
  assertEquals(helperFailure.code, 73)
  await Deno.remove(fakeToolDirectory, { recursive: true })

  const upload = diagnostic.slice(
    diagnostic.indexOf('Persist bounded ARM diagnostic evidence'),
  )
  assert(upload.includes('if: ${{ always() && !cancelled() }}'))
  assert(upload.includes('timeout-minutes: 3'))
  assert(
    upload.includes(
      'name: slv-arm-runtime-diagnostics-${{ github.run_id }}-${{ github.run_attempt }}',
    ),
  )
  assert(upload.includes('path: |'))
  assert(upload.includes('${{ runner.temp }}/arm-diagnostic-output'))
  assert(upload.includes('${{ runner.temp }}/arm-diagnostic-acquisition'))
  assert(upload.includes('if-no-files-found: warn'))
  assert(upload.includes('retention-days: 7'))
  assert(!upload.includes('arm-diagnostic-input'))
  assert(!upload.includes('arm-diagnostic-acquisition-work'))
})

Deno.test('bounded GDB acquisition uses the extracted frozen controller and fails closed', async () => {
  const workflow = await releaseWorkflow()
  const diagnostic = jobSection(workflow, 'source-native-diagnostic')
  const acquisition = stepShell(
    diagnostic,
    'Acquire existing or frozen official Ubuntu gdb',
  )
  const controller = acquisitionController(workflow)
  assert(diagnostic.includes('id: acquire-debugger'))
  assert(diagnostic.includes('timeout-minutes: 3'))
  assert(
    acquisition.indexOf('validateStoredArtifact') <
      acquisition.indexOf('python3 -'),
  )
  assert(acquisition.includes('deno run --frozen --allow-read'))
  assert(acquisition.includes('source-rebuild/diagnose-native.ts'))
  assert(!acquisition.includes('arm-diagnostic-output'))
  assert(controller.includes("INTERPRETER = '/lib/ld-linux-aarch64.so.1'"))
  assert(controller.includes("['/usr/bin/readelf', '-l'"))
  assert(controller.includes("[interpreter, '--list', program['path']]"))
  assert(!controller.includes('ldd'))
  assert(controller.includes("['sudo', '-n', *wrapped]"))
  assert(controller.includes("['/usr/bin/dpkg', '--install', '--', *debs]"))
  assert(
    controller.includes(
      "'--simulate', '--no-install-recommends', '--no-upgrade', '--no-remove', 'install', 'gdb'",
    ),
  )
  assert(
    controller.includes(
      "'--download-only', '--yes', '--no-install-recommends', '--no-upgrade', '--no-remove'",
    ),
  )
  assert(!controller.includes('dist-upgrade'))
  assert(!controller.includes('autoremove'))
  assert(!controller.includes('apt-key'))
  assert(!controller.includes('curl'))
  assert(!controller.includes('sysctl'))
  assert(controller.includes('AUDIT_RESERVE_SECONDS = 20'))
  assert(controller.includes('AUTHORITATIVE_OUTPUT_LIMIT = 512 * 1024'))
  assert(
    controller.includes(
      "FINAL_AUDIT_PHASES = frozenset({'postimage-audit', 'postimage-keyring'})",
    ),
  )
  assert(controller.includes("destination = self.work / 'selected.list'"))
  assert(!controller.includes('selected.sources'))
  assert(controller.includes("'/usr/bin/timeout', '--kill-after=2s'"))
  assert(controller.includes('selector = selectors.DefaultSelector()'))
  assert(controller.includes('block = os.read(descriptor, 8192)'))
  assert(!controller.includes('threading.Thread'))
  assert(!controller.includes('stream.close()'))
  assert(
    controller.indexOf("second = self.require(['/usr/bin/apt-get'") <
      controller.indexOf("installed = self.run(['/usr/bin/dpkg'"),
  )
  assert(
    controller.indexOf("preinstall = self.measure('preinstall-audit')") <
        controller.lastIndexOf('debs = self.inspect_debs(metadata)') &&
      controller.lastIndexOf('debs = self.inspect_debs(metadata)') <
        controller.indexOf("installed = self.run(['/usr/bin/dpkg'"),
  )
  assert(controller.includes('if not set(additions).issubset(planned)'))
  assert(
    controller.includes(
      "additions[key].get('version') != planned[key]['version']",
    ),
  )
  assert(
    controller.includes(
      "additions[key].get('architecture') != planned[key]['architecture']",
    ),
  )
  assert(controller.includes('def plan_is_installed(self, postimage):'))
  assert(
    diagnostic.includes(
      "if: steps.acquire-debugger.outputs.runtime_unchanged == 'true'",
    ),
  )
  assert(
    diagnostic.includes('Finalize bounded ARM acquisition evidence'),
  )
  const finalizer = stepShell(
    diagnostic,
    'Finalize bounded ARM acquisition evidence',
  )
  assert(
    diagnostic.includes(
      'Finalize bounded ARM acquisition evidence\n        if: ${{ always() && !cancelled() }}\n        timeout-minutes: 1',
    ),
  )
  assert(finalizer.includes('ACQUISITION_OUTCOME'))
  assert(finalizer.includes('HELPER_OUTCOME'))
  assert(!finalizer.includes('arm-diagnostic-output'))

  const harness = String.raw`
import importlib.util
import json
import os
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from types import SimpleNamespace

spec = importlib.util.spec_from_file_location('bounded_controller', sys.argv[1])
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)
root = Path(sys.argv[2])

def controller():
    item = object.__new__(module.Controller)
    item.failure_stage = None
    item.acquisition_reason = None
    item.audit_error = None
    item.image_codename = None
    return item

def expect_reject(action):
    try:
        action()
    except module.AcquisitionError:
        return
    raise AssertionError('expected extracted controller rejection')

inventory_text = (
    'base:arm64\tarm64\t1\tii \n'
    'held:arm64\tarm64\t2\thi \n'
    'obsolete:arm64\tarm64\t3\trc \n'
)
packages = controller()
packages.require = lambda *args, **kwargs: SimpleNamespace(stdout=inventory_text.encode())
inventory = module.Controller.package_inventory(packages, 'fixture')
assert set(inventory['installed']) == {'base:arm64', 'held:arm64'}
assert set(inventory['residual']) == {'obsolete:arm64'}
broken = controller()
broken.require = lambda *args, **kwargs: SimpleNamespace(stdout=b'base:arm64\tarm64\t1\tiU \n')
expect_reject(lambda: module.Controller.package_inventory(broken, 'fixture'))

def runnable(label):
    item = controller()
    item.evidence = module.Retention(root / label)
    item.deadline = time.monotonic() + 20
    item.child_env = {**module.SAFE_ENV}
    item.commands = []
    return item

large_runner = runnable('large-authority')
large_result = module.Controller.run(
    large_runner,
    ['/usr/bin/python3', '-c', "import sys; [sys.stdout.write(f'pkg{n}:arm64\\tarm64\\t1\\tii \\n') for n in range(6000)]"],
    'postimage-audit',
    5,
)
assert large_result.stdout_bytes > module.COMMAND_LOG_LIMIT
assert large_result.stdout_complete and large_result.capture_complete
large_packages = controller()
large_packages.require = lambda *args, **kwargs: large_result
assert len(module.Controller.package_inventory(large_packages, 'fixture')['installed']) == 6000
complete_line = large_result.stdout.rsplit(b'\n', 2)[0] + b'\n'
truncated = module.Result(
    0, False, complete_line, b'', large_result.stdout_bytes,
    0, False, True, True,
)
truncated_packages = controller()
truncated_packages.require = lambda *args, **kwargs: truncated
expect_reject(lambda: module.Controller.package_inventory(truncated_packages, 'fixture'))

solver = '\n'.join([
    'Inst libextra (1.0 Ubuntu:24.04/noble [arm64])',
    'Inst gdb (15.0 Ubuntu:24.04/noble [arm64])',
    'Conf libextra (1.0 Ubuntu:24.04/noble [arm64])',
    'Conf gdb (15.0 Ubuntu:24.04/noble [arm64])',
    '0 upgraded, 2 newly installed, 0 to remove and 0 not upgraded.',
])
solver_controller = controller()
plan = module.Controller.parse_solver(solver_controller, solver, inventory['installed'])
assert [item['package'] for item in plan] == ['gdb:arm64', 'libextra:arm64']
expect_reject(lambda: module.Controller.parse_solver(solver_controller, solver.replace('Inst libextra', 'Inst base:arm64 [1]'), inventory['installed']))
expect_reject(lambda: module.Controller.parse_solver(solver_controller, solver + '\nRemv base:arm64', inventory['installed']))
expect_reject(lambda: module.Controller.parse_solver(solver_controller, solver.replace('Conf gdb', 'Conf base:arm64'), inventory['installed']))
expect_reject(lambda: module.Controller.parse_solver(solver_controller, solver.replace('0 upgraded, 2 newly installed, 0 to remove and 0 not upgraded.', '1 upgraded, 2 newly installed, 0 to remove and 0 not upgraded.'), inventory['installed']))

metadata = (
    'Package: gdb\nVersion: 15.0\nArchitecture: arm64\n'
    'Filename: pool/main/g/gdb/gdb.deb\nSize: 3\n'
    'SHA256: ' + 'a' * 64 + '\n'
)
metadata_controller = controller()
metadata_controller.require = lambda *args, **kwargs: SimpleNamespace(stdout=metadata.encode())
gdb_plan = [item for item in plan if item['package'] == 'gdb:arm64']
frozen = module.Controller.metadata_for_plan(metadata_controller, [], gdb_plan)
assert frozen[0]['filename'] == 'pool/main/g/gdb/gdb.deb'
metadata_controller.require = lambda *args, **kwargs: SimpleNamespace(stdout=(metadata + '\n' + metadata).encode())
expect_reject(lambda: module.Controller.metadata_for_plan(metadata_controller, [], gdb_plan))

uri_controller = controller()
uri_controller.source_records = [{'uri': 'http://ports.ubuntu.com/ubuntu-ports', 'suite': 'noble', 'components': ['main'], 'architectures': 'arm64'}]
uris = module.Controller.parse_print_uris(uri_controller, "'http://ports.ubuntu.com/ubuntu-ports/pool/main/g/gdb/gdb.deb' gdb.deb 3 SHA256:ignored", frozen)
assert uris['gdb.deb']['size'] == 3
expect_reject(lambda: module.Controller.parse_print_uris(uri_controller, "'https://example.invalid/gdb.deb' gdb.deb 3 SHA256:ignored", frozen))

with tempfile.TemporaryDirectory(dir=root) as temporary:
    source_writer = controller()
    source_writer.work = Path(temporary)
    source_writer.keyring_identity = lambda *args, **kwargs: {'path': module.KEYRING, 'sha256': 'a' * 64, 'size': 1, 'owner': 'ubuntu-keyring:arm64', 'owner_tuple': {}}
    source_file = module.Controller.write_private_sources(source_writer, uri_controller.source_records, inventory)
    assert source_file.name == 'selected.list'
    assert source_file.read_text().startswith('deb [signed-by=')
    parser = subprocess.run(
        ['/usr/bin/apt-cache', '-o', f'Dir::Etc::sourcelist={source_file}', '-o', 'Dir::Etc::sourceparts=-', 'policy'],
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        env=module.SAFE_ENV,
        timeout=5,
    )
    assert parser.returncode == 0, parser.stderr.decode('utf-8', 'replace')

with tempfile.TemporaryDirectory(dir=root) as temporary:
    work = Path(temporary)
    archives = work / 'archives'
    archives.mkdir()
    deb = archives / 'gdb.deb'
    deb.write_bytes(b'abc')
    deb_metadata = [{**frozen[0], 'filename': 'pool/main/g/gdb/gdb.deb', 'size': 3, 'sha256': module.sha_file(deb)}]
    deb_controller = controller()
    deb_controller.work = work
    deb_controller.require = lambda *args, **kwargs: SimpleNamespace(stdout=b'Package: gdb\nVersion: 15.0\nArchitecture: arm64\n')
    assert module.Controller.inspect_debs(deb_controller, deb_metadata) == [str(deb.resolve())]
    (archives / 'unexpected.deb').write_bytes(b'x')
    expect_reject(lambda: module.Controller.inspect_debs(deb_controller, deb_metadata))
    (archives / 'unexpected.deb').unlink()
    deb.write_bytes(b'changed')
    expect_reject(lambda: module.Controller.inspect_debs(deb_controller, deb_metadata))

preimage = {'packages': inventory, 'runtime': {'runtime': 'stable'}, 'runtime_sha256': 'runtime'}
comparison = controller()
assert module.Controller.compare_postimage(comparison, preimage, preimage, [])
changed_residual = json.loads(json.dumps(preimage))
changed_residual['packages']['residual']['obsolete:arm64']['version'] = '4'
assert not module.Controller.compare_postimage(comparison, preimage, changed_residual, [])
changed_package = json.loads(json.dumps(preimage))
changed_package['packages']['installed']['base:arm64']['version'] = '2'
assert not module.Controller.compare_postimage(comparison, preimage, changed_package, [])
changed_runtime = json.loads(json.dumps(preimage))
changed_runtime['runtime'] = {'runtime': 'drift'}
assert not module.Controller.compare_postimage(comparison, preimage, changed_runtime, [])
planned_gdb = {'package': 'gdb:arm64', 'version': '15.0', 'architecture': 'arm64'}
planned_extra = {'package': 'libextra:arm64', 'version': '1.0', 'architecture': 'arm64'}
assert module.Controller.compare_postimage(comparison, preimage, preimage, [planned_gdb, planned_extra])
post_with_gdb = json.loads(json.dumps(preimage))
post_with_gdb['packages']['installed']['gdb:arm64'] = {'package': 'gdb:arm64', 'architecture': 'arm64', 'version': '15.0', 'status': 'ii '}
assert module.Controller.compare_postimage(comparison, preimage, post_with_gdb, [planned_gdb, planned_extra])
wrong_version_post = json.loads(json.dumps(post_with_gdb))
wrong_version_post['packages']['installed']['gdb:arm64']['version'] = '99.0'
assert not module.Controller.compare_postimage(comparison, preimage, wrong_version_post, [planned_gdb, planned_extra])
wrong_architecture_post = json.loads(json.dumps(post_with_gdb))
wrong_architecture_post['packages']['installed']['gdb:arm64']['architecture'] = 'amd64'
assert not module.Controller.compare_postimage(comparison, preimage, wrong_architecture_post, [planned_gdb, planned_extra])
wrong_both_post = json.loads(json.dumps(wrong_version_post))
wrong_both_post['packages']['installed']['gdb:arm64']['architecture'] = 'amd64'
assert not module.Controller.compare_postimage(comparison, preimage, wrong_both_post, [planned_gdb, planned_extra])
dirty_addition_post = json.loads(json.dumps(post_with_gdb))
dirty_addition_post['packages']['installed']['gdb:arm64']['status'] = 'iU '
assert not module.Controller.compare_postimage(comparison, preimage, dirty_addition_post, [planned_gdb, planned_extra])
comparison.plan = [planned_gdb, planned_extra]
assert not module.Controller.plan_is_installed(comparison, post_with_gdb)
partial_post = json.loads(json.dumps(post_with_gdb))
post_with_gdb['packages']['installed']['unplanned:arm64'] = {'package': 'unplanned:arm64', 'architecture': 'arm64', 'version': '1', 'status': 'ii '}
assert not module.Controller.compare_postimage(comparison, preimage, post_with_gdb, [planned_gdb, planned_extra])

with tempfile.TemporaryDirectory(dir=root) as temporary:
    mutation_work = Path(temporary)
    mutation_archives = mutation_work / 'archives'
    mutation_archives.mkdir()
    mutation_deb = mutation_archives / 'gdb.deb'
    mutation_deb.write_bytes(b'abc')
    mutation_metadata = [{
        'package': 'gdb:arm64', 'version': '15.0', 'architecture': 'arm64',
        'filename': 'pool/main/g/gdb/gdb.deb', 'size': 3,
        'sha256': module.sha_file(mutation_deb),
    }]
    mutation = controller()
    mutation.evidence = module.Retention(mutation_work / 'evidence')
    mutation.work = mutation_work
    mutation.preimage = None
    mutation.plan = []
    mutation.source_records = []
    mutation.keyring = None
    mutation.post_sources = None
    mutation.post_keyring = None
    mutation.status = 'initializing'
    mutation.reason = None
    mutation.gdb = None
    mutation.image_identity = lambda: {'image': 'ubuntu'}
    def mutation_measure(phase):
        if phase == 'preinstall-audit':
            mutation_deb.write_bytes(b'XYZ')
        return preimage
    mutation.measure = mutation_measure
    mutation.trusted_gdb = lambda: None
    mutation.select_sources = lambda: [{'uri': 'http://ports.ubuntu.com/ubuntu-ports', 'suite': 'noble', 'components': ['main'], 'architectures': 'arm64'}]
    mutation.write_private_sources = lambda *args: mutation_work / 'selected.list'
    mutation.apt_options = lambda *args: []
    mutation.parse_solver = lambda *args: [planned_gdb]
    mutation.metadata_for_plan = lambda *args: mutation_metadata
    mutation.parse_print_uris = lambda *args: {}
    def mutation_require(command, *args, **kwargs):
        if command[0] == '/usr/bin/dpkg-deb':
            return SimpleNamespace(stdout=b'Package: gdb\nVersion: 15.0\nArchitecture: arm64\n')
        return SimpleNamespace(stdout=b'')
    mutation.require = mutation_require
    mutation.run = lambda *args, **kwargs: (_ for _ in ()).throw(AssertionError('mutated frozen deb reached dpkg install'))
    expect_reject(lambda: module.Controller.execute(mutation))

SENTINEL = 'SOURCE-CREDENTIAL-SENTINEL-DO-NOT-RETAIN'
official_source = {'uri': 'http://ports.ubuntu.com/ubuntu-ports', 'suite': 'resolute', 'components': ['main'], 'architectures': 'arm64'}

def acquisition_fixture(label, postimage=preimage):
    item = controller()
    item.evidence = module.Retention(root / (label + '-evidence'))
    item.github_output = root / (label + '-output')
    item.work = root / (label + '-work')
    item.work.mkdir()
    item.commands = []
    item.phase = 'initializing'
    item.plan = []
    item.source_records = []
    item.keyring = None
    item.post_sources = None
    item.post_keyring = None
    item.preimage = None
    item.postimage = None
    item.status = 'initializing'
    item.gdb = None
    item.image_identity = lambda: {'os_release': {'VERSION_CODENAME': 'resolute'}}
    item.measure = lambda phase: preimage if phase == 'preimage' else postimage
    item.trusted_gdb = lambda: None
    item.require = lambda *args, **kwargs: (_ for _ in ()).throw(AssertionError('unexpected package operation'))
    return item

def decline_at(label, expected_stage, configure, postimage=preimage):
    item = acquisition_fixture(label, postimage)
    calls = []
    configure(item, calls)
    try:
        module.Controller.execute(item)
    except Exception as error:
        item.capture_acquisition_failure(error)
        if not isinstance(error, module.UnsafePostimage):
            item.status = 'acquisition-declined-or-incomplete'
    else:
        raise AssertionError('controlled acquisition failure did not occur')
    expected_exit = 0 if postimage == preimage else 1
    assert module.Controller.finish(item) == expected_exit
    summary = json.loads((item.evidence.directory / 'acquisition-summary.json').read_text())
    assert summary['failure_stage'] == expected_stage
    assert summary['stage'] == expected_stage
    assert summary['acquisition_reason'] is not None
    assert len(module.canonical(summary['acquisition_reason']).encode('utf-8')) <= module.ACQUISITION_REASON_LIMIT
    assert SENTINEL not in module.canonical(summary)
    assert summary['controls_not_run'] == (None if postimage == preimage else 'unsafe-or-unknown-postimage')
    assert summary['runtime_unchanged'] is (postimage == preimage)
    return item, summary, calls

source_item, source_summary, source_calls = decline_at(
    'declined-source',
    'select-sources',
    lambda item, calls: setattr(item, 'select_sources', lambda *args, **kwargs: (_ for _ in ()).throw(OSError(71, SENTINEL))),
)
assert source_calls == []
assert source_summary['acquisition_reason'] == {
    'code': 'operation-failed', 'message': 'operation failed; details redacted',
    'error_type': 'OSError', 'errno': 71,
}

with tempfile.TemporaryDirectory(dir=root) as temporary:
    apt = Path(temporary) / 'apt'
    parts = apt / 'sources.list.d'
    parts.mkdir(parents=True)
    (apt / 'sources.list').write_text(f'deb https://{SENTINEL}.invalid/ubuntu resolute main\n')
    (parts / 'disabled.sources').write_text('Types: deb\nEnabled: no\nURIs: http://ports.ubuntu.com/ubuntu-ports\nSuites: resolute\nComponents: main\n')
    terminal_item, terminal_summary, terminal_calls = decline_at(
        'declined-no-supported-source',
        'select-sources',
        lambda item, calls: setattr(item, 'select_sources', lambda *args, **kwargs: module.Controller.select_sources(item, apt)),
    )
    assert terminal_calls == []
    assert terminal_summary['acquisition_reason']['code'] == 'no-supported-source'
    terminal_payload = (terminal_item.evidence.directory / 'source-selection.json').read_bytes()
    assert SENTINEL not in terminal_payload.decode('utf-8')
    assert {detail['code'] for detail in json.loads(terminal_payload)['details']} == {'nonofficial-or-malformed-uri', 'disabled'}

def keyring_failure(item, calls):
    item.select_sources = lambda *args, **kwargs: [official_source]
    item.keyring_identity = lambda *args, **kwargs: (_ for _ in ()).throw(module.AcquisitionError(SENTINEL))

keyring_item, keyring_summary, keyring_calls = decline_at('declined-keyring', 'keyring-qualification', keyring_failure)
assert keyring_calls == []
assert keyring_summary['acquisition_reason']['code'] == 'acquisition-declined'
assert keyring_summary['acquisition_reason']['error_type'] == 'AcquisitionError'

def private_write_failure(item, calls):
    item.select_sources = lambda *args, **kwargs: [official_source]
    item.write_private_sources = lambda *args, **kwargs: (_ for _ in ()).throw(PermissionError(13, SENTINEL))

private_item, private_summary, private_calls = decline_at('declined-private-write', 'private-source-write', private_write_failure)
assert private_calls == []
assert private_summary['acquisition_reason']['code'] == 'operation-failed'
assert private_summary['acquisition_reason']['error_type'] == 'PermissionError'
assert private_summary['acquisition_reason']['errno'] == 13

def metadata_failure(item, calls):
    item.select_sources = lambda *args, **kwargs: [official_source]
    item.write_private_sources = lambda *args, **kwargs: root / 'declined-metadata.list'
    item.apt_options = lambda *args: []
    def fail_update(command, *args, **kwargs):
        calls.append(command)
        raise module.AcquisitionError(SENTINEL)
    item.require = fail_update

metadata_item, metadata_summary, metadata_calls = decline_at('declined-metadata', 'metadata-refresh', metadata_failure)
assert metadata_calls == [['/usr/bin/apt-get', 'update']]
assert metadata_summary['acquisition_reason']['code'] == 'acquisition-declined'

drift = json.loads(json.dumps(preimage))
drift['runtime'] = {'runtime': 'drift'}
drift['runtime_sha256'] = 'drift'
drift_item, drift_summary, drift_calls = decline_at('declined-drift', 'metadata-refresh', metadata_failure, drift)
assert drift_calls == [['/usr/bin/apt-get', 'update']]
assert drift_summary['acquisition_reason'] is not None
assert drift_summary['runtime_unchanged'] is False

no_failure = acquisition_fixture('no-acquisition-failure')
no_failure.preimage = preimage
no_failure.phase = 'postimage-audit'
assert module.Controller.finish(no_failure) == 0
no_failure_summary = json.loads((no_failure.evidence.directory / 'acquisition-summary.json').read_text())
assert no_failure_summary['acquisition_reason'] is None
assert no_failure_summary['failure_stage'] is None

audit_failure = acquisition_fixture('audit-failure')
audit_failure.preimage = preimage
audit_failure.phase = 'postimage-audit'
audit_failure.measure = lambda phase: (_ for _ in ()).throw(OSError(5, SENTINEL))
assert module.Controller.finish(audit_failure) == 1
audit_summary = json.loads((audit_failure.evidence.directory / 'acquisition-summary.json').read_text())
assert audit_summary['acquisition_reason'] is None
assert audit_summary['audit_error'] == {
    'code': 'operation-failed', 'message': 'operation failed; details redacted',
    'error_type': 'OSError', 'errno': 5,
}
assert SENTINEL not in module.canonical(audit_summary)

with tempfile.TemporaryDirectory(dir=root) as temporary:
    apt = Path(temporary) / 'apt'
    parts = apt / 'sources.list.d'
    parts.mkdir(parents=True)
    (apt / 'sources.list').write_text('deb [arch=arm64] http://ports.ubuntu.com/ubuntu-ports resolute main\n')
    (parts / '01-odd.list').write_text('deb [arch=unicorn] http://ports.ubuntu.com/ubuntu-ports odd-suite main\n')
    (parts / '02-many.list').write_text(''.join('deb [arch=arm64] http://ports.ubuntu.com/ubuntu-ports resolute main\n' for _ in range(90)))
    (parts / '03-insecure.list').write_text(f'deb [trusted=yes] https://user:{SENTINEL}@ports.ubuntu.com/ubuntu?token={SENTINEL} resolute main\n')
    (parts / '04-third-party.list').write_text(f'deb https://{SENTINEL}.invalid/ubuntu resolute main\n')
    (parts / '05-malformed.list').write_text('deb [\n')
    (parts / '06-empty.list').write_text('deb http://ports.ubuntu.com/ubuntu-ports resolute\n')
    (parts / '10-disabled.sources').write_text('Types: deb\nEnabled: no\nURIs: http://ports.ubuntu.com/ubuntu-ports\nSuites: resolute\nComponents: main\n')
    (parts / 'ubuntu.sources').write_text('Types: deb\nURIs: http://ports.ubuntu.com/ubuntu-ports\nSuites: resolute\nComponents: main\nArchitectures: amd64\n')
    selected_sources = controller()
    selected_sources.evidence = module.Retention(root / 'source-telemetry-evidence')
    selected_sources.image_codename = 'resolute'
    selected = module.Controller.select_sources(selected_sources, apt)
    assert len(selected) == 93
    assert {'uri': 'http://ports.ubuntu.com/ubuntu-ports', 'suite': 'odd-suite', 'components': ['main'], 'architectures': 'unicorn'} in selected
    source_payload = (selected_sources.evidence.directory / 'source-selection.json').read_bytes()
    source_telemetry = json.loads(source_payload)
    source_text = source_payload.decode('utf-8')
    assert len(source_payload) <= module.SOURCE_TELEMETRY_LIMIT
    assert len(source_telemetry['details']) <= module.SOURCE_TELEMETRY_RECORD_LIMIT
    assert source_telemetry['details_truncated'] is True
    assert source_telemetry['counts']['selected'] == 93
    assert source_telemetry['counts']['rejected'] >= 5
    assert source_telemetry['counts']['discovered'] == 9
    assert source_telemetry['counts']['read'] == 9
    assert SENTINEL not in source_text
    assert '03-insecure.list' not in source_text
    assert 'https://' not in source_text
    assert 'odd-suite' not in source_text
    assert 'unicorn' not in source_text
    assert any(detail.get('host') == 'ports.ubuntu.com' and detail.get('suite') == 'resolute' and detail.get('architectures') == ['arm64'] for detail in source_telemetry['details'])
    assert selected_sources.evidence.total <= module.RETAINED_LIMIT

with tempfile.TemporaryDirectory(dir=root) as temporary:
    apt = Path(temporary) / 'apt'
    parts = apt / 'sources.list.d'
    parts.mkdir(parents=True)
    (apt / 'sources.list').write_text('deb http://ports.ubuntu.com/ubuntu-ports resolute main\n')
    (parts / 'read-error.list').write_bytes(b'\xff' + SENTINEL.encode())
    read_error = controller()
    read_error.evidence = module.Retention(root / 'source-read-error-evidence')
    read_error.image_codename = 'resolute'
    try:
        module.Controller.select_sources(read_error, apt)
    except UnicodeDecodeError:
        pass
    else:
        raise AssertionError('invalid source encoding must retain its existing raised behavior')
    read_error_payload = (read_error.evidence.directory / 'source-selection.json').read_bytes()
    assert len(read_error_payload) <= module.SOURCE_TELEMETRY_LIMIT
    assert SENTINEL not in read_error_payload.decode('utf-8')
    assert any(detail['code'] == 'read-error' for detail in json.loads(read_error_payload)['details'])

tree = runnable('descendant-pipes')
started = time.monotonic()
descendant = module.Controller.run(tree, ['/bin/sh', '-c', '(sleep 30) & exit 0'], 'postimage-audit', 1)
assert time.monotonic() - started < 4
assert not descendant.capture_complete
detached_pid_file = root / 'detached-pipe-holder.pid'
detached_parent = "import subprocess,sys; child=subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(6)'], start_new_session=True); open(sys.argv[1], 'w').write(str(child.pid))"
detached_runner = runnable('detached-descendant-pipes')
detached_pid = None
try:
    started = time.monotonic()
    detached = module.Controller.run(detached_runner, ['/usr/bin/python3', '-c', detached_parent, str(detached_pid_file)], 'postimage-audit', 1)
    elapsed = time.monotonic() - started
    detached_pid = int(detached_pid_file.read_text())
    os.kill(detached_pid, 0)
    assert elapsed < 3
    assert not detached.capture_complete
    assert not detached.stdout_complete and not detached.stderr_complete
    after_detached = module.Controller.run(detached_runner, ['/usr/bin/true'], 'postimage-keyring', 1)
    assert after_detached.code == 0 and after_detached.capture_complete
finally:
    if detached_pid is not None:
        try:
            os.kill(detached_pid, module.signal.SIGKILL)
        except ProcessLookupError:
            pass
terminating = runnable('timeout-tree')
started = time.monotonic()
timeout_result = module.Controller.run(terminating, ['/bin/sh', '-c', 'trap "" TERM; while :; do sleep 1; done'], 'postimage-audit', 1)
assert time.monotonic() - started < 6
assert timeout_result.timed_out
final_budget = runnable('final-audit-budget')
final_budget.deadline = time.monotonic() + 0.5
final_result = module.Controller.run(final_budget, ['/usr/bin/true'], 'postimage-keyring', 1)
assert final_result.code == 0 and final_result.capture_complete

class Evidence:
    def write_json(self, *args, **kwargs):
        pass

present = controller()
present.evidence = Evidence()
present.image_identity = lambda: {'image': 'ubuntu'}
present.measure = lambda phase: preimage
present.trusted_gdb = lambda: '/usr/bin/gdb'
present.select_sources = lambda: (_ for _ in ()).throw(AssertionError('existing gdb must not invoke apt source selection'))
present.status = 'initializing'
present.preimage = None
present.gdb = None
module.Controller.execute(present)
assert present.status == 'gdb-already-present'
assert present.gdb == '/usr/bin/gdb'

def finished(post, fail=False):
    item = controller()
    item.evidence = module.Retention(root / ('evidence-fail' if fail else 'evidence-ok'))
    item.github_output = root / ('output-fail' if fail else 'output-ok')
    item.preimage = preimage
    item.postimage = None
    item.plan = []
    item.status = 'acquisition-unavailable'
    item.reason = None
    item.commands = []
    item.phase = 'postimage-audit'
    item.source_records = []
    item.keyring = None
    item.post_sources = None
    item.post_keyring = None
    item.trusted_gdb = lambda: None
    if fail:
        def unavailable(phase):
            raise module.AcquisitionError('postimage timeout')
        item.measure = unavailable
    else:
        item.measure = lambda phase: post
    return item

safe = finished(preimage)
assert module.Controller.finish(safe) == 0
assert 'runtime_unchanged=true' in safe.github_output.read_text()
for label, postimage in [('wrong-version', wrong_version_post), ('wrong-architecture', wrong_architecture_post)]:
    rejected = finished(postimage)
    rejected.github_output = root / f'{label}-output'
    rejected.plan = [planned_gdb, planned_extra]
    assert module.Controller.finish(rejected) == 1
    assert 'runtime_unchanged=false' in rejected.github_output.read_text()
partial_install = finished(partial_post)
partial_install.plan = [planned_gdb, planned_extra]
partial_install.status = 'gdb-installed'
partial_install.trusted_gdb = lambda: '/usr/bin/gdb'
assert module.Controller.finish(partial_install) == 0
assert partial_install.status == 'installation-incomplete'
assert 'runtime_unchanged=true' in partial_install.github_output.read_text()
unknown = finished(preimage, fail=True)
assert module.Controller.finish(unknown) == 1
assert 'runtime_unchanged=false' in unknown.github_output.read_text()
assert 'controls_not_run' in (root / 'evidence-fail' / 'acquisition-summary.json').read_text()
print('extracted acquisition controls passed')
`
  const result = await runAcquisitionHarness(controller, harness)
  assert(result.success, new TextDecoder().decode(result.stderr))
  assertEquals(
    new TextDecoder().decode(result.stdout).trim(),
    'extracted acquisition controls passed',
  )
})

Deno.test('fixed mirror descriptor compatibility binds only the protected exact image source', async () => {
  const controller = acquisitionController(await releaseWorkflow())
  assert(
    controller.includes(
      "FIXED_MIRROR_DESCRIPTOR_URI = 'mirror+file:/etc/apt/apt-mirrors.txt'",
    ),
  )
  assert(controller.includes('FIXED_MIRROR_DESCRIPTOR_READ_LIMIT = 145'))
  assert(controller.includes('os.O_CLOEXEC | os.O_NOFOLLOW | os.O_NONBLOCK'))
  assert(controller.includes("source.get('resolved_uri', source['uri'])"))
  assert(controller.includes("self.select_sources(observation='post-audit')"))
  assert(
    controller.includes(
      'def retain_initial_fixed_mirror_binding(self, descriptor):',
    ),
  )
  assert(
    controller.includes(
      'self.post_fixed_mirror_binding = self.fixed_mirror_binding(self.fixed_mirror_descriptor())',
    ),
  )
  assert(controller.includes("observation == 'initial'"))
  const harness = String.raw`
import copy
import importlib.util
import json
import os
import stat
import sys
from pathlib import Path
from types import SimpleNamespace

spec = importlib.util.spec_from_file_location('fixed_mirror_controller', sys.argv[1])
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)
root = Path(sys.argv[2])
EXPECTED = module.FIXED_MIRROR_DESCRIPTOR_BYTES
MIRROR = module.FIXED_MIRROR_DESCRIPTOR_URI
PRIORITY1 = module.FIXED_MIRROR_RESOLVED_URI.rstrip('/')

class DescriptorFixture:
    def __init__(self, data=EXPECTED):
        self.data = data
        self.device = 91
        self.inode = 101
        self.uid = 0
        self.gid = 0
        self.file_uid = None
        self.file_mode = stat.S_IFREG | 0o644
        self.etc_mode = stat.S_IFDIR | 0o755
        self.apt_mode = stat.S_IFDIR | 0o755
        self.etc_inode = 11
        self.apt_inode = 12
        self.mtime = 501
        self.ctime = 502
        self.open_inode = None
        self.replace_during_read = False
        self.missing = False
        self.open_calls = 0
        self.open_flags = []
        self.read_sizes = []
        self._offset = 0
        self._opened = None

    def info(self, mode, inode, size=0, uid=None):
        return SimpleNamespace(
            st_dev=self.device,
            st_ino=inode,
            st_uid=self.uid if uid is None else uid,
            st_gid=self.gid,
            st_mode=mode,
            st_size=size,
            st_mtime_ns=self.mtime,
            st_ctime_ns=self.ctime,
        )

    def lstat(self, path):
        path = str(path)
        if path == '/etc':
            return self.info(self.etc_mode, self.etc_inode)
        if path == '/etc/apt':
            return self.info(self.apt_mode, self.apt_inode)
        if path == module.FIXED_MIRROR_DESCRIPTOR_PATH:
            if self.missing:
                raise FileNotFoundError(2, 'missing descriptor')
            return self.info(self.file_mode, self.inode, len(self.data), self.file_uid)
        return original_lstat(path)

    def open(self, path, flags):
        assert str(path) == module.FIXED_MIRROR_DESCRIPTOR_PATH
        self.open_calls += 1
        self.open_flags.append(flags)
        self._offset = 0
        self._opened = (self.open_inode if self.open_inode is not None else self.inode, bytes(self.data), self.file_mode, self.uid if self.file_uid is None else self.file_uid, self.gid, self.mtime, self.ctime)
        return 701

    def fstat(self, descriptor_fd):
        assert descriptor_fd == 701 and self._opened is not None
        inode, data, mode, uid, gid, mtime, ctime = self._opened
        return SimpleNamespace(
            st_dev=self.device,
            st_ino=inode,
            st_uid=uid,
            st_gid=gid,
            st_mode=mode,
            st_size=len(data),
            st_mtime_ns=mtime,
            st_ctime_ns=ctime,
        )

    def read(self, descriptor_fd, amount):
        assert descriptor_fd == 701
        self.read_sizes.append(amount)
        data = self._opened[1]
        block = data[self._offset:self._offset + amount]
        self._offset += len(block)
        if self.replace_during_read and block:
            self.inode += 1
            self.replace_during_read = False
        return block

    def close(self, descriptor_fd):
        assert descriptor_fd == 701

def bare(label):
    item = object.__new__(module.Controller)
    item.evidence = module.Retention(root / (label + '-evidence'))
    item.image_codename = 'resolute'
    return item

def expect_reject(action):
    try:
        action()
    except module.AcquisitionError as error:
        return error
    raise AssertionError('expected descriptor refusal')

def source_tree(label, source, name='sources.list'):
    apt = root / label / 'apt'
    (apt / 'sources.list.d').mkdir(parents=True)
    destination = apt / name
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_text(source)
    return apt

original_lstat = module.os.lstat
original_open = module.os.open
original_fstat = module.os.fstat
original_read = module.os.read
original_close = module.os.close

def install_fixture(fixture):
    module.os.lstat = fixture.lstat
    module.os.open = fixture.open
    module.os.fstat = fixture.fstat
    module.os.read = fixture.read
    module.os.close = fixture.close

def restore_fixture():
    module.os.lstat = original_lstat
    module.os.open = original_open
    module.os.fstat = original_fstat
    module.os.read = original_read
    module.os.close = original_close

try:
    valid_fixture = DescriptorFixture()
    install_fixture(valid_fixture)
    valid_apt = source_tree('valid', 'deb [arch=arm64] ' + MIRROR + ' resolute main\n')
    valid = bare('valid')
    official_calls = []
    original_official = module.Controller.official_uri
    def counted_official(uri):
        official_calls.append(uri)
        return original_official(valid, uri)
    valid.official_uri = counted_official
    selected = module.Controller.select_sources(valid, valid_apt)
    assert len(selected) == 1
    record = selected[0]
    assert record['uri'] == MIRROR
    assert record['resolved_uri'] == PRIORITY1
    assert record['suite'] == 'resolute' and record['components'] == ['main'] and record['architectures'] == 'arm64'
    assert record['descriptor']['path'] == module.FIXED_MIRROR_DESCRIPTOR_PATH
    assert record['descriptor']['sha256'] == module.FIXED_MIRROR_DESCRIPTOR_SHA256
    assert record['descriptor']['size'] == 144
    assert record['descriptor']['validated_uri_count'] == 3
    assert record['descriptor']['identity']['inode'] == valid_fixture.inode
    assert valid.initial_fixed_mirror_binding['uri'] == MIRROR
    assert valid.initial_fixed_mirror_binding['descriptor'] == record['descriptor']
    assert all(uri in official_calls for uri in module.FIXED_MIRROR_URIS)
    assert valid_fixture.open_calls == 1
    assert valid_fixture.open_flags[0] & module.os.O_NOFOLLOW
    assert valid_fixture.open_flags[0] & module.os.O_CLOEXEC
    assert valid_fixture.open_flags[0] & module.os.O_NONBLOCK
    assert valid_fixture.read_sizes == [145, 1]
    selection_evidence = json.loads((valid.evidence.directory / 'source-selection.json').read_text())
    assert selection_evidence['fixed_mirror_descriptor']['sha256'] == module.FIXED_MIRROR_DESCRIPTOR_SHA256
    assert selection_evidence['fixed_mirror_descriptor']['resolved_uri'] == module.FIXED_MIRROR_RESOLVED_URI

    valid.work = root / 'valid-private'
    valid.work.mkdir()
    valid.keyring_identity = lambda *args: {'path': module.KEYRING, 'sha256': 'a' * 64, 'size': 1, 'owner': 'ubuntu-keyring:arm64', 'owner_tuple': {}}
    private_source = module.Controller.write_private_sources(valid, selected, {'installed': {}})
    private_text = private_source.read_text()
    assert PRIORITY1 in private_text and MIRROR not in private_text
    assert 'signed-by=' + module.KEYRING in private_text
    assert module.Controller.uri_is_selected(valid, PRIORITY1 + '/pool/main/g/gdb/gdb.deb')

    direct_apt = source_tree('direct', 'deb [arch=arm64] http://ports.ubuntu.com/ubuntu-ports resolute main\n')
    direct = bare('direct')
    assert module.Controller.select_sources(direct, direct_apt) == [{'uri': 'http://ports.ubuntu.com/ubuntu-ports', 'suite': 'resolute', 'components': ['main'], 'architectures': 'arm64'}]

    for number, invalid_uri in enumerate([
        'mirror+file:/etc/apt/apt-mirrors.txt/',
        'mirror+file:/etc/apt/apt-mirrors.txt?x=1',
        'mirror+file://etc/apt/apt-mirrors.txt',
        'mirror+file:/etc/apt/%61pt-mirrors.txt',
        'file:/etc/apt/apt-mirrors.txt',
        'mirror+https://azure.archive.ubuntu.com/ubuntu/',
    ]):
        invalid_fixture = DescriptorFixture()
        install_fixture(invalid_fixture)
        invalid = bare('literal-' + str(number))
        error = expect_reject(lambda: module.Controller.select_sources(invalid, source_tree('literal-' + str(number), 'deb ' + invalid_uri + ' resolute main\n')))
        assert error.code == 'no-supported-source'
        assert invalid_fixture.open_calls == 0

    ordinary_fixture = DescriptorFixture()
    install_fixture(ordinary_fixture)
    ordinary = bare('ordinary-direct')
    assert module.Controller.select_sources(ordinary, source_tree('ordinary-direct', 'deb https://azure.archive.ubuntu.com/ubuntu/ resolute main\n')) == [{'uri': 'https://azure.archive.ubuntu.com/ubuntu', 'suite': 'resolute', 'components': ['main'], 'architectures': None}]
    assert ordinary_fixture.open_calls == 0

    for label, configure, refusal in [
        ('unsafe-parent', lambda item: setattr(item, 'apt_mode', stat.S_IFDIR | 0o775), 'unsafe-descriptor-parent'),
        ('symlink-file', lambda item: setattr(item, 'file_mode', stat.S_IFLNK | 0o777), 'unsafe-descriptor-file'),
        ('nonroot-file', lambda item: setattr(item, 'file_uid', 1000), 'unsafe-descriptor-file'),
        ('group-writable-file', lambda item: setattr(item, 'file_mode', stat.S_IFREG | 0o664), 'unsafe-descriptor-file'),
        ('oversized', lambda item: setattr(item, 'data', EXPECTED + b'x'), 'descriptor-content-mismatch'),
        ('changed-priority', lambda item: setattr(item, 'data', EXPECTED.replace(b'priority:2', b'priority:9')), 'descriptor-content-mismatch'),
        ('open-race', lambda item: setattr(item, 'open_inode', item.inode + 1), 'descriptor-raced'),
        ('read-race', lambda item: setattr(item, 'replace_during_read', True), 'descriptor-raced'),
    ]:
        protected_fixture = DescriptorFixture()
        configure(protected_fixture)
        install_fixture(protected_fixture)
        protected = bare(label)
        error = expect_reject(lambda: module.Controller.select_sources(protected, source_tree(label, 'deb ' + MIRROR + ' resolute main\n')))
        assert error.code == 'fixed-mirror-descriptor-refused'
        payload = json.loads((protected.evidence.directory / 'source-selection.json').read_text())
        assert payload['fixed_mirror_descriptor'] == {'path': module.FIXED_MIRROR_DESCRIPTOR_PATH, 'refusal': refusal}, (label, payload['fixed_mirror_descriptor'], refusal)
        assert b'priority:9' not in (protected.evidence.directory / 'source-selection.json').read_bytes()

    for label, contents in [
        ('mixed-list-direct-first', 'deb http://ports.ubuntu.com/ubuntu-ports resolute main\n' + 'deb ' + MIRROR + ' resolute main\n'),
        ('mixed-list-mirror-first', 'deb ' + MIRROR + ' resolute main\n' + 'deb http://ports.ubuntu.com/ubuntu-ports resolute main\n'),
        ('mixed-deb822-direct-first', 'Types: deb\nURIs: http://ports.ubuntu.com/ubuntu-ports ' + MIRROR + '\nSuites: resolute\nComponents: main\n'),
        ('mixed-deb822-mirror-first', 'Types: deb\nURIs: ' + MIRROR + ' http://ports.ubuntu.com/ubuntu-ports\nSuites: resolute\nComponents: main\n'),
    ]:
        mixed_fixture = DescriptorFixture(b'not-the-fixed-descriptor')
        install_fixture(mixed_fixture)
        mixed = bare(label)
        source_name = 'sources.list.d/mirror.sources' if 'deb822' in label else 'sources.list'
        error = expect_reject(lambda: module.Controller.select_sources(mixed, source_tree(label, contents, source_name)))
        assert error.code == 'fixed-mirror-descriptor-refused', (label, error.code, mixed_fixture.open_calls)
        assert mixed_fixture.open_calls == 1

    short_circuit_fixture = DescriptorFixture()
    install_fixture(short_circuit_fixture)
    for label, contents in [
        ('trusted-short-circuit', 'deb [trusted=yes] ' + MIRROR + ' resolute main\n'),
        ('no-binary-short-circuit', 'deb-src ' + MIRROR + ' resolute main\n'),
        ('disabled-short-circuit', 'Types: deb\nEnabled: no\nURIs: ' + MIRROR + '\nSuites: resolute\nComponents: main\n'),
        ('deb822-no-binary-short-circuit', 'Types: deb-src\nURIs: ' + MIRROR + '\nSuites: resolute\nComponents: main\n'),
    ]:
        short = bare(label)
        expect_reject(lambda: module.Controller.select_sources(short, source_tree(label, contents)))
    assert short_circuit_fixture.open_calls == 0

    preimage = {
        'packages': {'installed': {}, 'residual': {}, 'sha256': 'packages'},
        'runtime': {'target': 'stable'},
        'runtime_sha256': 'runtime',
    }
    solver = 'Inst gdb (15.0 Ubuntu:26.04/resolute [arm64])\nConf gdb (15.0 Ubuntu:26.04/resolute [arm64])\n0 upgraded, 1 newly installed, 0 to remove and 0 not upgraded.\n'

    def acquisition_item(label, apt):
        item = object.__new__(module.Controller)
        item.evidence = module.Retention(root / (label + '-evidence'))
        item.work = root / (label + '-work')
        item.work.mkdir()
        (item.work / 'archives').mkdir()
        deb = item.work / 'archives' / 'gdb.deb'
        deb.write_bytes(b'abc')
        item.github_output = root / (label + '-output')
        item.failure_stage = None
        item.acquisition_reason = None
        item.audit_error = None
        item.image_codename = None
        item.commands = []
        item.phase = 'initializing'
        item.plan = []
        item.source_records = []
        item.keyring = None
        item.post_sources = None
        item.post_keyring = None
        item.preimage = None
        item.postimage = None
        item.status = 'initializing'
        item.gdb = None
        item.image_identity = lambda: {'os_release': {'VERSION_CODENAME': 'resolute'}}
        item.measure = lambda phase: copy.deepcopy(preimage)
        item.trusted_gdb = lambda: None
        item.keyring_identity = lambda *args: {'path': module.KEYRING, 'sha256': 'c' * 64, 'size': 1, 'owner': 'ubuntu-keyring:arm64', 'owner_tuple': {}}
        select = module.Controller.select_sources
        item.select_sources = lambda root_value=Path('/etc/apt'), observation='initial': select(item, apt, observation)
        item.apt_options = lambda source: []
        metadata = 'Package: gdb\nVersion: 15.0\nArchitecture: arm64\nFilename: pool/main/g/gdb/gdb.deb\nSize: 3\nSHA256: ' + module.sha_file(deb) + '\n'
        required = []
        def require(command, phase, *args, **kwargs):
            required.append(phase)
            if phase == 'print-uris':
                source = item.source_records[0]
                source_uri = source.get('resolved_uri', source['uri']).rstrip('/')
                output = "'" + source_uri + "/pool/main/g/gdb/gdb.deb' gdb.deb 3 SHA256:ignored\n"
            elif phase in {'solver-initial', 'solver-frozen'}:
                output = solver
            elif phase == 'authenticated-metadata':
                output = metadata
            elif phase == 'deb-identity':
                output = 'Package: gdb\nVersion: 15.0\nArchitecture: arm64\n'
            else:
                output = ''
            return module.Result(0, False, output.encode(), b'', len(output.encode()), 0, True, True, True)
        item.require = require
        item.run = lambda *args, **kwargs: module.Result(1, False, b'', b'', 0, 0, True, True, True)
        return item, required

    def early_failure_case(label, contents, source_name, configure, mutate=None, expected_exit=1):
        fixture = DescriptorFixture()
        install_fixture(fixture)
        item, required = acquisition_item(label, source_tree(label, contents, source_name))
        configure(item)
        try:
            module.Controller.execute(item)
        except Exception as raised:
            captured_error = raised
        else:
            raise AssertionError('expected early acquisition failure')
        assert item.initial_fixed_mirror_binding['uri'] == MIRROR
        assert item.source_records == [] and required == []
        item.capture_acquisition_failure(captured_error)
        item.status = 'acquisition-declined-or-incomplete'
        if mutate is not None:
            mutate(fixture)
        assert module.Controller.finish(item) == expected_exit
        summary = json.loads((item.evidence.directory / 'acquisition-summary.json').read_text())
        assert summary['acquisition_reason'] is not None
        assert summary['initial_fixed_mirror_binding'] == item.initial_fixed_mirror_binding
        return item, fixture, summary

    def fail_keyring(item):
        item.keyring_identity = lambda *args: (_ for _ in ()).throw(module.AcquisitionError('inert keyring qualification failure'))

    def fail_selector_telemetry(item):
        write_exact = item.evidence.write_exact
        def fail_initial_source_evidence(name, *args, **kwargs):
            if name == 'source-selection.json':
                raise module.AcquisitionError('inert source telemetry retention failure')
            return write_exact(name, *args, **kwargs)
        item.evidence.write_exact = fail_initial_source_evidence

    early_mirror = 'deb ' + MIRROR + ' resolute main\n'
    for label, mutation in [
        ('early-keyring-missing', lambda fixture: setattr(fixture, 'missing', True)),
        ('early-keyring-same-bytes-new-inode', lambda fixture: setattr(fixture, 'inode', fixture.inode + 1)),
        ('early-keyring-priority1-preserved-content-change', lambda fixture: setattr(fixture, 'data', EXPECTED.replace(b'priority:3', b'priority:8'))),
    ]:
        item, fixture, summary = early_failure_case(label, early_mirror, 'sources.list', fail_keyring, mutation)
        assert summary['runtime_unchanged'] is False
        assert summary['controls_not_run'] == 'unsafe-or-unknown-postimage'
        if fixture.missing or fixture.data != EXPECTED:
            assert summary['audit_error']['code'] == 'fixed-mirror-descriptor-refused'
        else:
            assert summary['audit_error'] is None

    unchanged_early, unchanged_fixture, unchanged_summary = early_failure_case(
        'early-keyring-unchanged', early_mirror, 'sources.list', fail_keyring, expected_exit=0,
    )
    assert unchanged_summary['runtime_unchanged'] is True
    assert unchanged_summary['audit_error'] is None
    assert unchanged_summary['post_fixed_mirror_binding'] == unchanged_early.initial_fixed_mirror_binding
    assert unchanged_fixture.open_calls >= 2

    malformed_item, malformed_fixture, malformed_summary = early_failure_case(
        'early-malformed-port',
        early_mirror + 'deb http://ports.ubuntu.com:bad/ubuntu resolute main\n',
        'sources.list',
        lambda item: None,
        lambda fixture: setattr(fixture, 'missing', True),
    )
    assert malformed_summary['failure_stage'] == 'select-sources'
    assert malformed_summary['runtime_unchanged'] is False
    assert malformed_summary['audit_error']['code'] == 'fixed-mirror-descriptor-refused'

    telemetry_item, telemetry_fixture, telemetry_summary = early_failure_case(
        'early-selector-telemetry', early_mirror, 'sources.list', fail_selector_telemetry,
        lambda fixture: setattr(fixture, 'missing', True),
    )
    assert telemetry_summary['failure_stage'] == 'select-sources'
    assert telemetry_summary['runtime_unchanged'] is False
    assert telemetry_summary['audit_error']['code'] == 'fixed-mirror-descriptor-refused'

    latch_fixture = DescriptorFixture()
    install_fixture(latch_fixture)
    latch_item, latch_required = acquisition_item('multiple-initial-bindings', source_tree('multiple-initial-bindings', 'deb http://ports.ubuntu.com/ubuntu-ports resolute main\n'))
    module.Controller.fixed_mirror_source(latch_item, MIRROR, 'resolute', ['main'], None)
    first_binding = copy.deepcopy(latch_item.initial_fixed_mirror_binding)
    latch_fixture.inode += 1
    module.Controller.fixed_mirror_source(latch_item, MIRROR, 'resolute', ['main'], None)
    assert latch_item.initial_fixed_mirror_binding == first_binding
    assert latch_item.fixed_mirror_binding_unsafe is True and latch_required == []
    latch_item.preimage = copy.deepcopy(preimage)
    latch_item.status = 'acquisition-declined-or-incomplete'
    assert module.Controller.finish(latch_item) == 1
    latch_summary = json.loads((latch_item.evidence.directory / 'acquisition-summary.json').read_text())
    assert latch_summary['fixed_mirror_binding_unsafe'] is True
    assert latch_summary['runtime_unchanged'] is False

    for label, contents, source_name in [
        ('mixed-controller-list-direct-first', 'deb http://ports.ubuntu.com/ubuntu-ports resolute main\n' + 'deb ' + MIRROR + ' resolute main\n', 'sources.list'),
        ('mixed-controller-list-mirror-first', 'deb ' + MIRROR + ' resolute main\n' + 'deb http://ports.ubuntu.com/ubuntu-ports resolute main\n', 'sources.list'),
        ('mixed-controller-deb822-direct-first', 'Types: deb\nURIs: http://ports.ubuntu.com/ubuntu-ports ' + MIRROR + '\nSuites: resolute\nComponents: main\n', 'sources.list.d/mirror.sources'),
        ('mixed-controller-deb822-mirror-first', 'Types: deb\nURIs: ' + MIRROR + ' http://ports.ubuntu.com/ubuntu-ports\nSuites: resolute\nComponents: main\n', 'sources.list.d/mirror.sources'),
    ]:
        mixed_controller_fixture = DescriptorFixture(b'not-the-fixed-descriptor')
        install_fixture(mixed_controller_fixture)
        mixed_controller, mixed_required = acquisition_item(label, source_tree(label, contents, source_name))
        error = expect_reject(lambda: module.Controller.execute(mixed_controller))
        mixed_controller.capture_acquisition_failure(error)
        mixed_controller.status = 'acquisition-declined-or-incomplete'
        assert mixed_required == []
        assert module.Controller.finish(mixed_controller) == 0
        mixed_summary = json.loads((mixed_controller.evidence.directory / 'acquisition-summary.json').read_text())
        assert mixed_summary['failure_stage'] == 'select-sources'
        assert mixed_summary['acquisition_reason']['code'] == 'fixed-mirror-descriptor-refused'
        assert mixed_summary['runtime_unchanged'] is True and mixed_summary['controls_not_run'] is None

    execute_fixture = DescriptorFixture()
    install_fixture(execute_fixture)
    execute_apt = source_tree('execute', 'deb [arch=arm64] ' + MIRROR + ' resolute main\n')
    execute_item, required = acquisition_item('execute', execute_apt)
    module.Controller.execute(execute_item)
    assert execute_item.status == 'installation-incomplete'
    assert execute_item.source_records[0]['uri'] == MIRROR
    assert execute_item.source_records[0]['resolved_uri'] == PRIORITY1
    assert {'apt-update', 'solver-initial', 'authenticated-metadata', 'print-uris', 'download-debs', 'solver-frozen', 'deb-identity'} <= set(required)
    assert module.Controller.finish(execute_item) == 0
    assert 'runtime_unchanged=true' in execute_item.github_output.read_text()
    assert execute_fixture.open_calls >= 2

    post_only_fixture = DescriptorFixture()
    install_fixture(post_only_fixture)
    post_only_apt = source_tree('post-only-binding', 'deb http://ports.ubuntu.com/ubuntu-ports resolute main\n')
    post_only_item, post_only_required = acquisition_item('post-only-binding', post_only_apt)
    module.Controller.execute(post_only_item)
    assert not hasattr(post_only_item, 'initial_fixed_mirror_binding')
    assert post_only_fixture.open_calls == 0
    (post_only_apt / 'sources.list').write_text('deb ' + MIRROR + ' resolute main\n')
    assert module.Controller.finish(post_only_item) == 1
    post_only_summary = json.loads((post_only_item.evidence.directory / 'acquisition-summary.json').read_text())
    assert post_only_required
    assert post_only_summary['initial_fixed_mirror_binding'] is None
    assert post_only_summary['post_fixed_mirror_binding'] is None
    assert post_only_summary['runtime_unchanged'] is False
    assert post_only_fixture.open_calls == 1

    identity_mutation = DescriptorFixture()
    install_fixture(identity_mutation)
    identity_apt = source_tree('identity-mutation', 'deb ' + MIRROR + ' resolute main\n')
    identity_item, _ = acquisition_item('identity-mutation', identity_apt)
    module.Controller.execute(identity_item)
    identity_mutation.inode += 1
    assert module.Controller.finish(identity_item) == 1
    identity_summary = json.loads((identity_item.evidence.directory / 'acquisition-summary.json').read_text())
    assert identity_summary['runtime_unchanged'] is False and identity_summary['controls_not_run'] == 'unsafe-or-unknown-postimage'

    content_mutation = DescriptorFixture()
    install_fixture(content_mutation)
    content_apt = source_tree('content-mutation', 'deb ' + MIRROR + ' resolute main\n')
    content_item, _ = acquisition_item('content-mutation', content_apt)
    module.Controller.execute(content_item)
    content_mutation.data = EXPECTED.replace(b'priority:3', b'priority:8')
    assert module.Controller.finish(content_item) == 1
    content_summary = json.loads((content_item.evidence.directory / 'acquisition-summary.json').read_text())
    assert content_summary['runtime_unchanged'] is False and content_summary['audit_error']['code'] == 'fixed-mirror-descriptor-refused'

    missing_mutation = DescriptorFixture()
    install_fixture(missing_mutation)
    missing_apt = source_tree('missing-mutation', 'deb http://ports.ubuntu.com/ubuntu-ports resolute main\n' + 'deb ' + MIRROR + ' resolute main\n')
    missing_item, _ = acquisition_item('missing-mutation', missing_apt)
    module.Controller.execute(missing_item)
    missing_mutation.missing = True
    assert module.Controller.finish(missing_item) == 1

    refusal_fixture = DescriptorFixture()
    refusal_fixture.data = b'not-the-fixed-descriptor'
    install_fixture(refusal_fixture)
    refusal_item, refusal_required = acquisition_item('initial-refusal', source_tree('initial-refusal', 'deb ' + MIRROR + ' resolute main\n'))
    error = expect_reject(lambda: module.Controller.execute(refusal_item))
    refusal_item.capture_acquisition_failure(error)
    refusal_item.status = 'acquisition-declined-or-incomplete'
    assert refusal_required == []
    assert module.Controller.finish(refusal_item) == 0
    refusal_summary = json.loads((refusal_item.evidence.directory / 'acquisition-summary.json').read_text())
    assert refusal_summary['runtime_unchanged'] is True
    assert refusal_summary['acquisition_reason']['code'] == 'fixed-mirror-descriptor-refused'
finally:
    restore_fixture()
print('fixed mirror descriptor extracted controls passed')
`
  const result = await runAcquisitionHarness(controller, harness)
  assert(result.success, new TextDecoder().decode(result.stderr))
  assertEquals(
    new TextDecoder().decode(result.stdout).trim(),
    'fixed mirror descriptor extracted controls passed',
  )
})

Deno.test('source selection telemetry preserves parser semantics and one shared budget', async () => {
  const controller = acquisitionController(await releaseWorkflow())
  const harness = String.raw`
import importlib.util
import json
import sys
from pathlib import Path

spec = importlib.util.spec_from_file_location('evidence_controller', sys.argv[1])
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)
root = Path(sys.argv[2])
CANARY = 'EVIDENCE-CREDENTIAL-CANARY-DO-NOT-RETAIN'
GOOD = 'deb [arch=arm64] http://ports.ubuntu.com/ubuntu-ports resolute main\n'
EXPECTED_GOOD = {'uri': 'http://ports.ubuntu.com/ubuntu-ports', 'suite': 'resolute', 'components': ['main'], 'architectures': 'arm64'}

def bare(label):
    item = object.__new__(module.Controller)
    item.evidence = module.Retention(root / (label + '-evidence'))
    item.image_codename = 'resolute'
    return item

def source_case(label, files):
    apt = root / label / 'apt'
    (apt / 'sources.list.d').mkdir(parents=True)
    for name, content in files.items():
        path = apt / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content)
    item = bare(label)
    try:
        outcome = ('records', module.Controller.select_sources(item, apt))
    except Exception as error:
        outcome = ('raised', type(error).__name__)
    payload = (item.evidence.directory / 'source-selection.json').read_bytes()
    return item, outcome, json.loads(payload), payload

# E1: expected outcomes were independently frozen from the 02cd9 selector.
item, outcome, telemetry, payload = source_case('trusted-malformed-list', {
    'sources.list': GOOD + 'deb [arch=unicorn] http://ports.ubuntu.com/ubuntu-ports odd-suite main\n' + 'deb [trusted=yes] http://ports.ubuntu.com:bad/ubuntu-ports resolute main\n',
})
assert outcome == ('records', [EXPECTED_GOOD, {'uri': 'http://ports.ubuntu.com/ubuntu-ports', 'suite': 'odd-suite', 'components': ['main'], 'architectures': 'unicorn'}])
assert any(row['code'] == 'insecure-trust' for row in telemetry['details'])

item, outcome, telemetry, payload = source_case('active-malformed-deb822', {
    'sources.list': GOOD,
    'sources.list.d/ubuntu.sources': 'Types: deb\nURIs: http://ports.ubuntu.com:bad/ubuntu-ports\nSuites: resolute\n',
})
assert outcome == ('raised', 'ValueError')
assert any(row['code'] == 'uri-parse-failure' and row['location'] == 'sources.list.d/ubuntu.sources' and row['entry'] == 1 for row in telemetry['details'])

for label, files in [
    ('trusted-malformed-ipv6', {'sources.list': GOOD + 'deb [trusted=yes] http://[::1/ubuntu resolute main\n'}),
    ('disabled-malformed-port', {'sources.list': GOOD, 'sources.list.d/ubuntu.sources': 'Types: deb\nEnabled: no\nURIs: http://ports.ubuntu.com:bad/ubuntu-ports\nSuites: resolute\nComponents: main\n'}),
]:
    item, outcome, telemetry, payload = source_case(label, files)
    assert outcome == ('records', [EXPECTED_GOOD])

item, outcome, telemetry, payload = source_case('active-malformed-ipv6', {
    'sources.list': GOOD + 'deb http://[::1/ubuntu resolute main\n',
})
assert outcome == ('raised', 'ValueError')
assert any(row['code'] == 'uri-parse-failure' and row['entry'] == 2 for row in telemetry['details'])

# E2: 100 records remain selected in both phases within one 16KiB/64-detail budget.
apt = root / 'two-phase' / 'apt'
(apt / 'sources.list.d').mkdir(parents=True)
(apt / 'sources.list').write_text(GOOD * 100)
two_phase = bare('two-phase')
first = module.Controller.select_sources(two_phase, apt)
initial_path = two_phase.evidence.directory / 'source-selection.json'
initial = initial_path.read_bytes()
second = module.Controller.select_sources(two_phase, apt, observation='post-audit')
post = (two_phase.evidence.directory / 'source-selection-post-audit.json').read_bytes()
initial_value, post_value = json.loads(initial), json.loads(post)
assert first == second and len(first) == 100 and initial_path.read_bytes() == initial
assert len(initial) + len(post) <= module.SOURCE_TELEMETRY_LIMIT
assert len(initial_value['details']) + len(post_value['details']) <= module.SOURCE_TELEMETRY_RECORD_LIMIT
assert initial_value['counts']['selected'] == post_value['counts']['selected'] == 100
assert initial_value['details_truncated'] and post_value['details_truncated']
two_phase.evidence.write_json('acquisition-summary.json', {'terminal': True}, terminal=True)
assert two_phase.evidence.total <= module.RETAINED_LIMIT

item, outcome, telemetry, payload = source_case('terminal-parser-failure', {
    'sources.list': GOOD * 100 + f'deb http://ports.ubuntu.com:bad/ubuntu-ports?token={CANARY} resolute main\n',
})
assert outcome == ('raised', 'ValueError')
assert telemetry['counts']['selected'] == 100 and telemetry['details_truncated']
assert any(row['code'] == 'uri-parse-failure' and row['entry'] == 101 for row in telemetry['details'])
assert len(payload) <= module.SOURCE_TELEMETRY_PHASE_LIMIT and CANARY.encode() not in payload

# E3: logical source entries survive missing and malformed URI paths without raw input.
item, outcome, telemetry, payload = source_case('missing-uri-only', {
    'sources.list.d/ubuntu.sources': f'Types: deb\nSuites: {CANARY}\nComponents: main\n',
})
assert outcome == ('raised', 'AcquisitionError')
assert any(row['code'] == 'missing-uri' and row['location'] == 'sources.list.d/ubuntu.sources' and row['entry'] == 1 for row in telemetry['details'])
assert CANARY.encode() not in payload

item, outcome, telemetry, payload = source_case('missing-uri-with-valid', {
    'sources.list': GOOD,
    'sources.list.d/ubuntu.sources': f'Types: deb\nSuites: {CANARY}\nComponents: main\n',
})
assert outcome == ('records', [EXPECTED_GOOD])
assert any(row['code'] == 'missing-uri' and row['entry'] == 1 for row in telemetry['details'])

item, outcome, telemetry, payload = source_case('active-parse-redacted', {
    'sources.list.d/ubuntu.sources': f'Types: deb\nURIs: http://ports.ubuntu.com:bad/ubuntu-ports?token={CANARY}\nSuites: {CANARY}\nComponents: main\n',
})
assert outcome == ('raised', 'ValueError')
assert any(row['code'] == 'uri-parse-failure' and row['location'] == 'sources.list.d/ubuntu.sources' and row['entry'] == 1 for row in telemetry['details'])
assert CANARY.encode() not in payload
print('E1-E3 extracted controls passed')
`
  const result = await runAcquisitionHarness(controller, harness)
  assert(result.success, new TextDecoder().decode(result.stderr))
  assertEquals(
    new TextDecoder().decode(result.stdout).trim(),
    'E1-E3 extracted controls passed',
  )
})

Deno.test('offline install Results retain acquisition evidence without executing package commands', async () => {
  const controller = acquisitionController(await releaseWorkflow())
  const harness = String.raw`
import copy
import importlib.util
import json
import sys
from pathlib import Path

spec = importlib.util.spec_from_file_location('install_controller', sys.argv[1])
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)
root = Path(sys.argv[2])
preimage = {'packages': {'installed': {}, 'residual': {}, 'sha256': 'a' * 64}, 'runtime': {'target': 'stable'}, 'runtime_sha256': 'b' * 64}
solver = 'Inst gdb (15.0 Ubuntu:26.04/resolute [arm64])\nConf gdb (15.0 Ubuntu:26.04/resolute [arm64])\n0 upgraded, 1 newly installed, 0 to remove and 0 not upgraded.\n'

def install_case(label, result, postimage=None, finish_gdb=False):
    item = object.__new__(module.Controller)
    item.evidence = module.Retention(root / (label + '-evidence'))
    item.work = root / (label + '-work')
    item.work.mkdir()
    item.failure_stage = None
    item.acquisition_reason = None
    item.audit_error = None
    item.image_codename = None
    item.commands = []
    item.phase = 'initializing'
    item.plan = []
    item.source_records = []
    item.keyring = None
    item.post_sources = None
    item.post_keyring = None
    item.preimage = None
    item.postimage = None
    item.status = 'initializing'
    item.gdb = None
    item.github_output = root / (label + '-output')
    item.image_identity = lambda: {'os_release': {'VERSION_CODENAME': 'resolute'}}
    post = copy.deepcopy(postimage if postimage is not None else preimage)
    item.measure = lambda phase: copy.deepcopy(preimage if phase in {'preimage', 'preinstall-audit'} else post)
    gdb_calls = []
    def trusted_gdb():
        gdb_calls.append(True)
        return '/usr/bin/gdb' if finish_gdb and len(gdb_calls) > 1 else None
    item.trusted_gdb = trusted_gdb
    item.keyring_identity = lambda *args: {'path': module.KEYRING, 'sha256': 'c' * 64, 'size': 1, 'owner': 'ubuntu-keyring:arm64', 'owner_tuple': {}}
    apt = root / (label + '-apt')
    (apt / 'sources.list.d').mkdir(parents=True)
    (apt / 'sources.list').write_text('deb http://ports.ubuntu.com/ubuntu-ports resolute main\n')
    select = module.Controller.select_sources
    item.select_sources = lambda root_value=Path('/etc/apt'), observation='initial': select(item, apt, observation)
    archive = item.work / 'archives'
    archive.mkdir(exist_ok=True)
    deb = archive / 'gdb.deb'
    deb.write_bytes(b'abc')
    metadata = f'Package: gdb\nVersion: 15.0\nArchitecture: arm64\nFilename: pool/main/g/gdb/gdb.deb\nSize: 3\nSHA256: {module.sha_file(deb)}\n'
    requested, runs = [], []
    def require(command, phase, *args, **kwargs):
        requested.append((list(command), phase))
        value = solver if phase in {'solver-initial', 'solver-frozen'} else metadata if phase == 'authenticated-metadata' else "'http://ports.ubuntu.com/ubuntu-ports/pool/main/g/gdb/gdb.deb' gdb.deb 3 SHA256:ignored\n" if phase == 'print-uris' else 'Package: gdb\nVersion: 15.0\nArchitecture: arm64\n' if phase == 'deb-identity' else ''
        return module.Result(0, False, value.encode(), b'', len(value.encode()), 0, True, True, True)
    item.require = require
    def run(command, phase, *args, **kwargs):
        assert phase == 'offline-dpkg-install'
        runs.append(list(command))
        return result
    item.run = run
    module.Controller.execute(item)
    exit_code = module.Controller.finish(item)
    summary = json.loads((item.evidence.directory / 'acquisition-summary.json').read_text())
    assert item.commands == [] and len(runs) == 1 and requested
    return exit_code, summary

for label, result in [
    ('install-nonzero', module.Result(1, False, b'', b'', 0, 0, True, True, True)),
    ('install-timeout', module.Result(0, True, b'', b'', 0, 0, True, True, True)),
    ('install-capture', module.Result(0, False, b'', b'', 0, 0, True, True, False)),
    ('install-stdout', module.Result(0, False, b'', b'', 0, 0, False, True, True)),
    ('install-stderr', module.Result(0, False, b'', b'', 0, 0, True, False, True)),
]:
    exit_code, summary = install_case(label, result)
    assert exit_code == 0 and summary['runtime_unchanged'] is True and summary['controls_not_run'] is None
    assert summary['status'] == 'installation-incomplete'
    assert summary['failure_stage'] == summary['stage'] == 'offline-dpkg-install'
    assert summary['acquisition_reason'] == {'code': 'installation-incomplete', 'message': 'offline debugger installation did not complete', 'error_type': 'Result'}

drift = copy.deepcopy(preimage)
drift['runtime'] = {'target': 'drift'}
exit_code, summary = install_case('install-drift', module.Result(1, False, b'', b'', 0, 0, True, True, True), drift)
assert exit_code == 1 and summary['runtime_unchanged'] is False and summary['controls_not_run'] == 'unsafe-or-unknown-postimage'
assert summary['acquisition_reason']['code'] == 'installation-incomplete'

installed = copy.deepcopy(preimage)
installed['packages']['installed']['gdb:arm64'] = {'package': 'gdb:arm64', 'architecture': 'arm64', 'version': '15.0', 'status': 'ii '}
exit_code, summary = install_case('install-success', module.Result(0, False, b'', b'', 0, 0, True, True, True), installed, finish_gdb=True)
assert exit_code == 0 and summary['runtime_unchanged'] is True and summary['acquisition_reason'] is None
exit_code, summary = install_case('install-success-incomplete-plan', module.Result(0, False, b'', b'', 0, 0, True, True, True), finish_gdb=True)
assert exit_code == 0 and summary['runtime_unchanged'] is True
assert summary['failure_stage'] == 'offline-dpkg-install'
assert summary['acquisition_reason'] == {'code': 'installation-incomplete', 'message': 'frozen debugger plan was incomplete after a successful install exit', 'error_type': 'AcquisitionError'}
print('E4 extracted controls passed')
`
  const result = await runAcquisitionHarness(controller, harness)
  assert(result.success, new TextDecoder().decode(result.stderr))
  assertEquals(
    new TextDecoder().decode(result.stdout).trim(),
    'E4 extracted controls passed',
  )
})

async function sha256(text: string): Promise<string> {
  const bytes = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(text),
  )
  return [...new Uint8Array(bytes)].map((byte) =>
    byte.toString(16).padStart(2, '0')
  ).join('')
}

Deno.test('baseline runtime verifier admits only the proof-bound runtime subset', async () => {
  const root = await Deno.makeTempDir({ prefix: 'slv-baseline-runtime-' })
  const target = 'x86_64-unknown-linux-gnu'
  const sourceReceiptPath = `${root}/source-receipt.json`
  const proofPath = `${root}/native-proof.json`
  const runtimeDirectory = `${root}/runtime`
  const transport = `${runtimeDirectory}/transport`
  const denort = 'baseline source-built runtime'
  const bridge = 'baseline source-built standalone bridge'
  const derivedLock = 'baseline derived lock'
  const certificate = 'baseline TLS certificate'
  const privateKey = 'baseline TLS private key'
  const rootCertificate = 'baseline TLS root certificate'
  try {
    await Deno.mkdir(transport, { recursive: true })
    await Deno.writeTextFile(`${transport}/baseline-denort`, denort)
    await Deno.writeTextFile(`${transport}/baseline-bridge`, bridge)
    await Deno.writeTextFile(
      `${transport}/baseline-derived-relink-Cargo.lock`,
      derivedLock,
    )
    await Deno.writeTextFile(`${transport}/tls-localhost.crt`, certificate)
    await Deno.writeTextFile(`${transport}/tls-localhost.key`, privateKey)
    await Deno.writeTextFile(`${transport}/tls-root-ca.pem`, rootCertificate)
    const baselineHash = await sha256(denort)
    const bridgeHash = await sha256(bridge)
    const derivedLockHash = await sha256(derivedLock)
    const certificateHash = await sha256(certificate)
    const privateKeyHash = await sha256(privateKey)
    const rootCertificateHash = await sha256(rootCertificate)
    const selectedLock =
      '09afc50a2481cea2e77e0d27eff26db844362067bfbc51357f3927d49cbf815d'
    const sourceReceipt = {
      schema_version: 1,
      kind: 'slv-source-materials',
      source: { commit: SHA },
      runtime_security: { selected: { cargo_lock: { sha256: selectedLock } } },
    }
    await Deno.writeTextFile(sourceReceiptPath, JSON.stringify(sourceReceipt))
    const sourceReceiptHash = await sha256(JSON.stringify(sourceReceipt))
    const artifacts = {
      baseline: {
        denort_sha256: baselineHash,
        bridge_standalone_sha256: bridgeHash,
        derived_relink_cargo_lock_sha256: derivedLockHash,
      },
    }
    const manifest = {
      schema_version: 1,
      kind: 'slv-source-native-transport',
      target,
      source_receipt_sha256: sourceReceiptHash,
      artifacts,
      entries: {
        'baseline-denort': {
          path: 'baseline-denort',
          sha256: baselineHash,
          size: denort.length,
        },
        'baseline-bridge': {
          path: 'baseline-bridge',
          sha256: bridgeHash,
          size: bridge.length,
        },
        'baseline-derived-relink-Cargo.lock': {
          path: 'baseline-derived-relink-Cargo.lock',
          sha256: derivedLockHash,
          size: derivedLock.length,
        },
        'tls-localhost.crt': {
          path: 'tls-localhost.crt',
          sha256: certificateHash,
          size: certificate.length,
        },
        'tls-localhost.key': {
          path: 'tls-localhost.key',
          sha256: privateKeyHash,
          size: privateKey.length,
        },
        'tls-root-ca.pem': {
          path: 'tls-root-ca.pem',
          sha256: rootCertificateHash,
          size: rootCertificate.length,
        },
      },
    }
    await Deno.writeTextFile(
      `${transport}/manifest.json`,
      JSON.stringify(manifest),
    )
    const manifestHash = await sha256(JSON.stringify(manifest))
    const buildReceipt = {
      schema_version: 1,
      kind: 'slv-source-build-receipt',
      target,
      source_commit: SHA,
      source_receipt_sha256: sourceReceiptHash,
      source_selected_cargo_lock_sha256: selectedLock,
      transport: {
        manifest: 'transport/manifest.json',
        manifest_sha256: manifestHash,
      },
      artifacts,
    }
    await Deno.writeTextFile(
      `${runtimeDirectory}/build-receipt.json`,
      JSON.stringify(buildReceipt),
    )
    const buildReceiptHash = await sha256(JSON.stringify(buildReceipt))
    const proof = {
      schema_version: 1,
      kind: 'slv-source-target-proof',
      status: 'passed',
      target,
      source_commit: SHA,
      source_receipt_sha256: sourceReceiptHash,
      source_selected_cargo_lock_sha256: selectedLock,
      build_receipt_sha256: buildReceiptHash,
      artifacts,
    }
    await Deno.writeTextFile(proofPath, JSON.stringify(proof))

    const verified = await verifyBaselineRuntime(
      target,
      SHA,
      sourceReceiptPath,
      proofPath,
      runtimeDirectory,
    )
    assertEquals(verified.baselineDenortSha256, baselineHash)
    assertEquals(verified.baselineBridgeSha256, bridgeHash)
    assertEquals(verified.derivedRelinkCargoLockSha256, derivedLockHash)
    assertEquals(
      verified.runtimePath,
      await Deno.realPath(`${transport}/baseline-denort`),
    )
    assertEquals(
      verified.bridgePath,
      await Deno.realPath(`${transport}/baseline-bridge`),
    )

    await Deno.writeTextFile(
      `${transport}/baseline-bridge`,
      'substituted bridge',
    )
    await assertRejects(
      () =>
        verifyBaselineRuntime(
          target,
          SHA,
          sourceReceiptPath,
          proofPath,
          runtimeDirectory,
        ),
      Error,
      'baseline bridge differs from runtime transport manifest',
    )
    await Deno.writeTextFile(`${transport}/baseline-bridge`, bridge)

    await Deno.writeTextFile(`${transport}/untrusted-bridge`, bridge)
    await assertRejects(
      () =>
        verifyBaselineRuntime(
          target,
          SHA,
          sourceReceiptPath,
          proofPath,
          runtimeDirectory,
        ),
      Error,
      'product runtime has an unexpected transport subset',
    )
    await Deno.remove(`${transport}/untrusted-bridge`)

    await Deno.writeTextFile(
      `${transport}/tls-localhost.crt`,
      'substituted TLS certificate',
    )
    await assertRejects(
      () =>
        verifyBaselineRuntime(
          target,
          SHA,
          sourceReceiptPath,
          proofPath,
          runtimeDirectory,
        ),
      Error,
      'runtime transport manifest does not bind tls-localhost.crt',
    )
    await Deno.writeTextFile(`${transport}/tls-localhost.crt`, certificate)

    await Deno.writeTextFile(
      `${transport}/tls-root-ca.pem`,
      'substituted TLS root certificate',
    )
    await assertRejects(
      () =>
        verifyBaselineRuntime(
          target,
          SHA,
          sourceReceiptPath,
          proofPath,
          runtimeDirectory,
        ),
      Error,
      'runtime transport manifest does not bind tls-root-ca.pem',
    )
    await Deno.writeTextFile(`${transport}/tls-root-ca.pem`, rootCertificate)

    await Deno.remove(`${transport}/tls-root-ca.pem`)
    await assertRejects(
      () =>
        verifyBaselineRuntime(
          target,
          SHA,
          sourceReceiptPath,
          proofPath,
          runtimeDirectory,
        ),
      Error,
      'product runtime has an unexpected transport subset',
    )
    await Deno.writeTextFile(`${transport}/tls-root-ca.pem`, rootCertificate)

    await Deno.writeTextFile(
      `${transport}/baseline-denort`,
      'substituted runtime',
    )
    await assertRejects(
      () =>
        verifyBaselineRuntime(
          target,
          SHA,
          sourceReceiptPath,
          proofPath,
          runtimeDirectory,
        ),
      Error,
      'baseline runtime differs',
    )
  } finally {
    await Deno.remove(root, { recursive: true })
  }
})

Deno.test('resolver accepts only an advancing main source with usable before and after', async () => {
  const result = await resolveRelease(
    runtime({
      EVENT: 'push',
      REF: 'refs/heads/main',
      GITHUB_REPOSITORY: 'ValidatorsDAO/slv',
      SLV_LINUX_BUILDERS_ENABLED: 'true',
      GITHUB_WORKFLOW_SHA: SHA,
      GITHUB_WORKFLOW_REF:
        'ValidatorsDAO/slv/.github/workflows/slv-remote-build.yml@refs/heads/main',
      GITHUB_SHA: SHA,
      BEFORE,
      AFTER: SHA,
    }, {
      'git rev-parse HEAD': ok(SHA),
      [`git show ${BEFORE}:cmn/constants/version.ts`]: ok(
        versionFile('2026.6.6.2025'),
      ),
      [`git show ${SHA}:cmn/constants/version.ts`]: ok(
        versionFile('2026.6.6.2026'),
      ),
      [`git show -s --format=%cI ${SHA}`]: ok('2026-06-06T20:26:00+00:00'),
    }),
    'absent',
  )
  assertEquals(result.mode, 'main-release')
  assertEquals(result.source_ref, 'refs/heads/main')
  assertEquals(result.publication, 'initial')
  const rerun = await resolveRelease(
    runtime({
      EVENT: 'push',
      REF: 'refs/heads/main',
      GITHUB_REPOSITORY: 'ValidatorsDAO/slv',
      SLV_LINUX_BUILDERS_ENABLED: 'true',
      GITHUB_WORKFLOW_SHA: SHA,
      GITHUB_WORKFLOW_REF:
        'ValidatorsDAO/slv/.github/workflows/slv-remote-build.yml@refs/heads/main',
      GITHUB_SHA: SHA,
      BEFORE,
      AFTER: SHA,
    }, {
      'git rev-parse HEAD': ok(SHA),
      [`git show ${BEFORE}:cmn/constants/version.ts`]: ok(
        versionFile('2026.6.6.2025'),
      ),
      [`git show ${SHA}:cmn/constants/version.ts`]: ok(
        versionFile('2026.6.6.2026'),
      ),
      [`git show -s --format=%cI ${SHA}`]: ok('2026-06-06T20:26:00+00:00'),
    }),
    'immutable',
  )
  assertEquals(rerun.publication, 'verify')
  assertEquals(rerun.release_required, false)
  await assertRejects(
    () =>
      resolveRelease(
        runtime({
          EVENT: 'push',
          REF: 'refs/heads/main',
          GITHUB_REPOSITORY: 'ValidatorsDAO/slv',
          SLV_LINUX_BUILDERS_ENABLED: 'true',
          GITHUB_WORKFLOW_SHA: SHA,
          GITHUB_WORKFLOW_REF:
            'ValidatorsDAO/slv/.github/workflows/slv-remote-build.yml@refs/heads/main',
          GITHUB_SHA: SHA,
          BEFORE,
          AFTER: SHA,
        }, {
          'git rev-parse HEAD': ok(SHA),
          [`git show ${BEFORE}:cmn/constants/version.ts`]: ok(
            versionFile('2026.6.6.2027'),
          ),
          [`git show ${SHA}:cmn/constants/version.ts`]: ok(
            versionFile('2026.6.6.2026'),
          ),
          [`git show -s --format=%cI ${SHA}`]: ok('2026-06-06T20:26:00+00:00'),
        }),
        'absent',
      ),
    Error,
    'must advance',
  )
})

Deno.test('resolver binds an annotated tag push to its peeled source commit', async () => {
  const ref = 'refs/tags/v2026.6.6.2026'
  const result = await resolveRelease(
    runtime({
      EVENT: 'push',
      REF: ref,
      GITHUB_SHA: SHA,
    }, {
      [`git rev-parse ${ref}`]: ok(TAG_SHA),
      [`git rev-parse ${ref}^{}`]: ok(SHA),
      [`git show ${SHA}:cmn/constants/version.ts`]: ok(
        versionFile('2026.6.6.2026'),
      ),
      [`git merge-base --is-ancestor ${SHA} origin/main`]: ok(),
      [`git show -s --format=%cI ${SHA}`]: ok('2026-06-06T20:26:00+00:00'),
    }),
    'immutable',
  )
  assertEquals(result.mode, 'tag-release')
  assertEquals(result.source_sha, SHA)
  assertEquals(result.source_ref, ref)
  assertEquals(result.publication, 'verify')
  await assertRejects(
    () =>
      resolveRelease(
        runtime({
          EVENT: 'push',
          REF: ref,
          GITHUB_SHA: TAG_SHA,
        }, {
          [`git rev-parse ${ref}`]: ok(TAG_SHA),
          [`git rev-parse ${ref}^{}`]: ok(SHA),
        }),
        'absent',
      ),
    Error,
    'exact pushed tag commit',
  )
})

Deno.test('resolver binds tags and dispatch to their exact selected source', async () => {
  const ref = 'refs/tags/v2026.6.6.2026'
  const result = await resolveRelease(
    runtime({
      EVENT: 'workflow_dispatch',
      REF: ref,
      GITHUB_SHA: SHA,
      INPUT_VERSION: '2026.6.6.2026',
    }, {
      [`git rev-parse ${ref}^{}`]: ok(SHA),
      [`git show ${SHA}:cmn/constants/version.ts`]: ok(
        versionFile('2026.6.6.2026'),
      ),
      [`git merge-base --is-ancestor ${SHA} origin/main`]: ok(),
      [`git show -s --format=%cI ${SHA}`]: ok('2026-06-06T20:26:00+00:00'),
    }),
    'immutable',
  )
  assertEquals(result.mode, 'tag-recovery')
  assertEquals(result.publication, 'verify')
  await assertRejects(
    () =>
      resolveRelease(
        runtime({
          EVENT: 'workflow_dispatch',
          REF: 'refs/heads/main',
          GITHUB_SHA: SHA,
          INPUT_VERSION: '2026.6.6.2026',
        }, {}),
        'absent',
      ),
    Error,
    'selected exact release tag',
  )
})

Deno.test('PR resolver binds CI packaging to the checked-out merge commit without publishing', async () => {
  const mergeSha = 'd'.repeat(40)
  const result = await resolveRelease(
    runtime({
      EVENT: 'pull_request',
      REF: 'refs/pull/42/merge',
      GITHUB_SHA: mergeSha,
    }, {
      ['git rev-parse HEAD']: ok(mergeSha),
      [`git show ${mergeSha}:cmn/constants/version.ts`]: ok(
        versionFile('2026.6.6.2026'),
      ),
      [`git show -s --format=%cI ${mergeSha}`]: ok('2026-06-06T20:26:00+00:00'),
    }),
    'absent',
  )
  assertEquals(result, {
    mode: 'ci',
    linux_validation: false,
    release_required: false,
    version: '2026.6.6.2026',
    tag: '',
    source_sha: mergeSha,
    source_ref: 'refs/pull/42/merge',
    source_timestamp: '2026-06-06T20:26:00+00:00',
    publication: 'none',
  })
  await assertRejects(
    () =>
      resolveRelease(
        runtime({
          EVENT: 'pull_request',
          REF: 'refs/pull/42/head',
          GITHUB_SHA: mergeSha,
        }, {}),
        'absent',
      ),
    Error,
    'merge ref',
  )
  await assertRejects(
    () =>
      resolveRelease(
        runtime({
          EVENT: 'pull_request',
          REF: 'refs/pull/42/merge',
          GITHUB_SHA: mergeSha,
        }, { ['git rev-parse HEAD']: ok(SHA) }),
        'absent',
      ),
    Error,
    'checked-out merge commit',
  )
})

Deno.test('publisher planning rejects draft conflicts and switches immutable releases to verify-only', () => {
  const staged = new Map([['install', '1'.repeat(64)]])
  assertEquals(planDraftRecovery('immutable', [], staged), {
    action: 'verify',
    upload: [],
  })
  const recovery = planDraftRecovery('draft', [{
    name: 'install',
    sha256: '1'.repeat(64),
  }], staged)
  assertEquals(recovery.action, 'recover')
  assertEquals(recovery.upload.includes('install'), false)
  assertThrows(
    () =>
      planDraftRecovery(
        'draft',
        [{ name: 'install', sha256: '2'.repeat(64) }],
        staged,
      ),
    Error,
    'differs',
  )
  assertThrows(
    () => planDraftRecovery('draft', [{ name: 'unexpected.bin' }], staged),
    Error,
    'unexpected',
  )
  assertEquals(publicationFor('immutable'), {
    releaseRequired: false,
    publication: 'verify',
  })
})

Deno.test('draft recovery only accepts the original manifest artifact attempt', async () => {
  const root = await Deno.makeTempDir({ prefix: 'slv-draft-manifest-' })
  try {
    const assets = payloadSpecs().map((spec) => ({
      ...spec,
      sha256: 'd'.repeat(64),
      size: 1,
    }))
    const original = manifest(
      '2026.6.6.2026',
      SHA,
      'refs/heads/main',
      '12',
      '1',
      assets,
    )
    const rerun = manifest(
      '2026.6.6.2026',
      SHA,
      'refs/heads/main',
      '12',
      '2',
      assets,
    )
    const existing = `${root}/existing.json`
    const staged = `${root}/staged.json`
    await Deno.writeTextFile(existing, JSON.stringify(original))
    await Deno.writeTextFile(staged, JSON.stringify(original))
    await guardDraftManifest(existing, staged)
    for (
      const altered of [
        { ...original, unknown: true },
        { ...original, schema_version: 2 },
        { ...original, runtime_qualification: { state: 'final-qualified' } },
      ]
    ) {
      await Deno.writeTextFile(staged, JSON.stringify(altered))
      await assertRejects(() => guardDraftManifest(existing, staged))
    }
    await Deno.writeTextFile(staged, JSON.stringify(rerun))
    await assertRejects(
      () => guardDraftManifest(existing, staged),
      Error,
      'original package artifact',
    )
  } finally {
    await Deno.remove(root, { recursive: true })
  }
})

Deno.test('source-build-validation requires exact reviewed workflow and source without publication', async () => {
  const ref = 'refs/heads/codex/slv-linux-ephemeral-release'
  const values = {
    EVENT: 'workflow_dispatch',
    REF: ref,
    GITHUB_SHA: SHA,
    INPUT_OPERATION: 'source-build-validation',
    INPUT_REVIEWED_SHA: SHA,
    GITHUB_REPOSITORY: 'ValidatorsDAO/slv',
    GITHUB_WORKFLOW_SHA: SHA,
    GITHUB_WORKFLOW_REF:
      `ValidatorsDAO/slv/.github/workflows/slv-remote-build.yml@${ref}`,
  }
  const responses = {
    'git rev-parse HEAD': ok(SHA),
    [`git show -s --format=%cI ${SHA}`]: ok('2026-10-18T00:00:00Z'),
  }
  const resolved = await resolveRelease(runtime(values, responses), 'absent')
  assertEquals(resolved.mode, 'source-build-validation')
  assertEquals(resolved.linux_validation, true)
  assertEquals(resolved.release_required, false)
  assertEquals(resolved.publication, 'none')
  assertEquals(resolved.source_sha, SHA)
  for (
    const overrides of [
      { EVENT: 'push' },
      { EVENT: 'pull_request' },
      { GITHUB_REPOSITORY: 'other/slv' },
      { INPUT_REVIEWED_SHA: SHA.slice(0, 12) },
      { INPUT_REVIEWED_SHA: BEFORE },
      { GITHUB_SHA: BEFORE },
      { GITHUB_WORKFLOW_SHA: BEFORE },
      { GITHUB_WORKFLOW_REF: 'other/workflow' },
      { REF: 'refs/heads/main' },
    ]
  ) {
    await assertRejects(() =>
      resolveRelease(runtime({ ...values, ...overrides }, responses), 'absent')
    )
  }
  await assertRejects(() =>
    resolveRelease(
      runtime(values, { ...responses, 'git rev-parse HEAD': ok(BEFORE) }),
      'absent',
    )
  )
})

Deno.test('validation resolver CLI emits no publication and never queries release credentials', async () => {
  const directory = await Deno.makeTempDir({
    prefix: 'slv-validation-resolver-',
  })
  try {
    const bin = `${directory}/bin`
    await Deno.mkdir(bin)
    await Deno.writeTextFile(
      `${bin}/git`,
      `#!/bin/sh\ncase "$*" in\n  'rev-parse HEAD') printf '%s\\n' '${SHA}' ;;\n  'show -s --format=%cI ${SHA}') printf '%s\\n' '2026-10-18T00:00:00+00:00' ;;\n  *) exit 91 ;;\nesac\n`,
    )
    await Deno.writeTextFile(
      `${bin}/gh`,
      `#!/bin/sh\nprintf forbidden > '${directory}/gh-called'\nexit 92\n`,
    )
    await Deno.chmod(`${bin}/git`, 0o755)
    await Deno.chmod(`${bin}/gh`, 0o755)
    const outputPath = `${directory}/output`
    const ref = 'refs/heads/codex/slv-linux-ephemeral-release'
    const result = await new Deno.Command(Deno.execPath(), {
      args: [
        'run',
        '--frozen',
        '--allow-read',
        '--allow-write',
        '--allow-env',
        '--allow-run',
        new URL('./workflow.ts', import.meta.url).pathname,
        'resolve',
      ],
      clearEnv: true,
      env: {
        PATH: `${bin}:${Deno.env.get('PATH') ?? ''}`,
        HOME: Deno.env.get('HOME') ?? '',
        ...(Deno.env.get('DENO_DIR')
          ? { DENO_DIR: Deno.env.get('DENO_DIR')! }
          : {}),
        EVENT: 'workflow_dispatch',
        REF: ref,
        GITHUB_SHA: SHA,
        INPUT_OPERATION: 'source-build-validation',
        INPUT_REVIEWED_SHA: SHA,
        GITHUB_REPOSITORY: 'ValidatorsDAO/slv',
        GITHUB_WORKFLOW_SHA: SHA,
        GITHUB_WORKFLOW_REF:
          `ValidatorsDAO/slv/.github/workflows/slv-remote-build.yml@${ref}`,
        GITHUB_OUTPUT: outputPath,
      },
      stdout: 'piped',
      stderr: 'piped',
    }).output()
    assert(result.success, new TextDecoder().decode(result.stderr))
    const output = await Deno.readTextFile(outputPath)
    for (
      const field of [
        'mode=source-build-validation',
        'linux_validation=true',
        'release_required=false',
        'publication=none',
        `source_sha=${SHA}`,
      ]
    ) assert(output.split('\n').includes(field))
    await assertRejects(
      () => Deno.stat(`${directory}/gh-called`),
      Deno.errors.NotFound,
    )
  } finally {
    await Deno.remove(directory, { recursive: true })
  }
})

const productNeeds = [
  'resolve',
  'test',
  'source-materials',
  'source-native-linux-x64',
  'source-native-macos-x64',
  'source-native-macos-arm64',
  'source-arm-build',
  'source-arm-merge',
]
const linuxProductRows = [
  { target: 'x86_64-unknown-linux-gnu', runner: 'ubuntu-26.04', apple: false },
  {
    target: 'aarch64-unknown-linux-gnu',
    runner: 'ubuntu-26.04-arm',
    apple: false,
  },
]
const ordinaryProductRows = [
  ...linuxProductRows,
  { target: 'x86_64-apple-darwin', runner: 'macos-15-intel', apple: true },
  { target: 'aarch64-apple-darwin', runner: 'macos-15', apple: true },
]
type ProductNeeds = Record<
  string,
  { result: string; outputs: Record<string, string> }
>

function productNeedsFixture(validation = true): ProductNeeds {
  const needs: ProductNeeds = Object.fromEntries(
    productNeeds.map((job, index) => [job, {
      result: validation && job.startsWith('source-native-macos-')
        ? 'skipped'
        : 'success',
      outputs: {
        artifact_id: String(100 + index),
        artifact_digest: `sha256:${'d'.repeat(64)}`,
        producer_run_id: '123',
        producer_attempt: '2',
        proof_sha256: 'e'.repeat(64),
        receipt_sha256: 'f'.repeat(64),
        runtime_artifact_id: String(200 + index),
        runtime_artifact_digest: 'a'.repeat(64),
        build_receipt_sha256: 'b'.repeat(64),
        baseline_runtime_sha256: 'c'.repeat(64),
        baseline_derived_lock_sha256: 'd'.repeat(64),
      },
    }]),
  )
  if (validation) {
    needs['source-native-macos-x64'].outputs = {}
    needs['source-native-macos-arm64'].outputs = {}
  }
  needs.resolve.outputs = {
    linux_validation: validation ? 'true' : 'false',
    release_required: validation ? 'false' : 'true',
    source_sha: SHA,
    version: '',
    tag: '',
    publication: 'none',
  }
  needs.test.outputs = {
    license_artifact_id: '301',
    license_artifact_digest: 'e'.repeat(64),
    license_producer_run_id: '123',
    license_producer_attempt: '1',
    license_notice_sha256: 'f'.repeat(64),
  }
  return needs
}

function productExpression(
  expression: string,
  needs: ProductNeeds,
  options: {
    cancelled?: boolean
    event?: string
    operation?: string
    target?: string
  } = {},
) {
  return new Function(
    'needs',
    'github',
    'inputs',
    'matrix',
    'cancelled',
    'fromJSON',
    'format',
    `return (${expression.replace(/needs\.([\w-]+)/g, 'needs["$1"]')})`,
  )(
    needs,
    {
      event_name: options.event ?? 'workflow_dispatch',
      run_id: '123',
      run_attempt: '3',
    },
    { operation: options.operation ?? 'source-build-validation' },
    { target: options.target ?? linuxProductRows[0].target },
    () => options.cancelled ?? false,
    JSON.parse,
    (value: string, ...args: string[]) =>
      value.replace(/\{(\d+)\}/g, (_, n) => args[Number(n)]),
  )
}

Deno.test('Linux validation product routing requires six successful Linux prerequisites and two skipped Macs', async () => {
  const workflow = await releaseWorkflow()
  const build = jobSection(workflow, 'source-validation-products')
  const condition = jobIf(build)?.match(/^\$\{\{ (.*) \}\}$/)?.[1]
  const matrix = build.match(/^        include: \$\{\{ (.+) \}\}$/m)?.[1]
  assert(condition && matrix)
  assertEquals(
    build.match(/    needs: \[([\s\S]*?)\]/)?.[1].match(/[\w-]+/g),
    productNeeds,
  )
  const shell = stepShell(
    build,
    'Require the exact native product prerequisites',
  )
  const accepted = productNeedsFixture()
  for (
    const job of [
      'source-macos-x64-baseline',
      'source-macos-x64-modified',
      'source-native-macos-x64',
      'source-native-macos-arm64',
      'package',
      'attest',
      'publish',
      'activation-required',
      'verify-existing',
      'legacy-bootstrap',
    ]
  ) {
    const excluded = jobIf(jobSection(workflow, job))?.match(
      /^\$\{\{ (.*) \}\}$/,
    )?.[1]
    assert(excluded, job)
    assertEquals(productExpression(excluded, accepted), false, job)
  }
  assertEquals(productExpression(condition, accepted), true)
  assertEquals(productExpression(matrix, accepted), linuxProductRows)
  assert((await runPrerequisiteShell(shell, JSON.stringify(accepted))).success)
  assertEquals(
    productExpression(condition, accepted, { cancelled: true }),
    false,
  )
  assertEquals(
    productExpression(condition, productNeedsFixture(false), {
      operation: 'source-native-diagnostic',
    }),
    false,
  )
  for (const job of productNeeds) {
    for (
      const result of [
        'failure',
        'cancelled',
        job.includes('macos') ? 'success' : 'skipped',
      ]
    ) {
      const invalid = structuredClone(accepted)
      invalid[job].result = result
      assertEquals(
        productExpression(condition, invalid),
        false,
        `${job}:${result}`,
      )
      assert(
        !(await runPrerequisiteShell(shell, JSON.stringify(invalid))).success,
        `${job}:${result}`,
      )
    }
    const missing = structuredClone(accepted)
    delete missing[job]
    assert(
      !(await runPrerequisiteShell(shell, JSON.stringify(missing))).success,
      job,
    )
  }
  for (
    const invalid of [
      'null',
      '[]',
      '{}',
      JSON.stringify(accepted) + '\n{}',
      JSON.stringify({ ...accepted, extra: { result: 'success' } }),
    ]
  ) {
    assert(!(await runPrerequisiteShell(shell, invalid)).success, invalid)
  }
  const normal = productNeedsFixture(false)
  assertEquals(
    productExpression(condition, normal, { operation: 'release' }),
    false,
  )
  assertEquals(productExpression(matrix, normal), linuxProductRows)
  assert((await runPrerequisiteShell(shell, JSON.stringify(normal))).success)
  normal.resolve.outputs.release_required = 'false'
  assertEquals(
    productExpression(condition, normal, { event: 'pull_request' }),
    false,
  )
  assertEquals(productExpression(condition, normal, { event: 'push' }), false)
  for (const job of productNeeds.filter((job) => job.includes('macos'))) {
    const invalid = structuredClone(normal)
    invalid[job].result = 'skipped'
    assertEquals(
      productExpression(condition, invalid, { event: 'pull_request' }),
      false,
    )
    assert(
      !(await runPrerequisiteShell(shell, JSON.stringify(invalid))).success,
    )
  }
})

Deno.test('Linux validation selects only exact current-run artifact identities and persisted attempts', async () => {
  const build = jobSection(
    await releaseWorkflow(),
    'source-validation-products',
  )
  const shell = stepShell(
    build,
    'Validate exact Linux validation artifact identities',
  )
  const needs = productNeedsFixture()
  const expression = build.match(
    /      - name: Download exact target proof records[\s\S]*?artifact-ids: \$\{\{ (.+) \}\}/,
  )?.[1]
  assert(expression)
  assertEquals(productExpression(expression, needs), '102,103,107')
  assertEquals(
    productExpression(expression, productNeedsFixture(false)),
    '102,103,104,105,107',
  )
  const run = (
    input: ProductNeeds,
    target: string,
    extra: Record<string, string> = {},
  ) =>
    runDiagnosticGuard(shell, {
      NEEDS_JSON: JSON.stringify(input),
      TARGET: target,
      CURRENT_RUN_ID: '123',
      CURRENT_RUN_ATTEMPT: '3',
      ...extra,
    })
  for (const { target } of linuxProductRows) {
    const activeDownloads = build.split('      - ').filter((step) => {
      if (!step.includes('uses: actions/download-artifact@')) return false
      const condition = step.match(/^        if: (.+)$/m)?.[1]
      return !condition || productExpression(condition, needs, { target })
    })
    const selectedIds = activeDownloads.flatMap((step) => {
      const value = step.match(/^          artifact-ids: (.+)$/m)?.[1]
      assert(value)
      return value.replace(
        /\$\{\{ (.+?) \}\}/g,
        (_, expression) => productExpression(expression, needs, { target }),
      ).split(',')
    })
    assertEquals(selectedIds, [
      '301',
      '102',
      '103',
      '107',
      target.startsWith('x86_64') ? '203' : '206',
    ])
    assertEquals(activeDownloads.length, 3)
    assert((await run(needs, target)).success)
    const runtimeJob = target.startsWith('x86_64')
      ? 'source-native-linux-x64'
      : 'source-arm-build'
    const identities = [
      ['test', 'license_', 'license_artifact_id', 'license_artifact_digest'],
      ['source-materials', '', 'artifact_id', 'artifact_digest'],
      ['source-native-linux-x64', '', 'artifact_id', 'artifact_digest'],
      ['source-arm-merge', '', 'artifact_id', 'artifact_digest'],
      [runtimeJob, '', 'runtime_artifact_id', 'runtime_artifact_digest'],
    ]
    for (const [job, prefix, id, digest] of identities) {
      for (
        const [field, values] of [
          [id, ['', '0', '-1', '01', '12,13']],
          [digest, [
            '',
            'sha256:',
            'g'.repeat(64),
            'sha256:sha256:' + 'a'.repeat(64),
          ]],
          [`${prefix}producer_run_id`, ['', '124']],
          [`${prefix}producer_attempt`, ['', '0', '4', '1.5']],
        ] as const
      ) {
        for (const value of values) {
          const invalid = structuredClone(needs)
          invalid[job].outputs[field] = value
          assert(
            !(await run(invalid, target)).success,
            `${target}:${job}:${field}:${value}`,
          )
        }
      }
    }
    for (
      const [job, fields] of [
        ['test', ['license_notice_sha256']],
        ['source-materials', ['receipt_sha256']],
        ['source-native-linux-x64', ['proof_sha256']],
        ['source-arm-merge', ['proof_sha256']],
        [runtimeJob, [
          'build_receipt_sha256',
          'baseline_runtime_sha256',
          'baseline_derived_lock_sha256',
        ]],
      ] as const
    ) {
      for (const field of fields) {
        const invalid = structuredClone(needs)
        invalid[job].outputs[field] = ''
        assert(!(await run(invalid, target)).success, `${job}:${field}`)
      }
    }
    assert(!(await run(needs, target, { CURRENT_RUN_ID: '0' })).success)
    assert(!(await run(needs, target, { CURRENT_RUN_ATTEMPT: '0' })).success)
  }
  assert(!(await run(needs, 'aarch64-apple-darwin')).success)
  assert(build.indexOf(shell) < build.indexOf('actions/download-artifact'))
})

Deno.test('validation compile phase binds proofs and version bytes before its per-row archive consumer', async () => {
  const build = jobSection(
    await releaseWorkflow(),
    'source-validation-products',
  )
  const originalShell = stepShell(
    build,
    'Compile and execute the source-bound native target',
  )
  const directory = await Deno.makeTempDir({
    prefix: 'slv-validation-product-',
  })
  const text = new TextDecoder()
  const sha256 = async (value: string) =>
    [
      ...new Uint8Array(
        await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)),
      ),
    ].map((n) => n.toString(16).padStart(2, '0')).join('')
  try {
    await Deno.mkdir(`${directory}/bin`)
    await Deno.writeTextFile(
      `${directory}/bin/deno`,
      `#!/usr/bin/env python3
import json, os, pathlib, shutil, sys
args = sys.argv[1:]
with open(os.environ['CALLS'], 'a') as log:
    log.write(json.dumps(args) + '\\n')
if args[0] in ('install', 'check'): sys.exit(0)
if args[0] == 'compile':
    assert os.environ['DENORT_BIN'] == os.environ['RUNTIME_PATH']
    shutil.copyfile(os.environ['NATIVE_FIXTURE'], args[args.index('--output') + 1])
    pathlib.Path(args[args.index('--output') + 1]).chmod(0o755)
    sys.exit(0)
script = next(a for a in args if a.endswith('.ts'))
command = args[args.index(script) + 1:]
if command and command[0] == os.environ.get('FAIL_COMMAND'): sys.exit(17)
if command and command[0] == 'verify-baseline-runtime':
    print(pathlib.Path(os.environ['RUNTIME_ENV']).read_text(), end='')
elif command and command[0] == 'source-version': print('2026.10.17.2011')
elif script.endswith('/verify-linux-product.ts'):
    out = pathlib.Path(command[command.index('--out') + 1]); out.mkdir(parents=True)
    (out / 'linux-compatibility-receipt.json').write_text('{}')
elif command and command[0] == 'executable': pathlib.Path(command[2]).write_text('archive')
elif command and command[0] == 'verify-linux-validation':
    target = command[1]
    assert len(command) == 3
    assert pathlib.Path('dist/slv-' + target + '-exe.tar.gz').is_file()
    assert pathlib.Path('dist/release-inputs/product-runtime/' + target + '/product-runtime-receipt.json').is_file()
`,
    )
    await Deno.chmod(`${directory}/bin/deno`, 0o755)
    const native = `${directory}/native`
    await Deno.writeTextFile(
      native,
      `#!/usr/bin/env bash
set -euo pipefail
case "$1" in
  --version) if [ "$LINUX_VALIDATION" = true ]; then test "$NO_COLOR" = 1; fi; printf '%s' "$NATIVE_VERSION" ;;
  licenses) cat dist/release-inputs/THIRD_PARTY_NOTICES ;;
  --help) exit 0 ;;
  *) exit 2 ;;
esac
`,
    )
    for (const { target } of linuxProductRows) {
      const root = `${directory}/${target}`
      const input = `${root}/dist/release-inputs`
      const transport = `${input}/runtime-source/${target}/transport`
      await Deno.mkdir(transport, { recursive: true })
      const runtimePath = `${transport}/baseline-denort`
      const bridgePath = `${transport}/baseline-bridge`
      const runtimeBytes = 'source built runtime'
      const bridgeBytes = '#!/usr/bin/env bash\nexit 0\n'
      await Deno.writeTextFile(runtimePath, runtimeBytes)
      await Deno.writeTextFile(bridgePath, bridgeBytes)
      await Deno.writeTextFile(`${input}/THIRD_PARTY_NOTICES`, 'notices\n')
      const needs = productNeedsFixture()
      for (
        const [relative, job, field] of [
          [
            'source-materials-receipt.json',
            'source-materials',
            'receipt_sha256',
          ],
          [
            'source-proofs/x86_64-unknown-linux-gnu/native-proof.json',
            'source-native-linux-x64',
            'proof_sha256',
          ],
          [
            'source-proofs/aarch64-unknown-linux-gnu/native-proof.json',
            'source-arm-merge',
            'proof_sha256',
          ],
        ]
      ) {
        const path = `${input}/${relative}`
        await Deno.mkdir(path.slice(0, path.lastIndexOf('/')), {
          recursive: true,
        })
        await Deno.writeTextFile(path, relative)
        needs[job].outputs[field] = await sha256(relative)
      }
      const runtimeJob = target.startsWith('x86_64')
        ? 'source-native-linux-x64'
        : 'source-arm-build'
      needs[runtimeJob].outputs.baseline_runtime_sha256 = await sha256(
        runtimeBytes,
      )
      const bindings: Record<string, string> = {
        runtime_path: runtimePath,
        baseline_denort_sha256: await sha256(runtimeBytes),
        bridge_path: bridgePath,
        baseline_bridge_sha256: await sha256(bridgeBytes),
        source_selected_cargo_lock_sha256: 'e'.repeat(64),
        derived_relink_cargo_lock_sha256:
          needs[runtimeJob].outputs.baseline_derived_lock_sha256,
        source_receipt_sha256: needs['source-materials'].outputs.receipt_sha256,
        native_proof_sha256: needs[
          target.startsWith('x86_64')
            ? 'source-native-linux-x64'
            : 'source-arm-merge'
        ].outputs.proof_sha256,
        build_receipt_sha256: needs[runtimeJob].outputs.build_receipt_sha256,
      }
      const envFile = `${root}/verified-runtime.env`
      const log = `${root}/calls.jsonl`
      const shell = originalShell.replace(
        /\$\{\{ (.+?) \}\}/g,
        (_, expression) => productExpression(expression, needs, { target }),
      )
      const run = async (
        inputNeeds = needs,
        overrides: Record<string, string> = {},
      ) => {
        await Deno.writeTextFile(log, '')
        await Deno.writeTextFile(
          envFile,
          Object.entries(bindings).map(([k, v]) => `${k}=${v}\n`).join(''),
        )
        await Deno.chmod(runtimePath, 0o644)
        await Deno.chmod(bridgePath, 0o644)
        await Deno.remove(`${input}/product-runtime`, { recursive: true })
          .catch(() => {})
        const result = await new Deno.Command('bash', {
          args: ['-ceu', shell],
          cwd: root,
          clearEnv: true,
          env: {
            PATH: `${directory}/bin:${Deno.env.get('PATH') ?? ''}`,
            RUNNER_TEMP: `${root}/temp`,
            LINUX_VALIDATION: 'true',
            NEEDS_JSON: JSON.stringify(inputNeeds),
            NATIVE_FIXTURE: native,
            NATIVE_VERSION: 'slv 2026.10.17.2011\n',
            CALLS: log,
            RUNTIME_ENV: envFile,
            RUNTIME_PATH: runtimePath,
            ...overrides,
          },
          stdout: 'piped',
          stderr: 'piped',
        }).output()
        const calls = (await Deno.readTextFile(log)).trim().split('\n').filter(
          Boolean,
        ).map((line) => JSON.parse(line) as string[])
        return { result, calls }
      }
      const valid = await run()
      assert(valid.result.success, text.decode(valid.result.stderr))
      const proofCall = valid.calls.find((args) =>
        args.includes('verify-linux-source-proofs')
      )
      assert(proofCall)
      assertEquals(
        proofCall.slice(proofCall.indexOf('verify-linux-source-proofs') + 1),
        [
          'dist/release-inputs/source-materials-receipt.json',
          'dist/release-inputs/source-materials',
          'dist/release-inputs/source-proofs',
          SHA,
          'source-materials/pins.json',
          'dist/release-inputs/tool-pins',
          'dist/release-inputs/THIRD_PARTY_NOTICES',
        ],
      )
      const consumer = valid.calls.find((args) =>
        args.includes('verify-linux-validation')
      )
      assert(consumer)
      assertEquals(
        consumer.slice(consumer.indexOf('verify-linux-validation') + 1),
        [target, SHA],
      )
      assertEquals(valid.calls.at(-1), consumer)
      assert(!valid.calls.some((args) => args.includes('verify-source-proofs')))
      for (
        const [job, field] of [
          ['source-materials', 'receipt_sha256'],
          ['source-native-linux-x64', 'proof_sha256'],
          ['source-arm-merge', 'proof_sha256'],
          [runtimeJob, 'build_receipt_sha256'],
          [runtimeJob, 'baseline_runtime_sha256'],
          [runtimeJob, 'baseline_derived_lock_sha256'],
        ]
      ) {
        const invalid = structuredClone(needs)
        invalid[job].outputs[field] = '0'.repeat(64)
        const failed = await run(invalid)
        assert(!failed.result.success, `${target}:${field}`)
        assert(!failed.calls.some((args) => args[0] === 'compile'))
        assertEquals((await Deno.stat(runtimePath)).mode! & 0o111, 0)
        assertEquals((await Deno.stat(bridgePath)).mode! & 0o111, 0)
      }
      for (
        const output of [
          'slv wrong\n',
          'slv 2026.10.17.2011',
          'slv 2026.10.17.2011\n\n',
          '\x1b[32mslv 2026.10.17.2011\x1b[0m\n',
        ]
      ) {
        const failed = await run(needs, { NATIVE_VERSION: output })
        assert(!failed.result.success, JSON.stringify(output))
        assert(
          !failed.calls.some((args) =>
            args.includes('verify-linux-validation')
          ),
        )
      }
      for (
        const command of [
          'verify-linux-source-proofs',
          'verify-baseline-runtime',
          'verify-linux-validation',
        ]
      ) {
        const failed = await run(needs, { FAIL_COMMAND: command })
        assert(!failed.result.success, command)
      }
      const normal = await run(needs, { LINUX_VALIDATION: 'false' })
      assert(normal.result.success, text.decode(normal.result.stderr))
      assert(normal.calls.some((args) => args.includes('verify-source-proofs')))
      assert(
        !normal.calls.some((args) =>
          args.includes('verify-linux-source-proofs') ||
          args.includes('source-version') ||
          args.includes('verify-linux-validation')
        ),
      )
    }
  } finally {
    await Deno.remove(directory, { recursive: true })
  }
})

Deno.test('new dispatch modes reject any source, workflow, ref, title or event mismatch', async () => {
  for (
    const operation of ['release-build-validation', 'runtime-qualification']
  ) {
    const ref = operation === 'runtime-qualification'
      ? 'refs/heads/main'
      : 'refs/heads/codex/slv-linux-all-targets'
    const title = operation === 'runtime-qualification'
      ? 'SLV runtime qualification'
      : 'SLV release build validation'
    const values = {
      EVENT: 'workflow_dispatch',
      REF: ref,
      GITHUB_SHA: SHA,
      INPUT_OPERATION: operation,
      INPUT_REVIEWED_SHA: SHA,
      GITHUB_REPOSITORY: 'ValidatorsDAO/slv',
      GITHUB_WORKFLOW_SHA: SHA,
      GITHUB_WORKFLOW_REF:
        `ValidatorsDAO/slv/.github/workflows/slv-remote-build.yml@${ref}`,
      GITHUB_RUN_TITLE: `${title} ${SHA}`,
    }
    const responses = {
      'git rev-parse HEAD': ok(SHA),
      [`git show ${SHA}:cmn/constants/version.ts`]: ok(
        versionFile('2026.10.17.2011'),
      ),
      [`git show -s --format=%cI ${SHA}`]: ok('2026-10-18T00:00:00Z'),
    }
    const resolution = await resolveRelease(
      runtime(values, responses),
      'absent',
    )
    assertEquals(resolution.mode, operation)
    assertEquals(resolution.publication, 'none')
    assertEquals(resolution.release_required, false)
    assertEquals(resolution.linux_validation, false)
    assertEquals(resolution.version, '2026.10.17.2011')
    for (
      const changed of [
        { EVENT: 'push' },
        { EVENT: 'pull_request' },
        { REF: 'refs/heads/other' },
        { GITHUB_REPOSITORY: 'attacker/slv' },
        { GITHUB_SHA: BEFORE },
        { INPUT_REVIEWED_SHA: BEFORE },
        { INPUT_REVIEWED_SHA: SHA.slice(0, 12) },
        { GITHUB_WORKFLOW_SHA: BEFORE },
        {
          GITHUB_WORKFLOW_REF:
            'ValidatorsDAO/slv/.github/workflows/other.yml@' + ref,
        },
        { GITHUB_RUN_TITLE: title },
        { GITHUB_RUN_TITLE: `${title} ${BEFORE}` },
        { INPUT_OPERATION: 'unknown' },
      ]
    ) {
      await assertRejects(() =>
        resolveRelease(runtime({ ...values, ...changed }, responses), 'absent')
      )
    }
    await assertRejects(() =>
      resolveRelease(
        runtime(values, { ...responses, 'git rev-parse HEAD': ok(BEFORE) }),
        'absent',
      )
    )
  }
})

function qualificationNeeds(
  phase: 'runtime' | 'product' | 'package',
  final = false,
): ProductNeeds {
  const names = phase === 'runtime'
    ? ['resolve', 'qualification-inputs', 'qualification-promotion']
    : [
      'resolve',
      'test',
      'source-materials',
      'runtime-qualification',
      ...(phase === 'package' ? currentProductJobs : []),
    ]
  const needs: ProductNeeds = Object.fromEntries(names.map((name, i) => [name, {
    result: 'success',
    outputs: {
      artifact_id: String(i + 10),
      artifact_digest: 'sha256:' + 'd'.repeat(64),
      producer_run_id: '123',
      producer_attempt: '2',
      receipt_sha256: 'e'.repeat(64),
    },
  }]))
  needs.resolve.outputs = {
    mode: final ? 'main-release' : 'release-build-validation',
    release_required: String(final),
    source_sha: SHA,
  }
  if (needs.test) {
    needs.test.outputs = {
      license_artifact_id: '9',
      license_artifact_digest: 'sha256:' + 'b'.repeat(64),
      license_producer_run_id: '123',
      license_producer_attempt: '1',
      license_notice_sha256: 'c'.repeat(64),
    }
  }
  if (needs['qualification-promotion']) {
    needs['qualification-promotion'] = {
      result: final ? 'success' : 'skipped',
      outputs: {},
    }
  }
  if (needs['runtime-qualification']) {
    needs['runtime-qualification'].outputs.qualification_state = final
      ? 'final-qualified'
      : 'candidate-validation'
  }
  return needs
}

Deno.test('actual prerequisite guard rejects missing products, wrong producers and candidate main promotion', () => {
  for (const phase of ['runtime', 'product', 'package'] as const) {
    for (const final of [false, true]) {
      const needs = qualificationNeeds(phase, final)
      const event = final ? 'push' : 'workflow_dispatch',
        ref = final
          ? 'refs/heads/main'
          : 'refs/heads/codex/slv-linux-all-targets'
      const verify = (value: unknown, run = '123', attempt = '3') =>
        verifyWorkflowNeeds(phase, value, run, attempt, event, ref)
      assertEquals(
        verify(needs),
        final ? 'final-qualified' : 'candidate-validation',
      )
      for (const [name, job] of Object.entries(needs)) {
        const missing = structuredClone(needs)
        delete missing[name]
        assertThrows(() => verify(missing))
        for (
          const result of [
            'failure',
            'cancelled',
            job.result === 'success' ? 'skipped' : 'success',
          ]
        ) {
          const bad = structuredClone(needs)
          bad[name].result = result
          assertThrows(() => verify(bad))
        }
        if (name === 'resolve' || name === 'qualification-promotion') continue
        const prefix = name === 'test' ? 'license_' : ''
        for (
          const [field, values] of [
            [prefix + 'artifact_id', ['0', '01', '1,2', '']],
            [prefix + 'artifact_digest', ['', 'sha256:', 'g'.repeat(64)]],
            [prefix + 'producer_run_id', ['0', '124', '']],
            [prefix + 'producer_attempt', ['0', '4', '2.1', '']],
            [name === 'test' ? 'license_notice_sha256' : 'receipt_sha256', [
              '',
              'a'.repeat(63),
            ]],
          ] as const
        ) {
          for (const value of values) {
            const bad = structuredClone(needs)
            bad[name].outputs[field] = value
            assertThrows(() => verify(bad))
          }
        }
      }
      assertThrows(() =>
        verify({ ...needs, unexpected: { result: 'success', outputs: {} } })
      )
      assertThrows(() => verify(needs, '0'))
      assertThrows(() => verify(needs, '123', '0'))
      if (phase !== 'runtime') {
        const bad = structuredClone(needs)
        bad['runtime-qualification'].outputs.qualification_state = final
          ? 'candidate-validation'
          : 'final-qualified'
        assertThrows(() => verify(bad))
      }
      const bad = structuredClone(needs)
      bad.resolve.outputs.mode = 'runtime-qualification'
      assertThrows(() => verify(bad))
    }
  }
})

function evaluateJobExpression(
  expression: string,
  overrides: {
    event?: string
    ref?: string
    mode?: string
    enabled?: string
    repository?: string
    linuxValidation?: string
    required?: string
    needs?: ProductNeeds
  } = {},
) {
  const needs = overrides.needs ?? qualificationNeeds('product', true)
  needs.resolve.outputs = {
    ...needs.resolve.outputs,
    mode: overrides.mode ?? 'main-release',
    linux_validation: overrides.linuxValidation ?? 'false',
    release_required: overrides.required ?? 'true',
  }
  return new Function(
    'github',
    'vars',
    'needs',
    'inputs',
    'cancelled',
    'format',
    'fromJSON',
    `return (${expression.replace(/needs\.([\w-]+)/g, 'needs["$1"]')})`,
  )(
    {
      repository: overrides.repository ?? 'ValidatorsDAO/slv',
      event_name: overrides.event ?? 'push',
      ref: overrides.ref ?? 'refs/heads/main',
      run_id: '123',
      run_attempt: '2',
    },
    { SLV_LINUX_BUILDERS_ENABLED: overrides.enabled ?? 'true' },
    needs,
    { operation: 'release' },
    () => false,
    (value: string, ...args: string[]) =>
      value.replace(/\{(\d+)\}/g, (_, n) => args[Number(n)]),
    JSON.parse,
  )
}

Deno.test('four explicit products use Linux profiles and source qualification never enters ordinary DAG', async () => {
  const workflow = await releaseWorkflow()
  assert(!/^  build:/m.test(workflow))
  const sourceJobs = [
    'source-linux-x64-baseline',
    'source-linux-x64-modified',
    'source-native-linux-x64',
    'source-arm-baseline',
    'source-arm-modified',
    'source-arm-build',
    'source-arm-execute',
    'source-arm-merge',
    'source-macos-x64-baseline',
    'source-macos-x64-modified',
    'source-native-macos-x64',
    'source-native-macos-arm64',
  ]
  for (const job of sourceJobs) {
    const section = jobSection(workflow, job),
      condition = jobIf(section)!.slice(4, -3)
    assertEquals(evaluateJobExpression(condition), false, job)
    assertEquals(
      evaluateJobExpression(condition, {
        event: 'pull_request',
        ref: 'refs/pull/7/merge',
        mode: 'ci',
      }),
      false,
      job,
    )
    assertEquals(
      evaluateJobExpression(condition, {
        event: 'workflow_dispatch',
        mode: 'release-build-validation',
      }),
      false,
      job,
    )
    assertEquals(
      evaluateJobExpression(condition, {
        event: 'workflow_dispatch',
        mode: 'runtime-qualification',
        required: 'false',
      }),
      true,
      job,
    )
    assertEquals(
      evaluateJobExpression(condition, {
        event: 'workflow_dispatch',
        mode: 'source-build-validation',
        linuxValidation: 'true',
        required: 'false',
      }),
      !job.includes('macos'),
      job,
    )
  }
  for (const job of currentProductJobs) {
    const section = jobSection(workflow, job),
      arm = job === 'build-aarch64-unknown-linux-gnu',
      host = arm ? 'ubuntu-26.04-arm' : 'ubuntu-26.04'
    assert(section.includes(`name: ${job}\n`))
    assert(section.includes('timeout-minutes: 30'))
    assert(
      section.includes(
        'needs: [resolve, test, source-materials, runtime-qualification]',
      ),
    )
    assert(!section.includes('strategy:'))
    assert(!section.includes('macos-'))
    assert(!section.includes('source-native-'))
    assert(!section.includes('GH_TOKEN:'))
    assert(!section.includes('id-token: write'))
    assert(!section.includes('environment:'))
    assert(section.includes('persist-credentials: false'))
    const route = section.match(/^    runs-on: \$\{\{ (.+) \}\}$/m)![1],
      profile =
        section.match(/^      PRODUCT_BUILD_PROFILE: \$\{\{ (.+) \}\}$/m)![1]
    assertEquals(evaluateJobExpression(route), `slv-build-123-2-${job}`)
    assertEquals(
      evaluateJobExpression(profile),
      arm ? 'linux-arm64-4' : 'linux-16',
    )
    for (
      const overrides of [
        {
          event: 'pull_request',
          ref: 'refs/pull/7/merge',
          mode: 'ci',
          required: 'false',
        },
        { repository: 'attacker/slv' },
        { event: 'workflow_dispatch', ref: 'refs/tags/v2026.10.17.2011' },
        { ref: 'refs/heads/other' },
        { enabled: 'false' },
        { required: 'false' },
      ]
    ) assertEquals(evaluateJobExpression(route, overrides), host)
    assertEquals(
      evaluateJobExpression(route, {
        event: 'workflow_dispatch',
        ref: 'refs/heads/codex/slv-linux-all-targets',
        mode: 'release-build-validation',
        required: 'false',
        enabled: 'false',
      }),
      `slv-build-123-2-${job}`,
    )
    assert(section.includes('scripts/release/build-product.ts compile'))
    assert(section.includes(`--target ${job.slice(6)}`))
    const packageJob = jobSection(workflow, 'package')
    assert(packageJob.includes(`needs.${job}.outputs.artifact_id`))
  }
  for (const job of ['attest', 'publish']) {
    const section = jobSection(workflow, job)
    assert(section.includes('verify-qualified-publication release'))
    assert(
      section.includes(
        "needs.runtime-qualification.outputs.qualification_state == 'final-qualified'",
      ),
    )
    assert(section.includes('runs-on: ubuntu-26.04'))
  }
  const promotion = jobSection(workflow, 'qualification-promotion')
  assert(promotion.includes('environment: release'))
  assert(promotion.includes('--latest=false'))
  assert(!promotion.includes('--clobber'))
  for (const job of ['qualification-promotion', 'attest', 'publish']) {
    const expression = jobIf(jobSection(workflow, job))!.slice(4, -3)
    assertEquals(
      evaluateJobExpression(expression, {
        event: 'pull_request',
        ref: 'refs/pull/7/merge',
        mode: 'ci',
        required: 'false',
      }),
      false,
    )
    assertEquals(
      evaluateJobExpression(expression, {
        event: 'workflow_dispatch',
        mode: 'release-build-validation',
        required: 'false',
      }),
      false,
    )
  }
})

Deno.test('main release requires actual Linux builder capability while unchanged main and PR remain CI', async () => {
  const values: Record<string, string> = {
    EVENT: 'push',
    REF: 'refs/heads/main',
    GITHUB_SHA: SHA,
    BEFORE,
    AFTER: SHA,
    GITHUB_REPOSITORY: 'ValidatorsDAO/slv',
    GITHUB_WORKFLOW_SHA: SHA,
    GITHUB_WORKFLOW_REF:
      'ValidatorsDAO/slv/.github/workflows/slv-remote-build.yml@refs/heads/main',
    SLV_LINUX_BUILDERS_ENABLED: 'true',
  }
  const responses = {
    'git rev-parse HEAD': ok(SHA),
    [`git show ${SHA}:cmn/constants/version.ts`]: ok(
      versionFile('2026.10.17.2011'),
    ),
    [`git show ${BEFORE}:cmn/constants/version.ts`]: ok(
      versionFile('2026.6.6.2026'),
    ),
    [`git show -s --format=%cI ${SHA}`]: ok('2026-10-18T00:00:00Z'),
  }
  assertEquals(
    (await resolveRelease(runtime(values, responses), 'absent'))
      .release_required,
    true,
  )
  for (const flag of ['', 'false']) {
    await assertRejects(
      () =>
        resolveRelease(
          runtime({ ...values, SLV_LINUX_BUILDERS_ENABLED: flag }, responses),
          'absent',
        ),
      Error,
      'enabled Linux builders',
    )
  }
  const missing = { ...values }
  delete missing.SLV_LINUX_BUILDERS_ENABLED
  await assertRejects(() =>
    resolveRelease(runtime(missing, responses), 'absent')
  )
  for (
    const change of [{ GITHUB_REPOSITORY: 'other/slv' }, {
      GITHUB_WORKFLOW_SHA: BEFORE,
    }, { GITHUB_WORKFLOW_REF: 'other.yml' }] as Record<string, string>[]
  ) {
    await assertRejects(
      () =>
        resolveRelease(runtime({ ...values, ...change }, responses), 'absent'),
      Error,
      'identity',
    )
  }
  const same = {
    ...responses,
    [`git show ${BEFORE}:cmn/constants/version.ts`]:
      responses[`git show ${SHA}:cmn/constants/version.ts`],
  }
  assertEquals(
    (await resolveRelease(runtime(missing, same), 'absent')).mode,
    'ci',
  )
  assertEquals(
    (await resolveRelease(
      runtime(
        { ...missing, EVENT: 'pull_request', REF: 'refs/pull/42/merge' },
        responses,
      ),
      'absent',
    )).mode,
    'ci',
  )
})

Deno.test('dispatch display titles and actual API title read are bound to operation and SHA', async () => {
  const workflow = await releaseWorkflow(),
    expression = workflow.match(/^run-name: \$\{\{ (.+) \}\}$/m)![1]
  const run = (event: string, operation: string) =>
    new Function('github', 'inputs', 'format', `return (${expression})`)(
      { event_name: event },
      { operation, reviewed_sha: SHA },
      (value: string, ...args: string[]) =>
        value.replace(/\{(\d+)\}/g, (_, n) => args[Number(n)]),
    )
  for (
    const [operation, title] of [
      ['source-build-validation', 'SLV Linux source validation'],
      ['release-build-validation', 'SLV release build validation'],
      ['runtime-qualification', 'SLV runtime qualification'],
    ]
  ) assertEquals(run('workflow_dispatch', operation), `${title} ${SHA}`)
  assertEquals(run('push', 'release'), 'SLV verified release')
  const resolver = jobSection(workflow, 'resolve')
  assert(
    resolver.includes(
      'export GITHUB_RUN_TITLE="$(gh api "repos/$GITHUB_REPOSITORY/actions/runs/$GITHUB_RUN_ID" --jq .display_title)"',
    ),
  )
  assert(
    resolver.includes(
      'SLV_LINUX_BUILDERS_ENABLED: ${{ vars.SLV_LINUX_BUILDERS_ENABLED }}',
    ),
  )
})

Deno.test('hosted qualification consumers receive step-scoped read credentials and explicit runner identity', async () => {
  const workflow = await releaseWorkflow()
  for (
    const [job, step] of [
      [
        'qualification-inputs',
        'Audit exact qualification payloads and original producer evidence',
      ],
      [
        'runtime-qualification',
        'Verify qualification signatures, payloads, compatibility and original proofs',
      ],
      ['package', 'Package the complete source-bound product inventory'],
      [
        'attest',
        'Independently reject nonfinal or replayed application payloads',
      ],
    ]
  ) {
    const section = jobSection(workflow, job)
    const start = section.indexOf(`      - name: ${step}\n`)
    assert(start >= 0)
    const end = section.indexOf('\n      - ', start + 1),
      actual = section.slice(start, end < 0 ? undefined : end)
    assert(actual.includes('          GH_TOKEN: ${{ github.token }}'), job)
    assert(actual.includes('--allow-env --allow-net'), job)
    const preSteps = section.slice(0, section.indexOf('    steps:'))
    assert(!preSteps.includes('GH_TOKEN:'), job)
    assert(section.includes('contents: read'), job)
    assert(
      section.includes('attestations: read') ||
        section.includes('attestations: write'),
      job,
    )
  }
  assert(
    jobSection(workflow, 'qualification-promotion').includes(
      '      RUNNER_ENVIRONMENT: ${{ runner.environment }}',
    ),
  )
  for (const job of currentProductJobs) {
    const section = jobSection(workflow, job)
    assert(
      section.includes(
        '          RUNNER_ENVIRONMENT: ${{ runner.environment }}',
      ),
      job,
    )
    assert(!section.includes('GH_TOKEN:'), job)
  }
  // Execute the actual attest guard shell with a credential-checking tool seam;
  // the token here is a fixed test marker, never an operator credential.
  const shell = stepShell(
    jobSection(workflow, 'attest'),
    'Independently reject nonfinal or replayed application payloads',
  ).replace(/\$\{\{ [^}]+ \}\}/g, 'fixture')
  const dir = await Deno.makeTempDir({ prefix: 'slv-attest-env-' })
  try {
    await Deno.writeTextFile(
      `${dir}/deno`,
      `#!/bin/sh\n[ "$GH_TOKEN" = fixture-read-token ] || exit 41\ncase "$*" in *'verify-qualified-publication release fixture fixture fixture fixture'*) exec gh verify ;; *) exit 42 ;; esac\n`,
    )
    await Deno.writeTextFile(
      `${dir}/gh`,
      '#!/bin/sh\n[ "$GH_TOKEN" = fixture-read-token ] || exit 43\n',
    )
    await Deno.chmod(`${dir}/deno`, 0o700)
    await Deno.chmod(`${dir}/gh`, 0o700)
    for (const present of [true, false]) {
      const result = await new Deno.Command('/bin/bash', {
        args: ['-ceu', shell],
        clearEnv: true,
        env: {
          PATH: dir,
          ...(present ? { GH_TOKEN: 'fixture-read-token' } : {}),
        },
        stdout: 'piped',
        stderr: 'piped',
      }).output()
      assertEquals(result.success, present)
    }
  } finally {
    await Deno.remove(dir, { recursive: true })
  }
})

Deno.test('qualification promotion requires activation before any publication work', async () => {
  const section = jobSection(await releaseWorkflow(), 'qualification-promotion')
  const title = 'Require publication activation before qualification promotion'
  assert(section.indexOf(title) < section.indexOf('uses: actions/checkout@'))
  assert(section.includes('ACTIVATED: ${{ vars.SLV_RELEASE_ACTIVATED }}'))
  const shell = stepShell(section, title)
  for (const value of ['true', 'false', '', undefined]) {
    const result = await new Deno.Command('/bin/bash', {
      args: ['-ceu', shell + '\nprintf promotion-allowed'],
      clearEnv: true,
      env: value === undefined ? {} : { ACTIVATED: value },
      stdout: 'piped',
      stderr: 'piped',
    }).output()
    assertEquals(result.success, value === 'true')
    assertEquals(
      new TextDecoder().decode(result.stdout).includes('promotion-allowed'),
      value === 'true',
    )
  }
})

Deno.test('qualification publication resumes only missing assets and verifies complete draft before publish', async () => {
  const section = jobSection(await releaseWorkflow(), 'qualification-promotion')
  assert(section.includes("if: steps.plan.outputs.needs_attestation == 'true'"))
  assert(section.includes("if: steps.plan.outputs.action != 'reuse'"))
  const shell = stepShell(
    section,
    'Publish an immutable nonlatest runtime qualification without overwriting',
  )
  assert(!shell.includes('--clobber'))
  const directory = await Deno.makeTempDir({
    prefix: 'slv-qualification-resume-',
  })
  try {
    const bin = `${directory}/bin`,
      work = `${directory}/work`,
      payload = `${work}/dist/release-inputs/runtime-qualification`
    await Deno.mkdir(bin)
    await Deno.mkdir(payload, { recursive: true })
    await Deno.writeTextFile(`${directory}/bundle`, 'fixture signed bundle')
    for (const name of ['runtime-qualification.json', 'missing-runtime']) {
      await Deno.writeTextFile(`${payload}/${name}`, 'fixture reviewed bytes')
    }
    await Deno.writeTextFile(
      `${bin}/gh`,
      `#!/usr/bin/env python3\nimport json, os, sys\nwith open(os.environ['CALL_LOG'], 'a') as f: f.write(json.dumps(sys.argv[1:])+'\\n')\n`,
    )
    await Deno.writeTextFile(
      `${bin}/deno`,
      `#!/usr/bin/env python3\nimport json, os, sys\nassert 'verify-draft' in sys.argv\nwith open(os.environ['CALL_LOG'], 'a') as f: f.write(json.dumps(['verify-draft'])+'\\n')\nsys.exit(21 if os.environ.get('FAIL_DRAFT') == 'true' else 0)\n`,
    )
    await Deno.chmod(`${bin}/gh`, 0o700)
    await Deno.chmod(`${bin}/deno`, 0o700)
    for (
      const [action, needsAttestation, assets] of [
        ['create', true, ['runtime-qualification.json', 'missing-runtime']],
        ['resume', true, ['missing-runtime']],
        ['resume', false, []],
      ] as const
    ) {
      await Deno.writeTextFile(
        `${work}/promotion-plan.json`,
        JSON.stringify({
          action,
          needs_attestation: needsAttestation,
          assets,
          source_sha: SHA,
          tag: 'runtime-deno-v2.9.3-' + 'c'.repeat(64),
        }),
      )
      for (const failDraft of [false, true]) {
        const log = `${directory}/calls`
        await Deno.writeTextFile(log, '')
        const result = await new Deno.Command('/bin/bash', {
          args: ['-ceu', shell],
          cwd: work,
          clearEnv: true,
          env: {
            PATH: `${bin}:${Deno.env.get('PATH') ?? '/usr/bin:/bin'}`,
            CALL_LOG: log,
            FAIL_DRAFT: String(failDraft),
            GH_REPO: 'ValidatorsDAO/slv',
            GH_TOKEN: 'fixture-token',
            SLV_RELEASE_SOURCE_SHA: SHA,
            GITHUB_WORKSPACE: work,
            RUNNER_ENVIRONMENT: 'github-hosted',
            BUNDLE: needsAttestation ? `${directory}/bundle` : '',
          },
          stdout: 'piped',
          stderr: 'piped',
        }).output()
        assertEquals(
          result.success,
          !failDraft,
          new TextDecoder().decode(result.stderr),
        )
        const calls = (await Deno.readTextFile(log)).trim().split('\n').filter(
          Boolean,
        ).map((x) => JSON.parse(x) as string[])
        assertEquals(
          calls.filter((x) => x[0] === 'release' && x[1] === 'create').length,
          action === 'create' ? 1 : 0,
        )
        const uploads = calls.filter((x) =>
          x[0] === 'release' && x[1] === 'upload'
        )
        assertEquals(uploads.map((x) => x.at(-1)!.split('/').at(-1)), [
          ...assets,
          ...(needsAttestation
            ? ['runtime-qualification.json.intoto.jsonl']
            : []),
        ])
        assertEquals(calls.filter((x) => x[0] === 'verify-draft').length, 1)
        const publish = calls.findIndex((x) =>
          x[0] === 'release' && x[1] === 'edit'
        )
        assertEquals(publish >= 0, !failDraft)
        if (!failDraft) {
          assert(publish > calls.findIndex((x) => x[0] === 'verify-draft'))
        }
      }
    }
  } finally {
    await Deno.remove(directory, { recursive: true })
  }
})
