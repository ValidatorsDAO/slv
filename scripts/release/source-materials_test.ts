import { assertRejects, assertThrows } from 'jsr:@std/assert@1'
import {
  assertPins,
  assertPureSourceTree,
  assertSecuritySelection,
  assertSourceClosure,
  deterministicArchive,
  normalizeDenoRemoteMetadata,
  parseSelectedVendorCoverage,
  pruneDenoEphemeralCache,
  sha256,
  SOURCE_PROOF_TARGETS,
  verifyInventory,
  verifyNativeSourceRebuildProof,
  verifyPinnedArchive,
  verifyReceiptFiles,
  verifySourceMaterialsReceipt,
  verifySourceProofSet,
  writeInventory,
} from './source-materials.ts'
import { canonicalTargetDescriptorBytes } from '../../source-rebuild/prepare-tools.ts'

Deno.test('pins require immutable commit-bound HTTPS archives', () => {
  assertThrows(() =>
    assertPins({ schema_version: 1, deno: {}, rusty_v8: {}, v8: {} })
  )
  assertThrows(() =>
    assertPins({
      schema_version: 1,
      deno: {
        commit: 'a'.repeat(40),
        sha256: 'b'.repeat(64),
        archive: 'https://github.com/denoland/deno/archive/main.tar.gz',
      },
      rusty_v8: {
        commit: 'a'.repeat(40),
        sha256: 'b'.repeat(64),
        archive: 'https://github.com/x/a/archive/a'.repeat(40),
      },
      v8: {
        commit: 'a'.repeat(40),
        sha256: 'b'.repeat(64),
        archive: 'https://github.com/x/a/archive/a'.repeat(40),
      },
    })
  )
})

Deno.test('security selection uses its checked-in snake-case transform records', async () => {
  const path = new URL(
    '../../source-materials/security/selection.json',
    import.meta.url,
  )
  const selection = JSON.parse(await Deno.readTextFile(path)) as {
    transform: Record<string, unknown>
  }
  const digest = await sha256(path.pathname)
  assertSecuritySelection(selection, digest)

  const missing = JSON.parse(JSON.stringify(selection)) as {
    transform: Record<string, unknown>
  }
  delete missing.transform.manifest_patch
  assertThrows(() => assertSecuritySelection(missing, digest))
})

Deno.test('selected source-vendor receipt covers a conservative crate by archive checksum', async () => {
  const path = new URL(
    './runtime-notices/evidence/selected-registry-source-coverage.json',
    import.meta.url,
  )
  const coverage = JSON.parse(await Deno.readTextFile(path))
  const selectedLock =
    '09afc50a2481cea2e77e0d27eff26db844362067bfbc51357f3927d49cbf815d'
  const parsed = parseSelectedVendorCoverage(coverage, selectedLock)
  const addr2line = parsed.identities.get('addr2line@0.24.2')
  if (
    !addr2line || addr2line.component !== 'cargo:addr2line@0.24.2' ||
    addr2line.archiveSha256 !==
      'dfbe277e56a376000877090da837660b4427aad530e3028d44e0bffe4f89a1c1'
  ) throw new Error('selected source-vendor receipt lost addr2line evidence')

  const wrongLock = JSON.parse(JSON.stringify(coverage))
  wrongLock.cargo_lock_sha256 = '0'.repeat(64)
  assertThrows(() => parseSelectedVendorCoverage(wrongLock, selectedLock))
})

Deno.test('source package removes only Deno cache entries that embed assembly state', async () => {
  const root = await Deno.makeTempDir()
  try {
    await Deno.mkdir(root + '/remote/https/example.test', { recursive: true })
    await Deno.writeTextFile(
      root + '/remote/https/example.test/module.ts',
      'export {}\n',
    )
    await Deno.mkdir(root + '/gen/file/absolute-path', { recursive: true })
    await Deno.writeTextFile(
      root + '/gen/file/absolute-path/module.js',
      'generated',
    )
    for (
      const name of [
        'dep_analysis_cache_v2',
        'dep_analysis_cache_v2-shm',
        'dep_analysis_cache_v2-wal',
        'node_analysis_cache_v2',
        'node_analysis_cache_v2-shm',
        'node_analysis_cache_v2-wal',
        'v8_code_cache_v2',
        'v8_code_cache_v2-shm',
        'v8_code_cache_v2-wal',
      ]
    ) await Deno.writeTextFile(root + '/' + name, 'ephemeral')

    await pruneDenoEphemeralCache(root)
    await Deno.stat(root + '/remote/https/example.test/module.ts')
    await assertRejects(() => Deno.stat(root + '/gen'))
    await assertRejects(() => Deno.stat(root + '/dep_analysis_cache_v2'))
  } finally {
    await Deno.remove(root, { recursive: true })
  }
})

