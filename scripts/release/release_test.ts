import {
  assert,
  assertEquals,
  assertRejects,
  assertThrows,
} from 'jsr:@std/assert@1'
import { createHash } from 'node:crypto'
import {
  assertArchive,
  assertVersion,
  ciManifest,
  collectLegalEvidence,
  compiledModuleGraphFromDenoInfo,
  executableDigestFromArchive,
  hashFile,
  manifest,
  materializeLicenses,
  pack,
  packCi,
  packExecutable,
  payloadSpecs,
  prepareLicenses,
  readTar,
  requireLicenses,
  reviewedSourceVersion,
  sbomFromLock,
  SOURCE_ASSET_MAX_BYTES,
  SOURCE_ASSETS,
  thirdPartyNotices,
  verifyLicenses,
  verifyLinuxValidation,
} from './release.ts'
import { CANONICAL_NOTICE_NAME } from './source-materials.ts'
import { canonicalTargetDescriptorBytes } from '../../source-rebuild/prepare-tools.ts'
import { materializeApplicationNotices } from './application-notices.ts'
import { verifyReleaseDirectory } from './workflow.ts'

const VERSION = '2026.6.6.2026'
const SHA = 'a'.repeat(40)
const WHEN = '2026-06-06T20:26:00.000Z'
const PROOF_TARGETS = [
  'x86_64-unknown-linux-gnu',
  'aarch64-unknown-linux-gnu',
  'x86_64-apple-darwin',
  'aarch64-apple-darwin',
] as const
const run = async (command: string, args: string[], cwd: string) => {
  const output = await new Deno.Command(command, {
    args,
    cwd,
    stdout: 'piped',
    stderr: 'piped',
  }).output()
  if (!output.success) throw new Error(new TextDecoder().decode(output.stderr))
}

async function textSha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(text),
  )
  return [...new Uint8Array(digest)].map((value) =>
    value.toString(16).padStart(2, '0')
  ).join('')
}

async function writeResolvedRuntimeEvidence(root: string): Promise<void> {
  const base = `${root}/scripts/release/runtime-notices`
  const cargoLock = 'locked packages fixture\n'
  const license = 'Deno runtime MIT license fixture\n'
  await Deno.mkdir(`${base}/evidence/deno`, { recursive: true })
  await Deno.writeTextFile(`${base}/evidence/deno/Cargo.lock`, cargoLock)
  await Deno.writeTextFile(`${base}/evidence/deno/LICENSE.md`, license)
  await Deno.writeTextFile(
    `${base}/evidence-index.json`,
    JSON.stringify(
      {
        schema_version: 1,
        generator: 'scripts/release/runtime-notices.ts',
        runtime: {
          component: 'deno',
          version: '2.9.3',
          cargo_lock: {
            path: 'evidence/deno/Cargo.lock',
            sha256: await textSha256(cargoLock),
          },
        },
        components: [{
          component: 'deno',
          version: '2.9.3',
          immutable_source:
            'https://github.com/denoland/deno/tree/f39575ecd50602a5b42b1ba8e93849460de9fcf4',
          source_pin: 'f39575ecd50602a5b42b1ba8e93849460de9fcf4',
          files: [{
            path: 'evidence/deno/LICENSE.md',
            sha256: await textSha256(license),
          }],
          target_coverage: [
            'x86_64-unknown-linux-gnu',
            'aarch64-unknown-linux-gnu',
            'x86_64-apple-darwin',
            'aarch64-apple-darwin',
          ],
          inclusion_basis: 'actual-shipped',
        }],
      },
      null,
      2,
    ),
  )
}

async function writeSourceMaterialsFixture(root: string): Promise<void> {
  const directory = `${root}/dist/release-inputs/source-materials`
  await Deno.mkdir(directory, { recursive: true })
  const sourceAssets = await Promise.all(SOURCE_ASSETS.map(async (name) => {
    const path = `${directory}/${name}`
    await Deno.writeTextFile(path, `source material fixture: ${name}\n`)
    const info = await Deno.stat(path)
    return {
      name,
      sha256: await hashFile(path),
      size: info.size,
      embedded_manifest_path: 'source-materials/pack-manifest.json',
    }
  }))
  const commit = SHA
  const pins = {
    schema_version: 1,
    deno: {
      version: '2.9.3',
      commit,
      archive:
        'https://github.com/denoland/deno/releases/download/v2.9.3/deno_src.tar.gz',
      sha256: 'b'.repeat(64),
    },
    rusty_v8: {
      commit,
      archive: `https://github.com/denoland/rusty_v8/archive/${commit}.tar.gz`,
      sha256: 'c'.repeat(64),
    },
    v8: {
      commit,
      archive: `https://github.com/denoland/v8/archive/${commit}.tar.gz`,
      sha256: 'd'.repeat(64),
    },
    gitlink_closure: {
      path: 'source-materials/rusty-v8-gitlinks.json',
      sha256: '',
    },
  }
  await Deno.mkdir(`${root}/source-materials`, { recursive: true })
  await Deno.mkdir(`${root}/source-rebuild`, { recursive: true })
  await Deno.copyFile(
    new URL('../../source-rebuild/tool-prereqs.json', import.meta.url),
    `${root}/source-rebuild/tool-prereqs.json`,
  )
  const pinsPath = `${root}/source-materials/pins.json`
  const closureDescriptorPath =
    `${root}/source-materials/rusty-v8-gitlinks.json`
  const sourceLegalIndexPath =
    `${root}/source-materials/rusty-v8-source-license-index.json`
  await Deno.writeTextFile(
    closureDescriptorPath,
    JSON.stringify(
      {
        schema_version: 1,
        kind: 'fixture-rusty-v8-gitlink-closure',
        root_tree: 'f'.repeat(40),
        gitlink_count: 1,
      },
      null,
      2,
    ) + '\n',
  )
  await Deno.writeTextFile(
    sourceLegalIndexPath,
    JSON.stringify(
      {
        schema_version: 1,
        kind: 'fixture-source-distributed-extra-tree-legal-evidence',
        source_distributed_extra_tree_count: 7,
        supplement_count: 3,
      },
      null,
      2,
    ) + '\n',
  )
  pins.gitlink_closure.sha256 = await hashFile(closureDescriptorPath)
  await Deno.writeTextFile(pinsPath, JSON.stringify(pins, null, 2) + '\n')
  const noticePath = `${root}/dist/release-inputs/THIRD_PARTY_NOTICES`
  const notice = await Deno.stat(noticePath)
  const receipt = {
    schema_version: 1,
    kind: 'slv-source-materials',
    mode: 'reviewed',
    source: {
      commit,
      tree_sha256: 'e'.repeat(64),
      timestamp: WHEN,
      timestamp_epoch: 1_780_777_560,
    },
    canonical_notice: {
      path: CANONICAL_NOTICE_NAME,
      sha256: await hashFile(noticePath),
      size: notice.size,
    },
    pins: { ...pins, sha256: await hashFile(pinsPath) },
    closure: {
      embedded_path: 'source-materials/closure.json',
      sha256: 'f'.repeat(64),
      entry_count: 1,
    },
    inventory: {
      embedded_path: 'source-materials/inventory.json',
      sha256: '1'.repeat(64),
    },
    vendor: {
      policy: 'full-locked-vendor',
      lock_path: 'Cargo.lock',
      lock_sha256: '2'.repeat(64),
      crate_count: 1,
      omissions: [],
    },
    runtime_security: proofRuntimeSecurity('2'.repeat(64)),
    gitlink_closure: {
      path: pins.gitlink_closure.path,
      sha256: pins.gitlink_closure.sha256,
      root_tree: 'f'.repeat(40),
      gitlink_count: 1,
    },
    source_legal_evidence: {
      index_path: 'source-materials/rusty-v8-source-license-index.json',
      sha256: await hashFile(sourceLegalIndexPath),
      source_distributed_extra_tree_count: 7,
      supplement_count: 3,
    },
    assets: sourceAssets,
    rebuild_proof: { required: true, status: 'separate' },
  }
  await Deno.writeTextFile(
    `${root}/dist/release-inputs/source-materials-receipt.json`,
    JSON.stringify(receipt, null, 2) + '\n',
  )
  await writeSourceProofFixture(
    root,
    sourceAssets,
    await hashFile(
      `${root}/dist/release-inputs/source-materials-receipt.json`,
    ),
    await hashFile(pinsPath),
  )
}

const proofCommand = {
  command: ['test', '--offline'],
  cwd: '/work',
  started_at: WHEN,
  finished_at: WHEN,
  exit_code: 0,
  log: '/work/proof.log',
  log_sha256: '9'.repeat(64),
}

