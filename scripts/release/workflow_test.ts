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
    9,
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
  assertEquals(verifyLines.length, 9)
  for (const line of verifyLines) {
    assert(line.includes('${{ needs.test.outputs.license_producer_attempt }}'))
    assert(line.includes('${{ needs.test.outputs.license_notice_sha256 }}'))
    assert(!line.includes('github.run_attempt'))
  }
  const packageSection = workflow.slice(workflow.indexOf('  package:'))
  assert(!packageSection.includes('release.ts prepare-licenses'))
  assert(packageSection.includes('release.ts materialize-licenses'))
  assert(packageSection.includes(graph))
  assert(
    packageSection.includes(
      'needs: [resolve, test, build, source-materials, source-native-linux-x64, source-native-macos-x64, source-native-macos-arm64, source-arm-build, source-arm-merge]',
    ),
  )
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

  assert(
    build.includes(
      'needs: [resolve, test, source-materials, source-native-linux-x64, source-native-macos-x64, source-native-macos-arm64, source-arm-build, source-arm-merge]',
    ),
  )
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
    "if: needs.resolve.outputs.release_required == 'true' || github.event_name == 'pull_request'"

  assert(workflow.includes('permissions: {}'))
  assertEquals(count(workflow, ciCondition), 9)
  assertEquals(count(workflow, 'id-token: write'), 1)
  assert(
    workflow.includes(
      "if: needs.resolve.outputs.release_required == 'true'\n    runs-on: ubuntu-26.04\n    permissions:\n      attestations: write\n      artifact-metadata: write\n      id-token: write",
    ),
  )
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
    ['source-native-macos-x64', 'macos-15-intel', 'x86_64-apple-darwin'],
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
  assert(armBuild.includes('--build-host "$BUILD_HOST" --purpose build'))
  assert(
    armBuild.includes(
      '--descriptor "dist/release-inputs/tool-pins/$TARGET.json"',
    ),
  )
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