Deno.test('source package canonicalizes volatile Deno remote cache metadata', async () => {
  const root = await Deno.makeTempDir()
  const first = `${root}/remote/https/first`
  const second = `${root}/remote/https/second`
  const source = 'export const locked = true\n'
  const cacheEntry = (headers: Record<string, string>, time: number) =>
    source + '\n// denoCacheMetadata=' + JSON.stringify({
      headers,
      url: 'https://example.test/module.ts',
      time,
    })
  try {
    await Deno.mkdir(`${root}/remote/https`, { recursive: true })
    await Deno.writeTextFile(
      first,
      cacheEntry({
        date: 'Mon, 01 Jan 2024 00:00:00 GMT',
        'content-type': 'application/typescript',
        'x-deno-trace-id': 'first',
        'x-typescript-types': './types.d.ts',
      }, 1),
    )
    await Deno.writeTextFile(
      second,
      cacheEntry({
        'x-typescript-types': './types.d.ts',
        'x-deno-trace-id': 'second',
        'content-type': 'application/typescript',
        date: 'Tue, 02 Jan 2024 00:00:00 GMT',
      }, 2),
    )

    await normalizeDenoRemoteMetadata(root)
    const [one, two] = await Promise.all([
      Deno.readTextFile(first),
      Deno.readTextFile(second),
    ])
    if (one !== two || !one.startsWith(source)) {
      throw new Error('volatile Deno remote metadata was retained')
    }
    const expected = source + '\n// denoCacheMetadata=' + JSON.stringify({
      headers: {
        'content-type': 'application/typescript',
        'x-typescript-types': './types.d.ts',
      },
      url: 'https://example.test/module.ts',
      time: 0,
    })
    if (one !== expected) {
      throw new Error(
        'Deno remote metadata normalization changed semantic fields',
      )
    }
  } finally {
    await Deno.remove(root, { recursive: true })
  }
})

Deno.test('source archives materialize hardlink aliases as regular files while retaining symlinks', async () => {
  const parent = await Deno.makeTempDir()
  const archive = `${parent}/source.tar.gz`
  try {
    const root = `${parent}/source`
    await Deno.mkdir(root)
    await Deno.writeTextFile(`${root}/canonical.txt`, 'same bytes\n')
    await Deno.link(`${root}/canonical.txt`, `${root}/inode-alias.txt`)
    await Deno.symlink('./canonical.txt', `${root}/source-link.txt`)

    await deterministicArchive(parent, 'source', archive, 1)
    const listed = await new Deno.Command('tar', {
      args: ['-tvzf', archive],
      stdout: 'piped',
      stderr: 'piped',
    }).output()
    if (!listed.success) {
      throw new Error(new TextDecoder().decode(listed.stderr))
    }
    const lines = new TextDecoder().decode(listed.stdout).split('\n')
    if (lines.some((line) => line.startsWith('h'))) {
      throw new Error('source archive retained a hardlink record')
    }
    if (
      !lines.some((line) =>
        line.startsWith('-') && line.includes('inode-alias.txt')
      ) ||
      !lines.some((line) =>
        line.startsWith('l') && line.includes('source-link.txt')
      )
    ) {
      throw new Error('source archive did not preserve file/link semantics')
    }
  } finally {
    await Deno.remove(parent, { recursive: true })
  }
})