function proofRuntimeSecurity(digest: string) {
  return {
    upstream: {
      cargo_lock: {
        path: 'source-materials/security/upstream-Cargo.lock',
        sha256: '1'.repeat(64),
        package_count: 1125,
      },
      cargo_manifest: {
        path: 'source-materials/security/upstream-Cargo.toml',
        sha256: '2'.repeat(64),
      },
    },
    selected: {
      cargo_lock: {
        path: 'deno/Cargo.lock',
        sha256: digest,
        package_count: 1126,
      },
      cargo_manifest: { path: 'deno/Cargo.toml', sha256: '3'.repeat(64) },
    },
    transform: {
      selection: {
        path: 'source-materials/security/selection.json',
        sha256: '4'.repeat(64),
      },
      manifest_patch: {
        path: 'source-materials/security/manifest-patch.json',
        sha256: '5'.repeat(64),
      },
      resolution_receipt: {
        path: 'source-materials/security/resolution-receipt.json',
        sha256: '6'.repeat(64),
      },
      added_identities_osv: {
        path: 'source-materials/security/added-identities-osv.json',
        sha256: '7'.repeat(64),
      },
    },
    allowed_delta: {
      added: [
        'aws-lc-rs@1.18.2',
        'aws-lc-sys@0.46.0',
        'h2@0.4.16',
        'pkg-config@0.3.34',
        'rustls@0.23.45',
        'rustls-webpki@0.103.15',
      ],
      removed: [
        'aws-lc-rs@1.16.3',
        'h2@0.4.7',
        'pkg-config@0.3.30',
        'rustls@0.23.40',
        'rustls-webpki@0.103.13',
      ],
      changed_same_identity: [
        'deno_crypto_provider@0.49.0',
        'deno_node_crypto@0.25.0',
      ],
    },
  }
}

function proofArtifacts() {
  return {
    baseline: {
      denort_sha256: '1'.repeat(64),
      v8_archive_sha256: '2'.repeat(64),
      ninja_sha256: '3'.repeat(64),
      probe_standalone_sha256: '4'.repeat(64),
      slv_executable_sha256: 'a'.repeat(64),
      bridge_standalone_sha256: 'b'.repeat(64),
      derived_relink_cargo_lock_sha256: 'c'.repeat(64),
    },
    modified: {
      denort_sha256: '5'.repeat(64),
      v8_archive_sha256: '6'.repeat(64),
      ninja_sha256: '7'.repeat(64),
      probe_standalone_sha256: '8'.repeat(64),
    },
  }
}

function proofRuntimeAbi(target: string, denortSha256: string) {
  if (target.endsWith('linux-gnu')) {
    return {
      schema_version: 1,
      kind: 'slv-linux-denort-abi',
      denort_sha256: denortSha256,
      glibc_versions: ['2.27'],
      glibc_private: 'absent',
      rpath_or_runpath: 'absent',
      needed: ['libc.so.6'],
      logs: {
        'version-info.log': 'a'.repeat(64),
        'dynamic.log': 'b'.repeat(64),
      },
      status: 'passed',
    }
  }
  return {
    schema_version: 1,
    kind: 'slv-macos-denort-abi',
    denort_sha256: denortSha256,
    minimum_os: '12.0',
    load_commands_sha256: 'c'.repeat(64),
    status: 'passed',
  }
}

function proofCargoFingerprints(
  phase: 'baseline' | 'modified',
  target: string,
  artifacts: ReturnType<typeof proofArtifacts>,
) {
  const runtimeSha256 = phase === 'baseline'
    ? artifacts.baseline.denort_sha256
    : artifacts.modified.denort_sha256
  const derivedRelinkCargoLockSha256 = phase === 'baseline'
    ? artifacts.baseline.derived_relink_cargo_lock_sha256
    : 'e'.repeat(64)
  const record = (context: 'host-release' | 'target-release') => {
    const content = `{"context":"${context}","phase":"${phase}"}\n`
    return {
      context,
      path: `${phase}-${context}/output-unit.json`,
      sha256: createHash('sha256').update(content).digest('hex'),
      content_base64: btoa(content),
    }
  }
  return {
    schema_version: 1,
    kind: 'slv-cargo-fingerprint-records',
    phase,
    target,
    runtime_sha256: runtimeSha256,
    derived_relink_cargo_lock_sha256: derivedRelinkCargoLockSha256,
    records: [
      record('host-release'),
      ...(target.endsWith('linux-gnu') ? [record('target-release')] : []),
    ],
  }
}

function proofChecks(
  canonicalNoticeSha256: string,
  target: string,
  artifacts: ReturnType<typeof proofArtifacts>,
) {
  return {
    baseline_build: {
      passed: true,
      command: proofCommand,
      derived_relink_cargo_lock_sha256:
        artifacts.baseline.derived_relink_cargo_lock_sha256,
      runtime_abi: proofRuntimeAbi(target, artifacts.baseline.denort_sha256),
      runtime_abi_receipt_sha256: 'd'.repeat(64),
      cargo_fingerprints: proofCargoFingerprints('baseline', target, artifacts),
    },
    baseline_probe: {
      passed: true,
      sentinel: { input: 0.125, output: 0.124, command: proofCommand },
      control: { input: 0.126, output: 0.125, command: proofCommand },
    },
    patch: {
      passed: true,
      before_sha256: 'c'.repeat(64),
      after_sha256: 'd'.repeat(64),
      command: proofCommand,
    },
    modified_build: {
      passed: true,
      command: proofCommand,
      derived_relink_cargo_lock_sha256: 'e'.repeat(64),
      runtime_abi: proofRuntimeAbi(target, artifacts.modified.denort_sha256),
      runtime_abi_receipt_sha256: 'e'.repeat(64),
      cargo_fingerprints: proofCargoFingerprints('modified', target, artifacts),
    },
    modified_probe: {
      passed: true,
      sentinel: { input: 0.125, output: 0.5, command: proofCommand },
      control: { input: 0.126, output: 0.125, command: proofCommand },
    },
    slv_compile: { passed: true, command: proofCommand },
    slv_version: { passed: true, command: proofCommand },
    slv_help: { passed: true, command: proofCommand },
    release_bridge: {
      passed: true,
      compile: proofCommand,
      command: proofCommand,
    },
    licenses: {
      passed: true,
      canonical_notice_sha256: canonicalNoticeSha256,
      command: proofCommand,
    },
  }
}

const LINUX_SYSROOT_FIXTURES = {
  'x86_64-unknown-linux-gnu': {
    archive: '64513b04d8a38da6f47c0a9c4cb47b2ce7bcb735250b10eb10751aec6afe46ee',
    environment:
      '8dd1d28a69afcd7790a4f9871c02992553ad348b3855aab4e465a263e298c81a',
    arch: 'x86_64-linux-gnu',
  },
  'aarch64-unknown-linux-gnu': {
    archive: '0a29c63c52cc1e59228686602cf3cf41080a809655afc29d1b8a27af4b20cedb',
    environment:
      '11c9a31f2303e448eb68ff5de9f0359ff202a2f25e5f4fa9001d8c332ea2d80e',
    arch: 'aarch64-linux-gnu',
  },
} as const

async function compatibilityCommand(
  root: string,
  prefix: string,
  name: string,
  contents: string,
  command: string[],
) {
  const log = `${name}.log`
  await Deno.writeTextFile(`${root}/${prefix}/${log}`, contents)
  return {
    command,
    cwd: '.',
    started_at: '2026-10-13T00:00:00Z',
    finished_at: '2026-10-13T00:00:01Z',
    exit_code: 0,
    log,
    log_sha256: await hashFile(`${root}/${prefix}/${log}`),
  }
}

