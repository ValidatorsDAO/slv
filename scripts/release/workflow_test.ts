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
} from './workflow.ts'
import { manifest, payloadSpecs } from './release.ts'

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
  const next = remainder.search(/\n  [a-z][a-z0-9-]*:\n/)
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
    13,
  )
  assertEquals(
    count(
      workflow,
      'artifact-ids: ${{ needs.test.outputs.license_artifact_id }}\n          merge-multiple: true',
    ),
    3,
  )

  const verifyLines = workflow.split('\n').filter((line) =>
    line.includes('release.ts verify-licenses')
  )
  assertEquals(verifyLines.length, 13)
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
      'build',
      'source-materials',
      'source-native-linux-x64',
      'source-native-macos-x64',
      'source-native-macos-arm64',
      'source-arm-build',
      'source-arm-merge',
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

Deno.test('workflow compiles each official target only from its exact source-built baseline runtime', async () => {
  const workflow = await releaseWorkflow()
  const build = jobSection(workflow, 'build')
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
  assert(build.includes('runner: macos-15'))
  assert(!build.includes('runner: macos-14'))
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
        `name: slv-product-${target}-${'${{ github.run_id }}'}`,
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
  assertEquals(count(workflow, ciCondition), 13)
  assertEquals(count(workflow, 'id-token: write'), 1)
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
    ['source-native-linux-x64', 'ubuntu-26.04', 'x86_64-unknown-linux-gnu'],
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
    packageSection.includes(
      'artifact-ids: ${{ needs.source-materials.outputs.artifact_id }},${{ needs.source-native-linux-x64.outputs.artifact_id }},${{ needs.source-native-macos-x64.outputs.artifact_id }},${{ needs.source-native-macos-arm64.outputs.artifact_id }},${{ needs.source-arm-merge.outputs.artifact_id }}',
    ),
  )
  assert(packageSection.includes('merge-multiple: true'))
  assert(
    packageSection.includes(
      'scripts/release/source-materials.ts verify-source-proofs dist/release-inputs/source-materials-receipt.json dist/release-inputs/source-materials dist/release-inputs/source-proofs',
    ),
  )
  assert(
    packageSection.includes(
      'dist/release-inputs/tool-pins dist/release-inputs/THIRD_PARTY_NOTICES',
    ),
  )
  for (
    const target of [
      ...nativeJobs.map(([, , target]) => target),
      'aarch64-unknown-linux-gnu',
    ]
  ) {
    assert(packageSection.includes(`source-proofs/${target}/native-proof.json`))
  }
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
    ],
    [
      'source-arm-modified',
      'ubuntu-26.04',
      'aarch64-unknown-linux-gnu',
      'x86_64-unknown-linux-gnu',
      'modified',
    ],
    [
      'source-macos-x64-baseline',
      'macos-15-intel',
      'x86_64-apple-darwin',
      'x86_64-apple-darwin',
      'baseline',
    ],
    [
      'source-macos-x64-modified',
      'macos-15-intel',
      'x86_64-apple-darwin',
      'x86_64-apple-darwin',
      'modified',
    ],
  ] as const
  for (const [job, runner, target, buildHost, variant] of producerSpecs) {
    const section = jobSection(workflow, job)
    assert(section.includes('needs: [resolve, test, source-materials]'))
    assert(section.includes(`runs-on: ${runner}`))
    assert(section.includes('timeout-minutes: 350'))
    assert(section.includes('contents: read'))
    assert(section.includes(`TARGET: ${target}`))
    assert(section.includes(`BUILD_HOST: ${buildHost}`))
    assert(section.includes(`VARIANT: ${variant}`))
    assert(section.includes('id: variant\n        timeout-minutes: 320'))
    assert(section.includes('--phase build-variant'))
    assert(section.includes('--variant "$VARIANT" --jobs 4'))
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
    assert(
      section.includes(
        "if: ${{ !(github.event_name == 'workflow_dispatch' && inputs.operation == 'source-native-diagnostic') && (!cancelled() && (needs.resolve.outputs.release_required == 'true' || github.event_name == 'pull_request')) }}",
      ),
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

Deno.test('workflow isolates and bounds the fixed ARM native diagnostic operation', async () => {
  const workflow = await releaseWorkflow()
  const diagnosticExclusion =
    "!(github.event_name == 'workflow_dispatch' && inputs.operation == 'source-native-diagnostic')"
  assert(
    workflow.includes(
      'source-native-diagnostic,\n        ]\n      reviewed_sha:',
    ),
  )
  const expectedOldJobs = [
    'legacy-bootstrap',
    'resolve',
    'test',
    'build',
    'source-materials',
    'source-native-linux-x64',
    'source-arm-baseline',
    'source-arm-modified',
    'source-macos-x64-baseline',
    'source-macos-x64-modified',
    'source-native-macos-x64',
    'source-native-macos-arm64',
    'source-arm-build',
    'source-arm-execute',
    'source-arm-merge',
    'package',
    'attest',
    'activation-required',
    'verify-existing',
    'publish',
  ]
  const expectedJobs = [
    ...expectedOldJobs.slice(0, 3),
    'source-native-diagnostic',
    ...expectedOldJobs.slice(3),
  ]
  const jobs = workflow.slice(workflow.indexOf('\njobs:\n'))
  assertEquals(
    [...jobs.matchAll(/^  ([a-z][a-z0-9-]*):\n/gm)].map((match) => match[1]),
    expectedJobs,
  )

  const oldConditions: Array<readonly [string, string | undefined]> = [
    [
      'legacy-bootstrap',
      "github.event_name == 'workflow_dispatch' && (inputs.operation == 'legacy-bootstrap-preflight' || inputs.operation == 'legacy-bootstrap-apply')",
    ],
    [
      'resolve',
      "!(github.event_name == 'workflow_dispatch' && (inputs.operation == 'legacy-bootstrap-preflight' || inputs.operation == 'legacy-bootstrap-apply'))",
    ],
    ['test', undefined],
    [
      'build',
      "needs.resolve.outputs.release_required == 'true' || github.event_name == 'pull_request'",
    ],
    [
      'source-materials',
      "needs.resolve.outputs.release_required == 'true' || github.event_name == 'pull_request'",
    ],
    [
      'source-native-linux-x64',
      "needs.resolve.outputs.release_required == 'true' || github.event_name == 'pull_request'",
    ],
    [
      'source-arm-baseline',
      "needs.resolve.outputs.release_required == 'true' || github.event_name == 'pull_request'",
    ],
    [
      'source-arm-modified',
      "needs.resolve.outputs.release_required == 'true' || github.event_name == 'pull_request'",
    ],
    [
      'source-macos-x64-baseline',
      "needs.resolve.outputs.release_required == 'true' || github.event_name == 'pull_request'",
    ],
    [
      'source-macos-x64-modified',
      "needs.resolve.outputs.release_required == 'true' || github.event_name == 'pull_request'",
    ],
    [
      'source-native-macos-x64',
      "!cancelled() && (needs.resolve.outputs.release_required == 'true' || github.event_name == 'pull_request')",
    ],
    [
      'source-native-macos-arm64',
      "needs.resolve.outputs.release_required == 'true' || github.event_name == 'pull_request'",
    ],
    [
      'source-arm-build',
      "!cancelled() && (needs.resolve.outputs.release_required == 'true' || github.event_name == 'pull_request')",
    ],
    [
      'source-arm-execute',
      "needs.resolve.outputs.release_required == 'true' || github.event_name == 'pull_request'",
    ],
    [
      'source-arm-merge',
      "needs.resolve.outputs.release_required == 'true' || github.event_name == 'pull_request'",
    ],
    [
      'package',
      "needs.resolve.outputs.release_required == 'true' || github.event_name == 'pull_request'",
    ],
    ['attest', "needs.resolve.outputs.release_required == 'true'"],
    [
      'activation-required',
      "needs.resolve.outputs.release_required == 'true'",
    ],
    ['verify-existing', "needs.resolve.outputs.publication == 'verify'"],
    ['publish', "needs.resolve.outputs.release_required == 'true'"],
  ]
  for (const [job, oldCondition] of oldConditions) {
    const section = jobSection(workflow, job)
    assert(section.includes(diagnosticExclusion))
    assertEquals(
      jobIf(section),
      oldCondition === undefined
        ? '${{ ' + diagnosticExclusion + ' }}'
        : '${{ ' + diagnosticExclusion + ' && (' + oldCondition + ') }}',
    )
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
  assertEquals(count(workflow, 'actions: read'), 1)
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
    return object.__new__(module.Controller)

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

declined = controller()
declined.evidence = module.Retention(root / 'declined-evidence')
declined.github_output = root / 'declined-output'
declined.commands = []
declined.phase = 'initializing'
declined.plan = []
declined.source_records = []
declined.keyring = None
declined.post_sources = None
declined.post_keyring = None
declined.preimage = None
declined.postimage = None
declined.status = 'initializing'
declined.reason = None
declined.gdb = None
declined.image_identity = lambda: {'image': 'ubuntu'}
declined.measure = lambda phase: preimage
declined.trusted_gdb = lambda: None
declined.select_sources = lambda: [{'uri': 'http://ports.ubuntu.com/ubuntu-ports', 'suite': 'noble', 'components': ['main'], 'architectures': 'arm64'}]
def remember_sources(sources, packages):
    declined.source_records = sources
    return root / 'declined.list'
declined.write_private_sources = remember_sources
declined.apt_options = lambda *args: []
declined.require = lambda *args, **kwargs: SimpleNamespace(stdout=b'')
declined.parse_solver = lambda *args: [planned_gdb, planned_extra]
declined.metadata_for_plan = lambda *args: (_ for _ in ()).throw(module.AcquisitionError('metadata unavailable'))
try:
    module.Controller.execute(declined)
except module.AcquisitionError as error:
    declined.reason = str(error)
    declined.status = 'acquisition-declined-or-incomplete'
assert module.Controller.finish(declined) == 0
assert 'runtime_unchanged=true' in declined.github_output.read_text()

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
      GITHUB_SHA: SHA,
      BEFORE,
      AFTER: SHA,
    }, {
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
      GITHUB_SHA: SHA,
      BEFORE,
      AFTER: SHA,
    }, {
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
          GITHUB_SHA: SHA,
          BEFORE,
          AFTER: SHA,
        }, {
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
    'draft',
  )
  assertEquals(result.mode, 'tag-recovery')
  assertEquals(result.publication, 'recover')
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