Deno.test('inventory rejects drift and pin verification rejects the wrong bytes', async () => {
  const root = await Deno.makeTempDir()
  const inventory = `${root}.inventory.json`
  try {
    await Deno.writeTextFile(`${root}/input`, 'known source\n')
    await writeInventory(root, inventory)
    await verifyInventory(root, inventory)
    await Deno.writeTextFile(`${root}/input`, 'altered source\n')
    await assertRejects(() => verifyInventory(root, inventory))
    const digest = await sha256(`${root}/input`)
    await verifyPinnedArchive(`${root}/input`, {
      commit: 'a'.repeat(40),
      archive: `https://github.com/x/y/archive/${'a'.repeat(40)}.tar.gz`,
      sha256: digest,
    })
    await assertRejects(() =>
      verifyPinnedArchive(`${root}/input`, {
        commit: 'a'.repeat(40),
        archive: `https://github.com/x/y/archive/${'a'.repeat(40)}.tar.gz`,
        sha256: '0'.repeat(64),
      })
    )
  } finally {
    await Deno.remove(root, { recursive: true })
    await Deno.remove(inventory).catch(() => undefined)
  }
})

Deno.test('closure rejects empty source directories, LFS pointers, and escaping links', async () => {
  const root = await Deno.makeTempDir()
  try {
    await Deno.mkdir(`${root}/submodule`)
    await assertRejects(() => assertSourceClosure(root, ['submodule']))
    await Deno.writeTextFile(`${root}/submodule/source`, 'ok')
    await Deno.writeTextFile(
      `${root}/pointer`,
      'version https://git-lfs.github.com/spec/v1\n',
    )
    await assertRejects(() => assertSourceClosure(root, ['submodule']))
    await Deno.remove(`${root}/pointer`)
    await Deno.symlink('/tmp', `${root}/escape`)
    await assertRejects(() => writeInventory(root, `${root}.inventory`))
  } finally {
    await Deno.remove(root, { recursive: true })
  }
})

Deno.test('inventory preserves in-root dangling symlinks and rejects cycles or non-directory traversal', async () => {
  const root = await Deno.makeTempDir()
  try {
    await Deno.writeTextFile(root + '/file', 'source')
    await Deno.symlink('./missing-fixture', root + '/dangling')
    await writeInventory(root, root + '.inventory.json')

    await Deno.symlink('./cycle-b', root + '/cycle-a')
    await Deno.symlink('./cycle-a', root + '/cycle-b')
    await assertRejects(
      () => writeInventory(root, root + '.cycle.json'),
      Error,
      'cyclic source symlink',
    )
    await Deno.remove(root + '/cycle-a')
    await Deno.remove(root + '/cycle-b')

    await Deno.mkdir(root + '/xdir')
    await Deno.mkdir(root + '/target')
    await Deno.symlink('../target', root + '/xdir/a')
    await Deno.symlink('xdir/a/../../outside', root + '/component-escape')
    await assertRejects(
      () => writeInventory(root, root + '.component-escape.json'),
      Error,
      'unsafe source symlink target',
    )
    await Deno.remove(root + '/component-escape')
    await Deno.remove(root + '/xdir', { recursive: true })

    await Deno.symlink('./file/not-a-directory', root + '/non-directory')
    await assertRejects(
      () => writeInventory(root, root + '.non-directory.json'),
      Error,
      'traverses a non-directory',
    )
  } finally {
    await Deno.remove(root, { recursive: true })
  }
})

Deno.test('pure source gate rejects only known generated roots and repository metadata', async () => {
  const root = await Deno.makeTempDir()
  try {
    await Deno.mkdir(`${root}/fixture/target`, { recursive: true })
    await Deno.writeTextFile(`${root}/fixture/target/source`, 'tracked fixture')
    await assertPureSourceTree(root)
    await Deno.mkdir(`${root}/deno/target`, { recursive: true })
    await assertRejects(() => assertPureSourceTree(root), Error, 'deno/target')
    await Deno.remove(`${root}/deno`, { recursive: true })
    await Deno.mkdir(`${root}/rusty_v8/.git`, { recursive: true })
    await assertRejects(
      () => assertPureSourceTree(root),
      Error,
      'repository metadata',
    )
  } finally {
    await Deno.remove(root, { recursive: true })
  }
})