async function writeLinuxCompatibilityFixture(
  root: string,
  target: keyof typeof LINUX_SYSROOT_FIXTURES,
  runtimeDirectory: string,
  artifacts: ReturnType<typeof proofArtifacts>,
  proofPath: string,
  buildPath: string,
  canonicalNoticeSha256: string,
): Promise<void> {
  const prefix =
    `dist/release-inputs/product-runtime/${target}/linux-compatibility`
  await Deno.mkdir(`${root}/${prefix}`, { recursive: true })
  const sysroot = LINUX_SYSROOT_FIXTURES[target]
  const sysrootPath = `/tmp/slv-sysroot-${target}`
  const loader = `${sysrootPath}/lib/${sysroot.arch}/ld-2.27.so`
  const libraryPath =
    `${sysrootPath}/lib/${sysroot.arch}:${sysrootPath}/usr/lib/${sysroot.arch}`
  const elf = async (label: string, executable: string) => ({
    versions: ['2.27'],
    needed: ['libc.so.6'],
    version: await compatibilityCommand(
      root,
      prefix,
      `${label}-version`,
      'GLIBC_2.27\n',
      ['/usr/bin/readelf', '--version-info', executable],
    ),
    dynamic: await compatibilityCommand(
      root,
      prefix,
      `${label}-dynamic`,
      'Shared library: [libc.so.6]\n',
      ['/usr/bin/readelf', '-d', executable],
    ),
    loader_list: await compatibilityCommand(
      root,
      prefix,
      `${label}-loader`,
      `${loader} (0x1)\nlibc.so.6 => ${sysrootPath}/lib/${sysroot.arch}/libc.so.6 (0x2)\n`,
      [loader, '--library-path', libraryPath, '--list', executable],
    ),
  })
  const noticeSource = `${root}/dist/release-inputs/THIRD_PARTY_NOTICES`
  const noticeLog = `${root}/${prefix}/licenses.log`
  await Deno.copyFile(noticeSource, noticeLog)
  const licenseCommand = {
    command: [loader, '--library-path', libraryPath, '/tmp/slv', 'licenses'],
    cwd: '.',
    started_at: '2026-10-13T00:00:00Z',
    finished_at: '2026-10-13T00:00:01Z',
    exit_code: 0,
    log: 'licenses.log',
    log_sha256: await hashFile(noticeLog),
  }
  const executablePath = `${root}/dist/slv-${target}-exe.tar.gz`
  const bridgePath = `${runtimeDirectory}/release-bridge-smoke`
  const bridgeInfo = await Deno.lstat(bridgePath).catch(() => undefined)
  if (!bridgeInfo?.isFile || bridgeInfo.isSymlink) {
    throw new Error('Linux compatibility fixture bridge is missing')
  }
  await Deno.writeTextFile(
    `${runtimeDirectory}/linux-compatibility-receipt.json`,
    JSON.stringify({
      schema_version: 1,
      kind: 'slv-linux-product-compatibility',
      target,
      native_proof_sha256: await hashFile(proofPath),
      build_receipt_sha256: await hashFile(buildPath),
      runtime: {
        baseline_denort_sha256: artifacts.baseline.denort_sha256,
        derived_relink_cargo_lock_sha256:
          artifacts.baseline.derived_relink_cargo_lock_sha256,
        path: '/tmp/baseline-denort',
      },
      product: {
        executable_sha256: await executableDigestFromArchive(
          executablePath,
          `slv-${target}-exe`,
        ),
        bridge_sha256: artifacts.baseline.bridge_standalone_sha256,
      },
      toolchain: {
        deno_sysroot_archive_sha256: sysroot.archive,
        deno_sysroot_env_sha256: sysroot.environment,
        loader,
        library_path: libraryPath,
        frontend_sha256: 'f'.repeat(64),
      },
      checks: {
        elf_glibc_ceiling_and_no_private_or_rpath: {
          runtime: await elf('runtime', '/tmp/baseline-denort'),
          executable: await elf('executable', '/tmp/slv'),
          bridge: await elf('bridge', '/tmp/release-bridge-smoke'),
          smoke: await elf('smoke', '/tmp/runtime-smoke'),
        },
        older_loader_startup: await compatibilityCommand(
          root,
          prefix,
          'startup',
          'slv 1.0\n',
          [loader, '--library-path', libraryPath, '/tmp/slv', '--version'],
        ),
        older_loader_licenses: {
          ...licenseCommand,
          canonical_notice_sha256: canonicalNoticeSha256,
        },
        older_loader_bridge: await compatibilityCommand(
          root,
          prefix,
          'bridge',
          'bridge passed\n',
          [loader, '--library-path', libraryPath, '/tmp/release-bridge-smoke'],
        ),
        source_built_runtime_crypto_subprocess_loopback_tls: {
          compile: await compatibilityCommand(
            root,
            prefix,
            'smoke-compile',
            'compile passed\n',
            [
              '/tmp/deno',
              'compile',
              '--cached-only',
              '--no-prompt',
              '-A',
              '--target',
              target,
              '--output',
              '/tmp/runtime-smoke',
              '/tmp/runtime-smoke.ts',
            ],
          ),
          execute: await compatibilityCommand(
            root,
            prefix,
            'smoke-execute',
            'smoke passed\n',
            [
              loader,
              '--library-path',
              libraryPath,
              '/tmp/runtime-smoke',
              '/tmp/tls-localhost.crt',
              '/tmp/tls-localhost.key',
              '/tmp/tls-root-ca.pem',
            ],
          ),
          executable_sha256: 'e'.repeat(64),
        },
      },
      status: 'passed',
    }),
  )
}

async function writeSourceProofFixture(
  root: string,
  assets: Array<{ name: string; sha256: string; size: number }>,
  receiptSha256: string,
  sourcePinSha256: string,
): Promise<void> {
  const proofRoot = `${root}/dist/release-inputs/source-proofs`
  const toolPinsRoot = `${root}/dist/release-inputs/tool-pins`
  await Deno.mkdir(toolPinsRoot, { recursive: true })
  const reviewedToolPins = JSON.parse(
    await Deno.readTextFile(`${root}/source-rebuild/tool-prereqs.json`),
  )
  for (const target of PROOF_TARGETS) {
    const targetRoot = `${proofRoot}/${target}`
    const runtimeDirectory = root + '/dist/release-inputs/product-runtime/' +
      target
    await Deno.mkdir(targetRoot, { recursive: true })
    await Deno.mkdir(runtimeDirectory, { recursive: true })
    const toolPinPath = `${toolPinsRoot}/${target}.json`
    await Deno.writeFile(
      toolPinPath,
      canonicalTargetDescriptorBytes(reviewedToolPins, target),
    )
    const toolPinSha256 = await hashFile(toolPinPath)
    const artifacts = proofArtifacts()
    if (target in LINUX_SYSROOT_FIXTURES) {
      const bridgePath = `${runtimeDirectory}/release-bridge-smoke`
      await Deno.writeTextFile(bridgePath, `bridge ${target}\n`)
      artifacts.baseline.bridge_standalone_sha256 = await hashFile(bridgePath)
    }
    const canonicalNotice = JSON.parse(
      await Deno.readTextFile(
        `${root}/dist/release-inputs/source-materials-receipt.json`,
      ),
    ) as { canonical_notice: { sha256: string } }
    const checks = proofChecks(
      canonicalNotice.canonical_notice.sha256,
      target,
      artifacts,
    )
    const host = target.includes('apple')
      ? { os: 'darwin', arch: target.startsWith('x86_64') ? 'x64' : 'arm64' }
      : { os: 'linux', arch: target.startsWith('x86_64') ? 'x64' : 'arm64' }
    const build = {
      schema_version: 1,
      kind: 'slv-source-build-receipt',
      target,
      build_mode: 'native',
      build_host: host,
      source_commit: SHA,
      source_receipt_sha256: receiptSha256,
      source_assets: assets,
      source_pin_sha256: sourcePinSha256,
      source_selected_cargo_lock_sha256: '2'.repeat(64),
      tool_pin_sha256: toolPinSha256,
      patch_sha256: 'e'.repeat(64),
      jobs: '2',
      toolchain: { identities: {} },
      extraction: {},
      artifacts,
      checks: {
        baseline_build: checks.baseline_build,
        patch: checks.patch,
        modified_build: checks.modified_build,
        slv_compile: checks.slv_compile,
      },
    }
    const buildPath = `${targetRoot}/build-receipt.json`
    await Deno.writeTextFile(buildPath, JSON.stringify(build))
    const execution = {
      schema_version: 1,
      kind: 'slv-source-execution-receipt',
      target,
      build_mode: 'native',
      build_receipt_sha256: await hashFile(buildPath),
      execution_host: host,
      artifacts,
      checks: {
        baseline_probe: checks.baseline_probe,
        modified_probe: checks.modified_probe,
        slv_version: checks.slv_version,
        slv_help: checks.slv_help,
        release_bridge: checks.release_bridge,
        licenses: checks.licenses,
      },
    }
    const executionPath = `${targetRoot}/execution-receipt.json`
    await Deno.writeTextFile(executionPath, JSON.stringify(execution))
    await Deno.writeTextFile(
      `${targetRoot}/native-proof.json`,
      JSON.stringify({
        schema_version: 1,
        kind: 'slv-source-target-proof',
        target,
        source_commit: SHA,
        source_receipt_sha256: receiptSha256,
        source_assets: assets,
        build_mode: 'native',
        build_host: host,
        execution_host: host,
        source_pin_sha256: sourcePinSha256,
        source_selected_cargo_lock_sha256: '2'.repeat(64),
        tool_pin_sha256: toolPinSha256,
        patch_sha256: 'e'.repeat(64),
        jobs: '2',
        build_receipt_sha256: await hashFile(buildPath),
        execution_receipt_sha256: await hashFile(executionPath),
        build_artifacts: artifacts,
        execution_artifacts: artifacts,
        artifacts,
        checks,
        status: 'passed',
      }),
    )
    const proofPath = targetRoot + '/native-proof.json'
    const tarPath = root + '/dist/slv-' + target + '-exe.tar.gz'
    await Deno.writeTextFile(
      runtimeDirectory + '/product-runtime-receipt.json',
      JSON.stringify({
        schema_version: 1,
        kind: 'slv-product-runtime-receipt',
        target,
        executable_sha256: await executableDigestFromArchive(
          tarPath,
          'slv-' + target + '-exe',
        ),
        executable_tar_sha256: await hashFile(tarPath),
        baseline_denort_sha256: artifacts.baseline.denort_sha256,
        source_selected_cargo_lock_sha256: '2'.repeat(64),
        derived_relink_cargo_lock_sha256:
          artifacts.baseline.derived_relink_cargo_lock_sha256,
        source_receipt_sha256: receiptSha256,
        native_proof_sha256: await hashFile(proofPath),
        build_receipt_sha256: await hashFile(buildPath),
      }),
    )
    if (target in LINUX_SYSROOT_FIXTURES) {
      await writeLinuxCompatibilityFixture(
        root,
        target as keyof typeof LINUX_SYSROOT_FIXTURES,
        runtimeDirectory,
        artifacts,
        proofPath,
        buildPath,
        checks.licenses.canonical_notice_sha256,
      )
    }
  }
}