Deno.test('release receipt binds exactly three small source archives and rejects separate native proof', async () => {
  const root = await Deno.makeTempDir()
  const digest = 'a'.repeat(64)
  const commit = 'b'.repeat(40)
  const receipt = {
    schema_version: 1,
    kind: 'slv-source-materials',
    mode: 'reviewed',
    source: {
      commit,
      tree_sha256: digest,
      timestamp: '2026-10-13T00:00:00Z',
      timestamp_epoch: 1,
    },
    canonical_notice: {
      path: 'dist/release-inputs/THIRD_PARTY_NOTICES',
      sha256: digest,
      size: 1,
    },
    pins: {
      schema_version: 1,
      sha256: digest,
      deno: {
        version: '2.9.3',
        commit,
        archive:
          'https://github.com/denoland/deno/releases/download/v2.9.3/deno_src.tar.gz',
        sha256: digest,
      },
      rusty_v8: {
        commit,
        archive:
          `https://github.com/denoland/rusty_v8/archive/${commit}.tar.gz`,
        sha256: digest,
      },
      v8: {
        commit,
        archive: `https://github.com/denoland/v8/archive/${commit}.tar.gz`,
        sha256: digest,
      },
    },
    closure: {
      embedded_path: 'source-materials/closure.json',
      sha256: digest,
      entry_count: 1,
    },
    inventory: {
      embedded_path: 'source-materials/inventory.json',
      sha256: digest,
    },
    vendor: {
      policy: 'full-locked-vendor',
      lock_path: 'Cargo.lock',
      lock_sha256: digest,
      crate_count: 1,
      omissions: [],
    },
    runtime_security: testRuntimeSecurity(digest),
    assets: [
      {
        name: 'slv-source.tar.gz',
        sha256: digest,
        size: 1,
        embedded_manifest_path: 'source-materials/inventory.json',
      },
      {
        name: 'deno-source.tar.gz',
        sha256: digest,
        size: 1,
        embedded_manifest_path: 'source-materials/inventory.json',
      },
      {
        name: 'deno-cargo-vendor.tar.gz',
        sha256: digest,
        size: 1,
        embedded_manifest_path: 'source-materials/inventory.json',
      },
    ],
    rebuild_proof: { required: true, status: 'separate' },
  }
  try {
    verifySourceMaterialsReceipt(receipt, {
      sourceCommit: commit,
      canonicalNoticeSha256: digest,
    })
    assertThrows(
      () =>
        verifySourceMaterialsReceipt(receipt, {
          requireVerifiedRebuildProof: true,
        }),
      Error,
      'native rebuild proof',
    )
    await Deno.writeTextFile(`${root}/slv-source.tar.gz`, 'x')
    await Deno.writeTextFile(`${root}/deno-source.tar.gz`, 'x')
    await Deno.writeTextFile(`${root}/deno-cargo-vendor.tar.gz`, 'x')
    await assertRejects(
      () => verifyReceiptFiles(receipt, root),
      Error,
      'source archive bytes differ',
    )
  } finally {
    await Deno.remove(root, { recursive: true })
  }
})

async function textHash(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text)
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return [...new Uint8Array(digest)].map((byte) =>
    byte.toString(16).padStart(2, '0')
  ).join('')
}

const testCommand = {
  command: ['test', '--offline'],
  cwd: '/work',
  started_at: '2026-10-13T00:00:00Z',
  finished_at: '2026-10-13T00:00:01Z',
  exit_code: 0,
  log: '/work/command.log',
  log_sha256: 'f'.repeat(64),
}