async function fixture(): Promise<string> {
  const root = await Deno.makeTempDir({ prefix: 'slv-release-fixture-' })
  const write = (path: string, content: string) =>
    Deno.writeTextFile(path, content)
  await Deno.mkdir(`${root}/dist/oss-skills`, { recursive: true })
  await Deno.mkdir(`${root}/dist/release-inputs`, { recursive: true })
  await Deno.mkdir(`${root}/scripts/release/application-notices`, {
    recursive: true,
  })
  await write(
    `${root}/scripts/release/application-notices/evidence-index.json`,
    JSON.stringify({ schema_version: 1, distributions: [] }),
  )
  await writeResolvedRuntimeEvidence(root)
  await Deno.mkdir(`${root}/template/${VERSION}/nested`, { recursive: true })
  await Deno.mkdir(`${root}/sh`, { recursive: true })
  await write(
    `${root}/template/${VERSION}/nested/file.txt`,
    'template fixture\n',
  )
  await write(`${root}/sh/install`, '#!/bin/sh\necho install\n')
  await write(`${root}/LICENSE.txt`, 'Apache License\nVersion 2.0\n')
  await write(
    `${root}/dist/release-inputs/compiled-module-graph.json`,
    JSON.stringify({
      schema_version: 1,
      npm: ['@scope/example@1.2.3'],
      jsr: [],
      remote: [],
    }),
  )
  await write(
    `${root}/dist/release-inputs/license-evidence.json`,
    JSON.stringify({
      schema_version: 1,
      components: [],
    }),
  )
  await write(
    `${root}/deno.lock`,
    JSON.stringify({
      version: '5',
      jsr: { '@std/assert@1.0.16': { integrity: 'b'.repeat(64) } },
      npm: {
        '@scope/example@1.2.3': {
          integrity: `sha256-${
            btoa(String.fromCharCode(...new Uint8Array(32).fill(3)))
          }`,
        },
      },
      remote: { 'https://deno.land/x/example@1.0.0/mod.ts': 'c'.repeat(64) },
    }),
  )
  const npm =
    `${root}/node_modules/.deno/@scope+example@1.2.3/node_modules/@scope/example`
  await Deno.mkdir(npm, { recursive: true })
  await write(
    `${npm}/package.json`,
    JSON.stringify({
      name: '@scope/example',
      version: '1.2.3',
      license: 'MIT',
    }),
  )
  await write(`${npm}/LICENSE`, 'MIT fixture license\n')
  for (
    const target of [
      'x86_64-unknown-linux-gnu',
      'aarch64-unknown-linux-gnu',
      'x86_64-apple-darwin',
      'aarch64-apple-darwin',
    ]
  ) {
    const binary = `slv-${target}-exe`
    await Deno.writeFile(
      `${root}/dist/${binary}`,
      new Uint8Array([...new TextEncoder().encode(`binary ${target}`), 0, 255]),
    )
    await packExecutable(
      `${root}/dist/${binary}`,
      `${root}/dist/${binary}.tar.gz`,
      binary,
    )
    await Deno.remove(`${root}/dist/${binary}`)
  }
  for (
    const skill of [
      'slv-validator',
      'slv-rpc',
      'slv-grpc-geyser',
      'slv-benchmark',
      'slv-app',
      'slv-bot-trade-app',
      'slv-server-procurement',
      'slv-backup',
      'slv-firewall',
      'slv-wireguard',
    ]
  ) {
    await Deno.mkdir(`${root}/dist/oss-skills/${skill}`, { recursive: true })
    await write(`${root}/dist/oss-skills/${skill}/SKILL.md`, `# ${skill}\n`)
    await write(
      `${root}/dist/oss-skills/${skill}/skill.json`,
      JSON.stringify({ name: skill, version: '1.0.0' }),
    )
  }
  await prepareLicenses([SHA, '55', '2'], { root, version: VERSION })
  await writeSourceMaterialsFixture(root)
  return root
}

const LINUX_VALIDATION_TARGETS = PROOF_TARGETS.slice(0, 2)

async function linuxValidationFixture(
  target = LINUX_VALIDATION_TARGETS[0],
): Promise<string> {
  const root = await Deno.realPath(await fixture())
  await Deno.mkdir(`${root}/cli`, { recursive: true })
  await Deno.mkdir(`${root}/cmn/constants`, { recursive: true })
  await Deno.writeTextFile(
    `${root}/cli/deno.json`,
    JSON.stringify({ version: VERSION }),
  )
  await Deno.writeTextFile(
    `${root}/cmn/constants/version.ts`,
    `export const VERSION = '${VERSION}'\n`,
  )
  for (const other of PROOF_TARGETS) {
    if (other.includes('apple')) {
      await Deno.remove(`${root}/dist/release-inputs/source-proofs/${other}`, {
        recursive: true,
      })
    }
    if (other !== target) {
      await Deno.remove(
        `${root}/dist/release-inputs/product-runtime/${other}`,
        { recursive: true },
      )
    }
  }
  return root
}

Deno.test('CalVer and manifest enforce the exact 21-payload release contract', () => {
  assertVersion(VERSION)
  assertThrows(() => assertVersion('2026.2.30.2026'))
  const assets = payloadSpecs().map((spec) => ({
    ...spec,
    sha256: 'b'.repeat(64),
    size: 1,
  }))
  const value = manifest(VERSION, SHA, 'refs/heads/main', '42', '1', assets)
  assertEquals(value.assets.length, 21)
  assertEquals(
    value.assets.slice(-3).map((asset) => [asset.name, asset.kind]),
    SOURCE_ASSETS.map((name) => [name, 'source']),
  )
  const oversized = structuredClone(assets)
  oversized[oversized.length - 1].size = SOURCE_ASSET_MAX_BYTES
  assertThrows(
    () => manifest(VERSION, SHA, 'refs/heads/main', '42', '1', oversized),
    Error,
    'payload inventory',
  )
  assertThrows(() =>
    manifest(VERSION, SHA, 'refs/tags/v2026.1.1.0001', '42', '1', assets)
  )
  const ci = ciManifest(
    VERSION,
    SHA,
    'refs/pull/7/merge',
    '42',
    '1',
    assets,
  )
  assertEquals(ci.artifact_kind, 'ci-only')
  assertEquals(ci.unsigned, true)
  assertThrows(() =>
    ciManifest(VERSION, SHA, 'refs/pull/0/merge', '42', '1', assets)
  )
  assertThrows(() =>
    ciManifest(VERSION, SHA, 'refs/pull/7/head', '42', '1', assets)
  )
})

Deno.test('hashFile streams multiple read chunks and preserves the SHA-256', async () => {
  const root = await Deno.makeTempDir({ prefix: 'slv-release-hash-' })
  try {
    const bytes = new Uint8Array(2 * 1024 * 1024 + 37)
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = index % 251
    }
    const path = `${root}/large-input`
    await Deno.writeFile(path, bytes)
    const expected = [
      ...new Uint8Array(
        await crypto.subtle.digest('SHA-256', bytes),
      ),
    ].map((value) => value.toString(16).padStart(2, '0')).join('')
    assertEquals(await hashFile(path), expected)
  } finally {
    await Deno.remove(root, { recursive: true })
  }
})

Deno.test('SBOM preserves JSR, npm, and remote namespaces and converts SRI to hex', () => {
  const base64 = btoa(String.fromCharCode(...new Uint8Array(64).fill(7)))
  const sbom = sbomFromLock(
    {
      version: '5',
      jsr: { '@std/assert@1.0.16': { integrity: 'a'.repeat(64) } },
      npm: { '@scope/pkg@1.2.3_peer@4.5.6': { integrity: `sha512-${base64}` } },
      remote: { 'https://deno.land/x/example@1.0.0/mod.ts': 'c'.repeat(64) },
    },
    VERSION,
    SHA,
    WHEN,
  ) as { packages: Array<Record<string, unknown>> }
  const runtime = sbom.packages.find((entry) =>
    entry.SPDXID === 'SPDXRef-DenoRuntime'
  )!
  assertEquals(runtime.versionInfo, '2.9.3')
  assertEquals(
    runtime.downloadLocation,
    'https://github.com/denoland/deno/releases/tag/v2.9.3',
  )
  assertEquals(runtime.licenseConcluded, 'NOASSERTION')
  const jsr = sbom.packages.find((entry) =>
    entry.downloadLocation === 'https://jsr.io/@std/assert@1.0.16'
  )!
  const npm = sbom.packages.find((entry) => entry.name === '@scope/pkg')!
  const remote = sbom.packages.find((entry) =>
    entry.downloadLocation === 'https://deno.land/x/example@1.0.0/mod.ts'
  )!
  assertEquals(
    (jsr.checksums as Array<{ checksumValue: string }>)[0].checksumValue,
    'a'.repeat(64),
  )
  assertEquals(
    (npm.checksums as Array<{ checksumValue: string }>)[0].checksumValue.length,
    128,
  )
  assertEquals(
    (remote.checksums as Array<{ checksumValue: string }>)[0].checksumValue,
    'c'.repeat(64),
  )
  assertThrows(() =>
    sbomFromLock(
      {
        version: '5',
        jsr: {},
        npm: { 'x@1': { integrity: 'sha512-not base64?' } },
        remote: {},
      },
      VERSION,
      SHA,
      WHEN,
    )
  )
})

Deno.test('pack integration emits template/version, complete inventory, and notices', async () => {
  const root = await fixture()
  try {
    const output = await pack([
      VERSION,
      SHA,
      'refs/heads/main',
      '55',
      '2',
      WHEN,
    ], { root })
    const releaseManifest = JSON.parse(
      await Deno.readTextFile(`${output}/release-manifest.json`),
    )
    assertEquals(releaseManifest.assets.length, 21)
    for (const name of SOURCE_ASSETS) {
      assertEquals(
        await Deno.readTextFile(`${output}/${name}`),
        `source material fixture: ${name}\n`,
      )
    }
    assertEquals(
      (await readTar(`${output}/template.tar.gz`)).map((entry) => entry.path)
        .sort(),
      [
        `template/${VERSION}`,
        `template/${VERSION}/THIRD_PARTY_NOTICES`,
        `template/${VERSION}/nested`,
        `template/${VERSION}/nested/file.txt`,
      ],
    )
    await assertArchive(
      `${output}/slv-x86_64-unknown-linux-gnu-exe.tar.gz`,
      'slv-x86_64-unknown-linux-gnu-exe',
      { singleFile: true },
    )
    assert(
      (await Deno.readTextFile(`${output}/THIRD_PARTY_NOTICES`)).includes(
        'MIT fixture license',
      ),
    )
    assert(
      (await Deno.readTextFile(`${output}/THIRD_PARTY_NOTICES`)).includes(
        'not asserted shipped',
      ),
    )
    const rawSourceReceipt = await Deno.readTextFile(
      `${root}/dist/release-inputs/source-materials-receipt.json`,
    )
    const sbom = JSON.parse(
      await Deno.readTextFile(`${output}/sbom.spdx.json`),
    ) as { annotations: Array<{ comment: string }> }
    const prefix = '---BEGIN SLV SOURCE MATERIALS RECEIPT---\n'
    const sourceReceiptAnnotation = sbom.annotations.find((annotation) =>
      annotation.comment.includes(prefix)
    )
    assert(sourceReceiptAnnotation)
    const extractedReceipt = sourceReceiptAnnotation.comment.slice(
      sourceReceiptAnnotation.comment.indexOf(prefix) + prefix.length,
    )
    assertEquals(extractedReceipt, rawSourceReceipt)
    const extractedHash = [
      ...new Uint8Array(
        await crypto.subtle.digest(
          'SHA-256',
          new TextEncoder().encode(extractedReceipt),
        ),
      ),
    ].map((byte) => byte.toString(16).padStart(2, '0')).join('')
    assertEquals(
      extractedHash,
      await hashFile(
        `${root}/dist/release-inputs/source-materials-receipt.json`,
      ),
    )
    for (
      const subject of [
        ...releaseManifest.assets.map((asset: { name: string }) => asset.name),
        'release-manifest.json',
        'SHA256SUMS',
      ]
    ) {
      await Deno.writeTextFile(
        `${output}/${subject}.intoto.jsonl`,
        'test bundle\n',
      )
    }
    const verified = await verifyReleaseDirectory(output, VERSION, SHA, [
      'refs/heads/main',
      `refs/tags/v${VERSION}`,
    ])
    assertEquals(verified.sourceRef, 'refs/heads/main')
    assertEquals(verified.subjects.length, 23)
    await assertRejects(
      () =>
        verifyReleaseDirectory(output, VERSION, SHA, [
          `refs/tags/v${VERSION}`,
        ]),
      Error,
      'not trusted',
    )
    const installer = await Deno.readTextFile(`${output}/install`)
    await Deno.writeTextFile(`${output}/install`, 'tampered')
    await assertRejects(
      () => verifyReleaseDirectory(output, VERSION, SHA, ['refs/heads/main']),
      Error,
      'payload differs',
    )
    await Deno.writeTextFile(`${output}/install`, installer)
    await Deno.remove(`${output}/SHA256SUMS.intoto.jsonl`)
    await assertRejects(
      () => verifyReleaseDirectory(output, VERSION, SHA, ['refs/heads/main']),
      Error,
      'missing attestation bundle',
    )
  } finally {
    await Deno.remove(root, { recursive: true })
  }
})

Deno.test('CI packages use the identical payload inventory but cannot pass a production consumer', async () => {
  const root = await fixture()
  try {
    const output = await packCi([
      VERSION,
      SHA,
      'refs/pull/12/merge',
      '55',
      '2',
      WHEN,
    ], { root })
    const ci = JSON.parse(
      await Deno.readTextFile(`${output}/release-manifest.json`),
    )
    assertEquals(ci.assets.length, 21)
    assertEquals(ci.unsigned, true)
    await assertRejects(
      () => verifyReleaseDirectory(output, VERSION, SHA, ['refs/heads/main']),
      Error,
      'invalid source ref',
    )
    await assertRejects(
      () =>
        packCi([VERSION, SHA, 'refs/heads/main', '55', '2', WHEN], { root }),
      Error,
      'pull-request merge ref',
    )
  } finally {
    await Deno.remove(root, { recursive: true })
  }
})