function testRuntimeAbi(target: string, denortSha256: string) {
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

function testChecks(
  canonicalNoticeSha256: string,
  target: string,
  artifacts: ReturnType<typeof testArtifacts>,
) {
  return {
    baseline_build: {
      passed: true,
      command: testCommand,
      runtime_abi: testRuntimeAbi(target, artifacts.baseline.denort_sha256),
      runtime_abi_receipt_sha256: 'd'.repeat(64),
    },
    baseline_probe: {
      passed: true,
      sentinel: { input: 0.125, output: 0.124, command: testCommand },
      control: { input: 0.126, output: 0.125, command: testCommand },
    },
    patch: {
      passed: true,
      before_sha256: '1'.repeat(64),
      after_sha256: '2'.repeat(64),
      command: testCommand,
    },
    modified_build: {
      passed: true,
      command: testCommand,
      runtime_abi: testRuntimeAbi(target, artifacts.modified.denort_sha256),
      runtime_abi_receipt_sha256: 'e'.repeat(64),
    },
    modified_probe: {
      passed: true,
      sentinel: { input: 0.125, output: 0.5, command: testCommand },
      control: { input: 0.126, output: 0.125, command: testCommand },
    },
    slv_compile: { passed: true, command: testCommand },
    slv_version: { passed: true, command: testCommand },
    slv_help: { passed: true, command: testCommand },
    release_bridge: {
      passed: true,
      compile: testCommand,
      command: testCommand,
    },
    licenses: {
      passed: true,
      canonical_notice_sha256: canonicalNoticeSha256,
      command: testCommand,
    },
  }
}

function testRuntimeSecurity(digest: string) {
  return {
    upstream: {
      cargo_lock: {
        path: 'source-materials/security/upstream-Cargo.lock',
        sha256: digest,
        package_count: 1125,
      },
      cargo_manifest: {
        path: 'source-materials/security/upstream-Cargo.toml',
        sha256: digest,
      },
    },
    selected: {
      cargo_lock: {
        path: 'deno/Cargo.lock',
        sha256: digest,
        package_count: 1126,
      },
      cargo_manifest: { path: 'deno/Cargo.toml', sha256: digest },
    },
    transform: {
      selection: {
        path: 'source-materials/security/selection.json',
        sha256: digest,
      },
      manifest_patch: {
        path: 'source-materials/security/manifest-patch.json',
        sha256: digest,
      },
      resolution_receipt: {
        path: 'source-materials/security/resolution-receipt.json',
        sha256: digest,
      },
      added_identities_osv: {
        path: 'source-materials/security/added-identities-osv.json',
        sha256: digest,
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

function testArtifacts() {
  return {
    baseline: {
      denort_sha256: '3'.repeat(64),
      v8_archive_sha256: '4'.repeat(64),
      ninja_sha256: '5'.repeat(64),
      probe_standalone_sha256: '6'.repeat(64),
      slv_executable_sha256: 'b'.repeat(64),
      bridge_standalone_sha256: 'c'.repeat(64),
      derived_relink_cargo_lock_sha256: 'd'.repeat(64),
    },
    modified: {
      denort_sha256: '7'.repeat(64),
      v8_archive_sha256: '8'.repeat(64),
      ninja_sha256: '9'.repeat(64),
      probe_standalone_sha256: 'a'.repeat(64),
    },
  }
}

Deno.test('four target proofs bind source bytes and reject a transported-artifact mismatch', async () => {
  const root = await Deno.makeTempDir()
  const commit = 'd'.repeat(40)
  const sha = 'e'.repeat(64)
  const sourceDirectory = `${root}/source-materials`
  const proofDirectory = `${root}/source-proofs`
  const toolPinsDirectory = `${root}/tool-pins`
  const noticePath = `${root}/THIRD_PARTY_NOTICES`
  const pinsPath = `${root}/source-pins.json`
  const reviewedToolPinsPath = `${root}/tool-prereqs.json`
  const receiptPath = `${root}/source-materials-receipt.json`
  try {
    await Deno.mkdir(sourceDirectory, { recursive: true })
    await Deno.mkdir(toolPinsDirectory, { recursive: true })
    await Deno.copyFile(
      new URL('../../source-rebuild/tool-prereqs.json', import.meta.url),
      reviewedToolPinsPath,
    )
    const reviewedToolPins = JSON.parse(
      await Deno.readTextFile(reviewedToolPinsPath),
    )
    await Deno.writeTextFile(noticePath, 'canonical notices\n')
    const noticeHash = await sha256(noticePath)
    const pins = {
      schema_version: 1,
      deno: {
        version: '2.9.3',
        commit,
        archive:
          'https://github.com/denoland/deno/releases/download/v2.9.3/deno_src.tar.gz',
        sha256: sha,
      },
      rusty_v8: {
        commit,
        archive:
          `https://github.com/denoland/rusty_v8/archive/${commit}.tar.gz`,
        sha256: sha,
      },
      v8: {
        commit,
        archive: `https://github.com/denoland/v8/archive/${commit}.tar.gz`,
        sha256: sha,
      },
    }
    await Deno.writeTextFile(pinsPath, JSON.stringify(pins))
    const pinsHash = await sha256(pinsPath)
    const names = [
      'slv-source.tar.gz',
      'deno-source.tar.gz',
      'deno-cargo-vendor.tar.gz',
    ] as const
    const assets = await Promise.all(names.map(async (name) => {
      const text = `fixture ${name}\n`
      const path = `${sourceDirectory}/${name}`
      await Deno.writeTextFile(path, text)
      return {
        name,
        sha256: await sha256(path),
        size: new TextEncoder().encode(text).length,
        embedded_manifest_path: 'source-materials/pack-manifest.json',
      }
    }))
    const receipt = {
      schema_version: 1,
      kind: 'slv-source-materials',
      mode: 'reviewed',
      source: {
        commit,
        tree_sha256: sha,
        timestamp: '2026-10-13T00:00:00Z',
        timestamp_epoch: 1,
      },
      canonical_notice: {
        path: 'THIRD_PARTY_NOTICES',
        sha256: noticeHash,
        size: 18,
      },
      pins: { ...pins, sha256: pinsHash },
      closure: {
        embedded_path: 'source-materials/closure.json',
        sha256: sha,
        entry_count: 1,
      },
      inventory: {
        embedded_path: 'source-materials/inventory.json',
        sha256: sha,
      },
      vendor: {
        policy: 'full-locked-vendor',
        lock_path: 'Cargo.lock',
        lock_sha256: sha,
        crate_count: 1,
        omissions: [],
      },
      runtime_security: testRuntimeSecurity(sha),
      assets,
      rebuild_proof: { required: true, status: 'separate' },
    }
    await Deno.writeTextFile(receiptPath, JSON.stringify(receipt))
    const receiptHash = await sha256(receiptPath)
    for (const target of SOURCE_PROOF_TARGETS) {
      const targetRoot = `${proofDirectory}/${target}`
      await Deno.mkdir(targetRoot, { recursive: true })
      const toolPin = `${toolPinsDirectory}/${target}.json`
      await Deno.writeFile(
        toolPin,
        canonicalTargetDescriptorBytes(reviewedToolPins, target),
      )
      const toolPinHash = await sha256(toolPin)
      const artifacts = testArtifacts()
      const checks = testChecks(noticeHash, target, artifacts)
      const targetHost = target.includes('apple')
        ? { os: 'darwin', arch: target.startsWith('x86_64') ? 'x64' : 'arm64' }
        : { os: 'linux', arch: target.startsWith('x86_64') ? 'x64' : 'arm64' }
      const build = {
        schema_version: 1,
        kind: 'slv-source-build-receipt',
        target,
        build_mode: 'native',
        build_host: targetHost,
        source_commit: commit,
        source_receipt_sha256: receiptHash,
        source_assets: assets.map(({ name, sha256, size }) => ({
          name,
          sha256,
          size,
        })),
        source_pin_sha256: pinsHash,
        source_selected_cargo_lock_sha256: sha,
        tool_pin_sha256: toolPinHash,
        patch_sha256: '0'.repeat(64),
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
        build_receipt_sha256: await sha256(buildPath),
        execution_host: targetHost,
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
          source_commit: commit,
          source_receipt_sha256: receiptHash,
          source_assets: assets.map(({ name, sha256, size }) => ({
            name,
            sha256,
            size,
          })),
          build_mode: 'native',
          build_host: targetHost,
          execution_host: targetHost,
          source_pin_sha256: pinsHash,
          source_selected_cargo_lock_sha256: sha,
          tool_pin_sha256: toolPinHash,
          patch_sha256: '0'.repeat(64),
          jobs: '2',
          build_receipt_sha256: await sha256(buildPath),
          execution_receipt_sha256: await sha256(executionPath),
          build_artifacts: artifacts,
          execution_artifacts: artifacts,
          artifacts,
          checks,
          status: 'passed',
        }),
      )
    }
    await verifySourceProofSet({
      sourceReceiptPath: receiptPath,
      sourceDirectory,
      proofDirectory,
      sourceCommit: commit,
      sourcePinsPath: pinsPath,
      toolPinsDirectory,
      canonicalNoticePath: noticePath,
      reviewedToolPinsPath,
    })
    const proofPath =
      `${proofDirectory}/x86_64-unknown-linux-gnu/native-proof.json`
    const originalProof = JSON.parse(await Deno.readTextFile(proofPath))
    const badProbe = structuredClone(originalProof)
    badProbe.checks.modified_probe.sentinel.output = 0.499
    assertThrows(
      () => verifyNativeSourceRebuildProof(badProbe),
      Error,
      'modified native probe did not return sentinel value',
    )
    const badAbi = structuredClone(originalProof)
    badAbi.checks.baseline_build.runtime_abi.glibc_versions = ['2.39']
    assertThrows(
      () => verifyNativeSourceRebuildProof(badAbi),
      Error,
      'baseline build Linux runtime ABI exceeds GLIBC 2.27',
    )
    const invalidJobs = structuredClone(originalProof)
    invalidJobs.jobs = '17'
    assertThrows(
      () => verifyNativeSourceRebuildProof(invalidJobs),
      Error,
      'native target proof has an invalid bounded build jobs value',
    )
    const badLicense = structuredClone(originalProof)
    badLicense.checks.licenses.canonical_notice_sha256 = '0'.repeat(64)
    await Deno.writeTextFile(proofPath, JSON.stringify(badLicense))
    await assertRejects(
      () =>
        verifySourceProofSet({
          sourceReceiptPath: receiptPath,
          sourceDirectory,
          proofDirectory,
          sourceCommit: commit,
          sourcePinsPath: pinsPath,
          toolPinsDirectory,
          canonicalNoticePath: noticePath,
          reviewedToolPinsPath,
        }),
      Error,
      'licenses differ from canonical notice',
    )
    await Deno.writeTextFile(proofPath, JSON.stringify(originalProof))
    const phaseJobsMismatch = structuredClone(originalProof)
    phaseJobsMismatch.jobs = '3'
    await Deno.writeTextFile(proofPath, JSON.stringify(phaseJobsMismatch))
    await assertRejects(
      () =>
        verifySourceProofSet({
          sourceReceiptPath: receiptPath,
          sourceDirectory,
          proofDirectory,
          sourceCommit: commit,
          sourcePinsPath: pinsPath,
          toolPinsDirectory,
          canonicalNoticePath: noticePath,
          reviewedToolPinsPath,
        }),
      Error,
      'native build receipt does not bind x86_64-unknown-linux-gnu proof inputs',
    )
    await Deno.writeTextFile(proofPath, JSON.stringify(originalProof))
    const descriptorPath = `${toolPinsDirectory}/x86_64-unknown-linux-gnu.json`
    const originalDescriptor = await Deno.readFile(descriptorPath)
    await Deno.writeTextFile(descriptorPath, 'altered descriptor\n')
    await assertRejects(
      () =>
        verifySourceProofSet({
          sourceReceiptPath: receiptPath,
          sourceDirectory,
          proofDirectory,
          sourceCommit: commit,
          sourcePinsPath: pinsPath,
          toolPinsDirectory,
          canonicalNoticePath: noticePath,
          reviewedToolPinsPath,
        }),
      Error,
      'descriptor differs from reviewed tool pins',
    )
    await Deno.writeFile(descriptorPath, originalDescriptor)
    const altered = structuredClone(originalProof)
    altered.execution_artifacts.modified.denort_sha256 = await textHash(
      'replaced artifact',
    )
    await Deno.writeTextFile(proofPath, JSON.stringify(altered))
    await assertRejects(
      () =>
        verifySourceProofSet({
          sourceReceiptPath: receiptPath,
          sourceDirectory,
          proofDirectory,
          sourceCommit: commit,
          sourcePinsPath: pinsPath,
          toolPinsDirectory,
          canonicalNoticePath: noticePath,
          reviewedToolPinsPath,
        }),
      Error,
      'execution artifacts differ',
    )
  } finally {
    await Deno.remove(root, { recursive: true })
  }
})