async function checkProductTampering(linuxOnly: boolean): Promise<void> {
  const root = await (linuxOnly ? linuxValidationFixture() : fixture())
  const verify = () =>
    linuxOnly
      ? verifyLinuxValidation([LINUX_VALIDATION_TARGETS[0], SHA], { root })
      : pack([VERSION, SHA, 'refs/heads/main', '55', '2', WHEN], { root })
  const receiptPath =
    `${root}/dist/release-inputs/source-materials-receipt.json`
  try {
    const original = await Deno.readTextFile(receiptPath)
    const wrongIdentity = JSON.parse(original) as {
      source: { commit: string }
    }
    wrongIdentity.source.commit = 'b'.repeat(40)
    await Deno.writeTextFile(receiptPath, JSON.stringify(wrongIdentity))
    await assertRejects(
      verify,
      Error,
      'source receipt commit differs',
    )

    const missingProof = JSON.parse(original) as Record<string, unknown>
    delete missingProof.rebuild_proof
    await Deno.writeTextFile(receiptPath, JSON.stringify(missingProof))
    await assertRejects(
      verify,
      Error,
      'invalid rebuild proof binding',
    )

    await Deno.writeTextFile(receiptPath, original)
    const proofPath =
      `${root}/dist/release-inputs/source-proofs/x86_64-unknown-linux-gnu/native-proof.json`
    const originalProof = await Deno.readTextFile(proofPath)
    const staleProof = JSON.parse(originalProof) as { source_commit: string }
    staleProof.source_commit = 'b'.repeat(40)
    await Deno.writeTextFile(proofPath, JSON.stringify(staleProof))
    await assertRejects(
      verify,
      Error,
      'native target proof is stale or mismatched',
    )
    await Deno.writeTextFile(proofPath, originalProof)
    const productReceiptPath = root +
      '/dist/release-inputs/product-runtime/x86_64-unknown-linux-gnu/product-runtime-receipt.json'
    const originalProductReceipt = await Deno.readTextFile(productReceiptPath)
    const changedProductReceipt = JSON.parse(originalProductReceipt) as {
      executable_tar_sha256: string
    }
    changedProductReceipt.executable_tar_sha256 = '0'.repeat(64)
    await Deno.writeTextFile(
      productReceiptPath,
      JSON.stringify(changedProductReceipt),
    )
    await assertRejects(
      verify,
      Error,
      'product runtime receipt differs',
    )
    await Deno.writeTextFile(productReceiptPath, originalProductReceipt)
    const linuxTarget = 'x86_64-unknown-linux-gnu'
    const linuxDirectory =
      `${root}/dist/release-inputs/product-runtime/${linuxTarget}`
    const compatibilityPath =
      `${linuxDirectory}/linux-compatibility-receipt.json`
    const originalCompatibility = await Deno.readTextFile(compatibilityPath)
    const failedCompatibility = JSON.parse(originalCompatibility) as {
      status: string
    }
    failedCompatibility.status = 'failed'
    await Deno.writeTextFile(
      compatibilityPath,
      JSON.stringify(failedCompatibility),
    )
    await assertRejects(
      verify,
      Error,
      'invalid Linux compatibility receipt identity',
    )
    await Deno.writeTextFile(compatibilityPath, originalCompatibility)

    const bridgePath = `${linuxDirectory}/release-bridge-smoke`
    const originalBridge = await Deno.readTextFile(bridgePath)
    await Deno.writeTextFile(bridgePath, 'altered bridge bytes\n')
    await assertRejects(
      verify,
      Error,
      'Linux compatibility bridge bytes differ',
    )
    await Deno.writeTextFile(bridgePath, originalBridge)

    const elfLog = `${linuxDirectory}/linux-compatibility/runtime-version.log`
    const originalElfLog = await Deno.readTextFile(elfLog)
    await Deno.writeTextFile(elfLog, 'GLIBC_2.39\n')
    const excessiveGlibcReceipt = JSON.parse(originalCompatibility) as {
      checks: {
        elf_glibc_ceiling_and_no_private_or_rpath: {
          runtime: { version: { log_sha256: string } }
        }
      }
    }
    excessiveGlibcReceipt.checks.elf_glibc_ceiling_and_no_private_or_rpath
      .runtime.version.log_sha256 = await hashFile(elfLog)
    await Deno.writeTextFile(
      compatibilityPath,
      JSON.stringify(excessiveGlibcReceipt),
    )
    await assertRejects(
      verify,
      Error,
      'Linux compatibility runtime requires GLIBC above 2.27',
    )
    await Deno.writeTextFile(elfLog, originalElfLog)
    await Deno.writeTextFile(compatibilityPath, originalCompatibility)

    const absoluteHelperPath = JSON.parse(originalCompatibility) as {
      checks: {
        elf_glibc_ceiling_and_no_private_or_rpath: {
          runtime: { version: { cwd: string } }
        }
      }
    }
    absoluteHelperPath.checks.elf_glibc_ceiling_and_no_private_or_rpath
      .runtime.version.cwd = '/tmp/source-runner-evidence'
    await Deno.writeTextFile(
      compatibilityPath,
      JSON.stringify(absoluteHelperPath),
    )
    await assertRejects(
      verify,
      Error,
      'Linux compatibility runtime ELF version is not relative to its evidence directory',
    )
    await Deno.writeTextFile(compatibilityPath, originalCompatibility)

    const unexpectedCommand = JSON.parse(originalCompatibility) as {
      checks: {
        elf_glibc_ceiling_and_no_private_or_rpath: {
          runtime: { version: { command: string[] } }
        }
      }
    }
    unexpectedCommand.checks.elf_glibc_ceiling_and_no_private_or_rpath
      .runtime.version.command = ['/bin/true']
    await Deno.writeTextFile(
      compatibilityPath,
      JSON.stringify(unexpectedCommand),
    )
    await assertRejects(
      verify,
      Error,
      'Linux compatibility runtime ELF version has an unexpected readelf command',
    )
    await Deno.writeTextFile(compatibilityPath, originalCompatibility)

    const unexpectedEvidence = `${linuxDirectory}/unexpected-evidence`
    await Deno.writeTextFile(unexpectedEvidence, 'not admitted')
    await assertRejects(
      verify,
      Error,
      'product runtime target has an unexpected evidence set',
    )
    await Deno.remove(unexpectedEvidence)
    await Deno.writeTextFile(
      `${root}/dist/release-inputs/source-materials/slv-source.tar.gz`,
      'changed source material',
    )
    await assertRejects(
      verify,
      Error,
      'source archive bytes differ from receipt',
    )
  } finally {
    await Deno.remove(root, { recursive: true })
  }
}

Deno.test('pack rejects source material with a mismatched identity, proof, or bytes', () =>
  checkProductTampering(false))
Deno.test('Linux validation retains integrated source, product, bridge and ELF tamper controls', () =>
  checkProductTampering(true))

Deno.test('canonical notices bind a producer and are copied unchanged into template and skills', async () => {
  const root = await fixture()
  try {
    const digest = await hashFile(
      `${root}/dist/release-inputs/THIRD_PARTY_NOTICES`,
    )
    await requireLicenses([SHA], { root })
    await assertRejects(
      () => requireLicenses(['b'.repeat(40)], { root }),
      Error,
      'source SHA differs',
    )
    const bundle = await verifyLicenses([SHA, '55', '2', digest], { root })
    const source = await Deno.readFile(
      `${root}/dist/release-inputs/THIRD_PARTY_NOTICES`,
    )
    assertEquals(bundle.size, source.length)
    assertEquals(
      await Deno.readFile(`${root}/template/${VERSION}/THIRD_PARTY_NOTICES`),
      source,
    )
    for (
      const skill of [
        'slv-validator',
        'slv-rpc',
        'slv-grpc-geyser',
        'slv-benchmark',
        'slv-app',
        'slv-bot-trade-app',
        'slv-server-procurement',
        'slv-backup',
        'slv-firewall',
        'slv-wireguard',
      ]
    ) {
      assertEquals(
        await Deno.readFile(
          `${root}/dist/oss-skills/${skill}/THIRD_PARTY_NOTICES`,
        ),
        source,
      )
    }
    await Deno.writeTextFile(
      `${root}/template/${VERSION}/THIRD_PARTY_NOTICES`,
      'wrong package-job bytes\n',
    )
    await materializeLicenses([SHA, '55', '2', digest], {
      root,
      version: VERSION,
    })
    assertEquals(
      await Deno.readFile(`${root}/template/${VERSION}/THIRD_PARTY_NOTICES`),
      source,
    )
    await Deno.writeTextFile(
      `${root}/dist/release-inputs/THIRD_PARTY_NOTICES`,
      'altered',
    )
    await assertRejects(
      () => verifyLicenses([SHA, '55', '2', digest], { root }),
      Error,
      'binding',
    )
  } finally {
    await Deno.remove(root, { recursive: true })
  }
})

Deno.test('license evidence requires actual nonempty texts, keeps declarations separate, and deduplicates only bodies', async () => {
  const root = await fixture()
  try {
    const npm =
      `${root}/node_modules/.deno/@scope+example@1.2.3/node_modules/@scope/example`
    await Deno.writeTextFile(`${npm}/NOTICE`, 'MIT fixture license\n')
    await materializeApplicationNotices(root)
    const evidence = await collectLegalEvidence(root)
    assertEquals(evidence.unresolved, [])
    assert(
      evidence.notices.includes(
        'Declared license expression (not license text): MIT',
      ),
    )
    assert(
      evidence.notices.includes(
        'Evidence path: dist/release-inputs/application-notices/',
      ),
    )
    assert(evidence.notices.includes('identical to npm:@scope/example@1.2.3'))

    await Deno.writeTextFile(`${npm}/LICENSE`, '')
    await Deno.writeTextFile(`${npm}/NOTICE`, '')
    const report = await materializeApplicationNotices(root)
    assertEquals(report.unresolvedActual, ['npm:@scope/example@1.2.3'])
    const missingText = await collectLegalEvidence(root)
    assertEquals(missingText.unresolved, ['npm:@scope/example@1.2.3'])

    await Deno.writeTextFile(`${npm}/LICENSE`, 'MIT fixture license\n')
    await Deno.writeTextFile(
      `${root}/scripts/release/runtime-notices/evidence/deno/LICENSE.md`,
      '',
    )
    await assertRejects(
      () => thirdPartyNotices(root),
      Error,
      'empty runtime notice evidence',
    )
  } finally {
    await Deno.remove(root, { recursive: true })
  }
})

Deno.test('canonical notices retain supplemental provenance and a separate Unicode data component', async () => {
  const root = await fixture()
  try {
    await materializeApplicationNotices(root)
    const evidenceRoot =
      `${root}/dist/release-inputs/application-notices/unicode`
    const dataPath = `${evidenceRoot}/idna.txt`
    const licensePath = `${evidenceRoot}/license.txt`
    const data = 'Copyright (c) 1991-2015 Unicode, Inc.\nIDNA data\n'
    const license = 'UNICODE LICENSE V3\nPermission\n'
    await Deno.mkdir(evidenceRoot, { recursive: true })
    await Deno.writeTextFile(dataPath, data)
    await Deno.writeTextFile(licensePath, license)
    const indexPath = `${root}/dist/release-inputs/license-evidence.json`
    const index = JSON.parse(await Deno.readTextFile(indexPath)) as {
      additional_components?: unknown[]
    }
    index.additional_components = [{
      id: 'unicode:IdnaMappingTable@8.0.0',
      inclusion_basis: 'actual-shipped',
      files: [
        dataPath.slice(`${root}/`.length),
        licensePath.slice(`${root}/`.length),
      ],
      derived_unicode_data: {
        npm_key: 'tr46@0.0.3',
        output_path: 'lib/mappingTable.json',
        output_sha256: 'a'.repeat(64),
        output_bytes: 260049,
        output_rows: 8179,
        generator_path: 'evidence/npm/tr46-generator.js',
        generator_sha256: 'b'.repeat(64),
        source_data_path: 'evidence/unicode/IdnaMappingTable-8.0.0.txt',
        source_data_sha256: await hashFile(dataPath),
        original_attribution: 'Copyright (c) 1991-2015 Unicode, Inc.',
        transform_description:
          'comments removed; ranges and mappings converted to JSON',
        historical_modification_notice:
          'explicit historical modification notice',
        current_distribution_permission:
          'Unicode License V3 is current distribution permission.',
      },
    }]
    await Deno.writeTextFile(indexPath, JSON.stringify(index))

    const evidence = await collectLegalEvidence(root)
    assertEquals(evidence.unresolved, [])
    assert(
      evidence.notices.includes('Component: unicode:IdnaMappingTable@8.0.0'),
    )
    assert(evidence.notices.includes('UNICODE LICENSE V3'))
    assert(evidence.notices.includes('Published output rows: 8179'))
    assert(evidence.notices.includes('Historical modification notice:'))
  } finally {
    await Deno.remove(root, { recursive: true })
  }
})

Deno.test('compiled graph retains executable imports, excludes Dts-only modules, and rejects runtime entries outside the lock', async () => {
  assertEquals(
    compiledModuleGraphFromDenoInfo({
      modules: [
        { specifier: 'jsr:@std/assert@1.0.16' },
        { specifier: 'https://jsr.io/@std/assert/1.0.16/equals.ts' },
        { specifier: 'https://jsr.io/hono/4.7.6/mod.ts' },
        { specifier: 'https://deno.land/x/example@1.0.0/mod.ts' },
        {
          specifier: 'https://deno.land/x/example@1.0.0/types.d.ts',
          mediaType: 'Dts',
        },
      ],
      npmPackages: { '@scope/example@1.2.3': {} },
    }),
    {
      schema_version: 1,
      npm: ['@scope/example@1.2.3'],
      jsr: ['@std/assert@1.0.16', 'hono@4.7.6'],
      remote: ['https://deno.land/x/example@1.0.0/mod.ts'],
    },
  )
  assertThrows(
    () =>
      compiledModuleGraphFromDenoInfo({
        modules: [{ specifier: 'https://jsr.io/@scope/package' }],
        npmPackages: {},
      }),
    Error,
    'invalid scoped package',
  )
  const root = await fixture()
  try {
    await Deno.writeTextFile(
      `${root}/dist/release-inputs/compiled-module-graph.json`,
      JSON.stringify({
        schema_version: 1,
        npm: ['missing@1.0.0'],
        jsr: [],
        remote: [],
      }),
    )
    await assertRejects(
      () => pack([VERSION, SHA, 'refs/heads/main', '55', '2', WHEN], { root }),
      Error,
      'absent from deno.lock',
    )
  } finally {
    await Deno.remove(root, { recursive: true })
  }
})

Deno.test('archive validation rejects links through its binary tar parser', async () => {
  const root = await Deno.makeTempDir({ prefix: 'slv-release-archive-' })
  try {
    await Deno.writeTextFile(`${root}/payload`, 'payload')
    await Deno.symlink('payload', `${root}/link`)
    await run('tar', [
      '-C',
      root,
      '-czf',
      `${root}/unsafe.tar.gz`,
      'payload',
      'link',
    ], root)
    await assertRejects(
      () =>
        assertArchive(`${root}/unsafe.tar.gz`, 'payload', { singleFile: true }),
      Error,
      'forbidden tar entry type',
    )
  } finally {
    await Deno.remove(root, { recursive: true })
  }
})

Deno.test('Linux validation accepts each isolated row through read-only CLI and never admits a partial release', async () => {
  for (const target of LINUX_VALIDATION_TARGETS) {
    const root = await linuxValidationFixture(target)
    try {
      assertEquals(await reviewedSourceVersion(root), VERSION)
      await verifyLinuxValidation([target, SHA], { root })
      const cli = async (args: string[], denyRead?: string) => {
        const output = await new Deno.Command(Deno.execPath(), {
          cwd: root,
          args: [
            'run',
            '--cached-only',
            '--frozen',
            '--no-prompt',
            '--config',
            new URL('../../deno.json', import.meta.url).pathname,
            `--allow-read=${root}`,
            ...(denyRead ? [`--deny-read=${denyRead}`] : []),
            new URL('./release.ts', import.meta.url).pathname,
            ...args,
          ],
          stdout: 'piped',
          stderr: 'piped',
        }).output()
        return { ...output, error: new TextDecoder().decode(output.stderr) }
      }
      const version = await cli(['source-version'])
      assert(version.success, version.error)
      assertEquals(new TextDecoder().decode(version.stdout), `${VERSION}\n`)
      const accepted = await cli(['verify-linux-validation', target, SHA])
      assert(accepted.success, accepted.error)
      const denied = await cli(
        ['verify-linux-validation', target, SHA],
        `${root}/dist/release-inputs/source-proofs/${target}/native-proof.json`,
      )
      assert(!denied.success)
      assert(denied.error.includes('Requires read access'), denied.error)
      for (
        const args of [
          ['x86_64-apple-darwin', SHA],
          [target, SHA, 'aarch64-unknown-linux-gnu'],
          [target, 'invalid'],
        ]
      ) {
        await assertRejects(
          () => verifyLinuxValidation(args, { root }),
          Error,
          'usage:',
        )
      }
      for (
        const [build, ref] of [
          [pack, 'refs/heads/main'],
          [packCi, 'refs/pull/7/merge'],
        ] as const
      ) {
        await assertRejects(
          () => build([VERSION, SHA, ref, '55', '2', WHEN], { root }),
          Error,
          'exactly four target proofs',
        )
      }
      await Deno.writeTextFile(
        `${root}/cli/deno.json`,
        JSON.stringify({ version: '2026.1.1.0001' }),
      )
      await assertRejects(
        () => reviewedSourceVersion(root),
        Error,
        'version differs',
      )
      await assertRejects(
        () => verifyLinuxValidation([target, SHA], { root }),
        Error,
        'version differs',
      )
    } finally {
      await Deno.remove(root, { recursive: true })
    }
  }
})

Deno.test('Linux validation rejects extra, missing and symlinked product rows and evidence', async () => {
  const target = LINUX_VALIDATION_TARGETS[0]
  const root = await linuxValidationFixture(target)
  const base = `${root}/dist/release-inputs/product-runtime`
  const selected = `${base}/${target}`
  const verify = () => verifyLinuxValidation([target, SHA], { root })
  try {
    for (
      const other of [
        'aarch64-unknown-linux-gnu',
        'x86_64-apple-darwin',
        'unexpected',
      ]
    ) {
      await Deno.mkdir(`${base}/${other}`)
      try {
        await assertRejects(
          verify,
          Error,
          'exactly the selected product runtime directory',
        )
      } finally {
        await Deno.remove(`${base}/${other}`)
      }
    }
    const saved = `${root}/saved-product`
    await Deno.rename(selected, saved)
    try {
      await assertRejects(
        verify,
        Error,
        'exactly the selected product runtime directory',
      )
      await Deno.symlink(saved, selected)
      try {
        await assertRejects(
          verify,
          Error,
          'exactly the selected product runtime directory',
        )
      } finally {
        await Deno.remove(selected)
      }
    } finally {
      await Deno.rename(saved, selected)
    }
    const receipt = `${selected}/product-runtime-receipt.json`
    const savedReceipt = `${root}/saved-receipt.json`
    await Deno.rename(receipt, savedReceipt)
    try {
      await assertRejects(verify, Error, 'unexpected evidence set')
      await Deno.mkdir(receipt)
      try {
        await assertRejects(verify, Error, 'not a regular file')
      } finally {
        await Deno.remove(receipt)
      }
      await Deno.symlink(savedReceipt, receipt)
      try {
        await assertRejects(verify, Error, 'contains a symlink')
      } finally {
        await Deno.remove(receipt)
      }
    } finally {
      await Deno.rename(savedReceipt, receipt)
    }
    // Even the other architecture's native proof is mandatory and current.
    const otherProof = `${root}/dist/release-inputs/source-proofs/${
      LINUX_VALIDATION_TARGETS[1]
    }/native-proof.json`
    const original = await Deno.readTextFile(otherProof)
    const stale = JSON.parse(original)
    stale.source_commit = 'b'.repeat(40)
    await Deno.writeTextFile(otherProof, JSON.stringify(stale))
    await assertRejects(
      verify,
      Error,
      'native target proof is stale or mismatched',
    )
    await Deno.writeTextFile(otherProof, original)
    await verify()
  } finally {
    await Deno.remove(root, { recursive: true })
  }
})

Deno.test('Linux validation binds every product identity and strictly checks rehashed archives', async () => {
  const target = LINUX_VALIDATION_TARGETS[0]
  const root = await linuxValidationFixture(target)
  const receiptPath =
    `${root}/dist/release-inputs/product-runtime/${target}/product-runtime-receipt.json`
  const archivePath = `${root}/dist/slv-${target}-exe.tar.gz`
  const verify = () => verifyLinuxValidation([target, SHA], { root })
  try {
    const original = await Deno.readTextFile(receiptPath)
    for (
      const field of [
        'target',
        'executable_sha256',
        'executable_tar_sha256',
        'baseline_denort_sha256',
        'source_selected_cargo_lock_sha256',
        'derived_relink_cargo_lock_sha256',
        'source_receipt_sha256',
        'native_proof_sha256',
        'build_receipt_sha256',
      ]
    ) {
      const receipt = JSON.parse(original)
      receipt[field] = field === 'target'
        ? LINUX_VALIDATION_TARGETS[1]
        : '0'.repeat(64)
      await Deno.writeTextFile(receiptPath, JSON.stringify(receipt))
      await assertRejects(verify, Error, 'product runtime receipt differs')
    }
    await Deno.writeTextFile(receiptPath, original)
    const originalArchive = await Deno.readFile(archivePath)
    await Deno.writeTextFile(archivePath, 'changed archive bytes')
    await assertRejects(verify, Error, 'product runtime receipt differs')
    const executableName = `slv-${target}-exe`
    const binary = `${root}/${executableName}`
    await Deno.writeTextFile(binary, 'different executable bytes')
    await packExecutable(binary, archivePath, executableName)
    const receipt = JSON.parse(original)
    receipt.executable_tar_sha256 = await hashFile(archivePath)
    await Deno.writeTextFile(receiptPath, JSON.stringify(receipt))
    await assertRejects(verify, Error, 'product runtime receipt differs')
    await Deno.writeTextFile(`${root}/extra`, 'extra archive member')
    await run(
      'tar',
      [
        '--format=ustar',
        '-C',
        root,
        '-czf',
        archivePath,
        executableName,
        'extra',
      ],
      root,
    )
    receipt.executable_tar_sha256 = await hashFile(archivePath)
    await Deno.writeTextFile(receiptPath, JSON.stringify(receipt))
    await assertRejects(verify, Error, 'entry outside')
    await Deno.remove(binary)
    await Deno.symlink('extra', binary)
    await run('tar', [
      '--format=ustar',
      '-C',
      root,
      '-czf',
      archivePath,
      executableName,
    ], root)
    receipt.executable_tar_sha256 = await hashFile(archivePath)
    await Deno.writeTextFile(receiptPath, JSON.stringify(receipt))
    await assertRejects(verify, Error, 'forbidden tar entry type')
    await Deno.writeFile(archivePath, originalArchive)
    await Deno.writeTextFile(receiptPath, original)
    await verify()
  } finally {
    await Deno.remove(root, { recursive: true })
  }
})

Deno.test('Linux validation checks pinned sysroots, license bytes and native runtime smoke evidence', async () => {
  const target = LINUX_VALIDATION_TARGETS[0]
  const root = await linuxValidationFixture(target)
  const base = `${root}/dist/release-inputs/product-runtime/${target}`
  const path = `${base}/linux-compatibility-receipt.json`
  const verify = () => verifyLinuxValidation([target, SHA], { root })
  try {
    const original = await Deno.readTextFile(path)
    for (
      const field of ['deno_sysroot_archive_sha256', 'deno_sysroot_env_sha256']
    ) {
      const receipt = JSON.parse(original)
      receipt.toolchain[field] = '0'.repeat(64)
      await Deno.writeTextFile(path, JSON.stringify(receipt))
      await assertRejects(verify, Error, 'differs from target evidence')
    }
    const wrongLibraries = JSON.parse(original)
    wrongLibraries.toolchain.library_path = '/lib:/usr/lib'
    await Deno.writeTextFile(path, JSON.stringify(wrongLibraries))
    await assertRejects(verify, Error, 'invalid pinned sysroot')
    const licenses = JSON.parse(original)
    const licensePath = `${base}/linux-compatibility/licenses.log`
    const licenseBytes = await Deno.readFile(licensePath)
    await Deno.writeTextFile(licensePath, 'different license bytes\n')
    licenses.checks.older_loader_licenses.log_sha256 = await hashFile(
      licensePath,
    )
    await Deno.writeTextFile(path, JSON.stringify(licenses))
    await assertRejects(
      verify,
      Error,
      'licenses bytes differ from canonical notice',
    )
    await Deno.writeFile(licensePath, licenseBytes)
    for (const phase of ['compile', 'execute']) {
      const receipt = JSON.parse(original)
      receipt.checks.source_built_runtime_crypto_subprocess_loopback_tls[phase]
        .command = ['/bin/true']
      await Deno.writeTextFile(path, JSON.stringify(receipt))
      await assertRejects(
        verify,
        Error,
        phase === 'compile'
          ? 'unexpected compile command'
          : 'unexpected loader command',
      )
    }
    await Deno.writeTextFile(path, original)
    const smokeLog = `${base}/linux-compatibility/smoke-execute.log`
    const smokeBytes = await Deno.readFile(smokeLog)
    await Deno.writeTextFile(smokeLog, 'tampered smoke output\n')
    await assertRejects(
      verify,
      Error,
      'runtime smoke execute log checksum differs',
    )
    await Deno.writeFile(smokeLog, smokeBytes)
    await verify()
  } finally {
    await Deno.remove(root, { recursive: true })
  }
})
