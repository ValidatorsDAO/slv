import { createHash } from 'node:crypto'
import {
  assertSafeTree,
  emitNativeTargetProof,
  extractArchive,
  prepareBuildDirectories,
  resolveSourceArchivePaths,
  scanArchiveForUnsafeMembers,
} from './verify-native.ts'
import { verifyNativeSourceRebuildProof } from '../scripts/release/source-materials.ts'
import { expandEnvironment, materializeLayoutCopies } from './prepare-tools.ts'

async function createArchive(
  archive: string,
  linkTarget: string,
): Promise<void> {
  const program = String.raw`
import io
import sys
import tarfile

archive, link_target = sys.argv[1:]
with tarfile.open(archive, 'w:gz') as payload:
    root = tarfile.TarInfo('deno-source')
    root.type = tarfile.DIRTYPE
    root.mode = 0o755
    payload.addfile(root)
    fixture = tarfile.TarInfo('deno-source/fixture')
    fixture.type = tarfile.DIRTYPE
    fixture.mode = 0o755
    payload.addfile(fixture)
    target = tarfile.TarInfo('deno-source/fixture/target.txt')
    target.mode = 0o644
    target.size = len(b'checked source bytes')
    payload.addfile(target, io.BytesIO(b'checked source bytes'))
    # This is intentionally the same shape as Deno's upstream dangling
    # fixture: it is lexically contained in the archive root but need not
    # resolve on disk at packaging time.
    dangling = tarfile.TarInfo('deno-source/fixture/copy_dir_link_file')
    dangling.type = tarfile.SYMTYPE
    dangling.linkname = link_target
    payload.addfile(dangling)
`
  const created = await new Deno.Command('/usr/bin/python3', {
    args: ['-c', program, archive, linkTarget],
    clearEnv: true,
    env: { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C', TZ: 'UTC' },
    stdout: 'piped',
    stderr: 'piped',
  }).output()
  if (!created.success) {
    throw new Error(new TextDecoder().decode(created.stderr))
  }
}

Deno.test('safe dangling Deno fixture symlink is scanned and extracted verbatim', async () => {
  const root = await Deno.makeTempDir({ prefix: 'slv-native-safe-link-' })
  try {
    const archive = `${root}/deno-source.tar.gz`
    const destination = `${root}/extract`
    await Deno.mkdir(destination)
    await createArchive(archive, './fs/testdata/copy_dir/0.txt')

    const scan = await scanArchiveForUnsafeMembers(
      archive,
      'deno-source',
      destination,
      `${root}/scan.log`,
    )
    if (scan.exit_code !== 0) throw new Error('safe archive scan failed')
    await extractArchive(
      archive,
      destination,
      'deno-source',
      `${root}/extract.log`,
    )
    const link = `${destination}/deno-source/fixture/copy_dir_link_file`
    if (await Deno.readLink(link) !== './fs/testdata/copy_dir/0.txt') {
      throw new Error(
        'safe dangling symlink target bytes changed on extraction',
      )
    }
    await assertSafeTree(`${destination}/deno-source`)
  } finally {
    await Deno.remove(root, { recursive: true })
  }
})

Deno.test('escaping archive symlink is rejected before extraction', async () => {
  const root = await Deno.makeTempDir({ prefix: 'slv-native-escape-link-' })
  try {
    const archive = `${root}/deno-source.tar.gz`
    const destination = `${root}/extract`
    await Deno.mkdir(destination)
    await createArchive(archive, '../../outside')
    let rejected = false
    try {
      await scanArchiveForUnsafeMembers(
        archive,
        'deno-source',
        destination,
        `${root}/scan.log`,
      )
    } catch (error) {
      rejected = error instanceof Error && error.message.includes(
        'pre-extraction archive scan',
      )
    }
    if (!rejected) throw new Error('escaping archive symlink was accepted')
  } finally {
    await Deno.remove(root, { recursive: true })
  }
})

async function createChainedEscapeArchive(archive: string): Promise<void> {
  const program = String.raw`
import sys
import tarfile

archive = sys.argv[1]
with tarfile.open(archive, 'w:gz') as payload:
    for name in ('deno-source', 'deno-source/xdir', 'deno-source/target'):
        entry = tarfile.TarInfo(name)
        entry.type = tarfile.DIRTYPE
        entry.mode = 0o755
        payload.addfile(entry)
    first = tarfile.TarInfo('deno-source/xdir/a')
    first.type = tarfile.SYMTYPE
    first.linkname = '../target'
    payload.addfile(first)
    second = tarfile.TarInfo('deno-source/b')
    second.type = tarfile.SYMTYPE
    second.linkname = 'xdir/a/../../outside'
    payload.addfile(second)
`
  const created = await new Deno.Command('/usr/bin/python3', {
    args: ['-c', program, archive],
    clearEnv: true,
    env: { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C', TZ: 'UTC' },
    stdout: 'piped',
    stderr: 'piped',
  }).output()
  if (!created.success) {
    throw new Error(new TextDecoder().decode(created.stderr))
  }
}

async function createAliasedMemberArchive(archive: string): Promise<void> {
  const program = String.raw`
import io
import sys
import tarfile

archive = sys.argv[1]
with tarfile.open(archive, 'w:gz') as payload:
    root = tarfile.TarInfo('deno-source')
    root.type = tarfile.DIRTYPE
    root.mode = 0o755
    payload.addfile(root)
    alias = tarfile.TarInfo('deno-source//alias')
    alias.mode = 0o644
    alias.size = 1
    payload.addfile(alias, io.BytesIO(b'x'))
`
  const created = await new Deno.Command('/usr/bin/python3', {
    args: ['-c', program, archive],
    clearEnv: true,
    env: { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C', TZ: 'UTC' },
    stdout: 'piped',
    stderr: 'piped',
  }).output()
  if (!created.success) {
    throw new Error(new TextDecoder().decode(created.stderr))
  }
}

Deno.test('ordered symlink resolution rejects a chained directory-link escape', async () => {
  const root = await Deno.makeTempDir({ prefix: 'slv-native-chain-link-' })
  try {
    const archive = `${root}/deno-source.tar.gz`
    const destination = `${root}/extract`
    await Deno.mkdir(destination)
    await createChainedEscapeArchive(archive)

    let scanRejected = false
    try {
      await scanArchiveForUnsafeMembers(
        archive,
        'deno-source',
        destination,
        `${root}/scan.log`,
      )
    } catch (error) {
      scanRejected = error instanceof Error && error.message.includes(
        'pre-extraction archive scan',
      )
    }
    if (!scanRejected) {
      throw new Error(
        'chained directory-link escape passed pre-extraction scan',
      )
    }

    await extractArchive(
      archive,
      destination,
      'deno-source',
      `${root}/extract.log`,
    )
    let treeRejected = false
    try {
      await assertSafeTree(`${destination}/deno-source`)
    } catch (error) {
      treeRejected = error instanceof Error && error.message.includes(
        'escapes its root',
      )
    }
    if (!treeRejected) {
      throw new Error(
        'chained directory-link escape passed post-extraction scan',
      )
    }
  } finally {
    await Deno.remove(root, { recursive: true })
  }
})

Deno.test('non-canonical interior archive member aliases are rejected', async () => {
  const root = await Deno.makeTempDir({ prefix: 'slv-native-member-alias-' })
  try {
    const archive = `${root}/deno-source.tar.gz`
    const destination = `${root}/extract`
    await Deno.mkdir(destination)
    await createAliasedMemberArchive(archive)
    let rejected = false
    try {
      await scanArchiveForUnsafeMembers(
        archive,
        'deno-source',
        destination,
        `${root}/scan.log`,
      )
    } catch (error) {
      rejected = error instanceof Error && error.message.includes(
        'pre-extraction archive scan',
      )
    }
    if (!rejected) throw new Error('interior // member alias was accepted')
  } finally {
    await Deno.remove(root, { recursive: true })
  }
})

Deno.test('build setup creates an intended fresh source root before measuring capacity', async () => {
  const root = await Deno.makeTempDir({
    prefix: 'slv-native-build-directories-',
  })
  try {
    const prepared = await prepareBuildDirectories(
      `${root}/out`,
      `${root}/work`,
      `${root}/fresh-source-root`,
    )
    const sourceRoot = await Deno.lstat(prepared.sourceRoot)
    if (!sourceRoot.isDirectory || sourceRoot.isSymlink) {
      throw new Error(
        'fresh source root was not initialized as a real directory',
      )
    }
    if (prepared.capacity.measurements.length !== 3) {
      throw new Error(
        'capacity receipt did not cover output, work, and source root',
      )
    }
    if (
      !prepared.capacity.measurements.some((entry) =>
        entry.path === prepared.sourceRoot
      )
    ) {
      throw new Error('capacity receipt omitted the initialized source root')
    }
  } finally {
    await Deno.remove(root, { recursive: true })
  }
})

Deno.test('relative source archives are resolved before scanners change extraction cwd', async () => {
  const cwd = Deno.cwd()
  const root = await Deno.makeTempDir({
    dir: cwd,
    prefix: '.slv-native-relative-archive-',
  })
  try {
    const archive = `${root}/deno-source.tar.gz`
    const destination = `${root}/extract`
    await Deno.mkdir(destination)
    await createArchive(archive, './fs/testdata/copy_dir/0.txt')
    await Deno.writeTextFile(`${root}/slv-source.tar.gz`, 'slv')
    await Deno.writeTextFile(`${root}/deno-cargo-vendor.tar.gz`, 'vendor')
    const relativeRoot = root.slice(cwd.length + 1)
    const archives = await resolveSourceArchivePaths(
      `${relativeRoot}/slv-source.tar.gz`,
      `${relativeRoot}/deno-source.tar.gz`,
      `${relativeRoot}/deno-cargo-vendor.tar.gz`,
    )
    for (const archivePath of Object.values(archives)) {
      if (!archivePath.startsWith('/')) {
        throw new Error(`archive path was not made absolute: ${archivePath}`)
      }
    }
    const scan = await scanArchiveForUnsafeMembers(
      archives['deno-source.tar.gz'],
      'deno-source',
      destination,
      `${root}/scan.log`,
    )
    if (scan.exit_code !== 0) {
      throw new Error('scanner could not read normalized relative archive path')
    }
  } finally {
    await Deno.remove(root, { recursive: true })
  }
})

Deno.test('merge emitter carries bounded build jobs through the unchanged release proof parser', () => {
  const hash = (character: string) => character.repeat(64)
  const command = {
    command: ['fixture'],
    cwd: '.',
    started_at: '2026-10-13T00:00:00Z',
    finished_at: '2026-10-13T00:00:01Z',
    exit_code: 0,
    log: 'fixture.log',
    log_sha256: hash('a'),
  }
  const artifacts = {
    baseline: {
      denort_sha256: hash('1'),
      v8_archive_sha256: hash('2'),
      ninja_sha256: hash('3'),
      probe_standalone_sha256: hash('4'),
      derived_relink_cargo_lock_sha256: hash('5'),
      slv_executable_sha256: hash('6'),
      bridge_standalone_sha256: hash('7'),
    },
    modified: {
      denort_sha256: hash('8'),
      v8_archive_sha256: hash('9'),
      ninja_sha256: hash('b'),
      probe_standalone_sha256: hash('c'),
    },
  }
  const runtimeAbi = (denortSha256: string) => ({
    schema_version: 1,
    kind: 'slv-macos-denort-abi',
    denort_sha256: denortSha256,
    minimum_os: '12.0',
    load_commands_sha256: hash('d'),
    status: 'passed',
  })
  const checks = {
    baseline_build: {
      passed: true,
      command,
      runtime_abi: runtimeAbi(artifacts.baseline.denort_sha256),
      runtime_abi_receipt_sha256: hash('e'),
    },
    baseline_probe: {
      passed: true,
      sentinel: { input: 0.125, output: 0.124, command },
      control: { input: 0.126, output: 0.125, command },
    },
    patch: {
      passed: true,
      before_sha256: hash('f'),
      after_sha256: hash('0'),
      command,
    },
    modified_build: {
      passed: true,
      command,
      runtime_abi: runtimeAbi(artifacts.modified.denort_sha256),
      runtime_abi_receipt_sha256: hash('1'),
    },
    modified_probe: {
      passed: true,
      sentinel: { input: 0.125, output: 0.5, command },
      control: { input: 0.126, output: 0.125, command },
    },
    slv_compile: { passed: true, command },
    slv_version: { passed: true, command },
    licenses: {
      passed: true,
      canonical_notice_sha256: hash('2'),
      command,
    },
    slv_help: { passed: true, command },
    release_bridge: { passed: true, compile: command, command },
  }
  const build = {
    value: {
      build_mode: 'native',
      build_host: { os: 'darwin', arch: 'x64' },
      source_selected_cargo_lock_sha256: hash('3'),
      tool_pin_sha256: hash('4'),
      patch_sha256: hash('5'),
      jobs: '8',
      checks: {
        baseline_build: checks.baseline_build,
        patch: checks.patch,
        modified_build: checks.modified_build,
        slv_compile: checks.slv_compile,
      },
    },
    sha256: hash('6'),
    artifacts,
  }
  const execution = {
    execution_host: { os: 'darwin', arch: 'x64' },
    artifacts,
    checks: {
      baseline_probe: checks.baseline_probe,
      modified_probe: checks.modified_probe,
      slv_version: checks.slv_version,
      licenses: checks.licenses,
      slv_help: checks.slv_help,
      release_bridge: checks.release_bridge,
    },
  }
  const proof = emitNativeTargetProof(
    'x86_64-apple-darwin',
    {
      sourceCommit: 'f'.repeat(40),
      sourceReceiptSha256: hash('7'),
      sourceAssets: [
        { name: 'slv-source.tar.gz', sha256: hash('8'), size: 1 },
        { name: 'deno-source.tar.gz', sha256: hash('9'), size: 1 },
        { name: 'deno-cargo-vendor.tar.gz', sha256: hash('a'), size: 1 },
      ],
      sourcePinSha256: hash('b'),
    },
    build,
    execution,
    hash('c'),
  )
  if (proof.jobs !== '8') {
    throw new Error('merge emitter dropped the build receipt jobs value')
  }
  verifyNativeSourceRebuildProof(proof)
  build.value.jobs = '17'
  let rejected = false
  try {
    emitNativeTargetProof(
      'x86_64-apple-darwin',
      {
        sourceCommit: 'f'.repeat(40),
        sourceReceiptSha256: hash('7'),
        sourceAssets: [
          { name: 'slv-source.tar.gz', sha256: hash('8'), size: 1 },
          { name: 'deno-source.tar.gz', sha256: hash('9'), size: 1 },
          { name: 'deno-cargo-vendor.tar.gz', sha256: hash('a'), size: 1 },
        ],
        sourcePinSha256: hash('b'),
      },
      build,
      execution,
      hash('c'),
    )
  } catch (error) {
    rejected = error instanceof Error && error.message.includes(
      'invalid bounded jobs',
    )
  }
  if (!rejected) {
    throw new Error('merge emitter accepted an out-of-range jobs value')
  }
})

async function layoutSha256(path: string): Promise<string> {
  return createHash('sha256').update(await Deno.readFile(path)).digest('hex')
}

async function expectLayoutRejection(
  action: () => Promise<void>,
  expected: string,
): Promise<void> {
  let rejected = false
  try {
    await action()
  } catch (error) {
    rejected = error instanceof Error && error.message.includes(expected)
  }
  if (!rejected) throw new Error(`expected rejection containing: ${expected}`)
}

Deno.test('tool layout copies libclang as a checksum-verified regular file', async () => {
  const root = await Deno.makeTempDir({ prefix: 'slv-layout-copy-' })
  try {
    const source = `${root}/chromium-rust/lib/libclang.so.23.0.0git`
    await Deno.mkdir(source.slice(0, source.lastIndexOf('/')), {
      recursive: true,
    })
    await Deno.writeTextFile(source, 'verified libclang bytes\n')
    const digest = await layoutSha256(source)
    await materializeLayoutCopies(root, [{
      source: 'chromium-rust/lib/libclang.so.23.0.0git',
      destination: 'clang/lib/libclang.so',
      sha256: digest,
    }])
    const destination = `${root}/clang/lib/libclang.so`
    const info = await Deno.lstat(destination)
    if (
      !info.isFile || info.isSymlink ||
      await layoutSha256(destination) !== digest
    ) {
      throw new Error(
        'layout destination is not a checksum-verified regular copy',
      )
    }
  } finally {
    await Deno.remove(root, { recursive: true })
  }
})

Deno.test('tool layout rejects symlink source, tampering, and occupied destination', async () => {
  const root = await Deno.makeTempDir({ prefix: 'slv-layout-copy-negative-' })
  try {
    const external = `${root}/external-libclang`
    const source = `${root}/chromium-rust/lib/libclang.so.23.0.0git`
    await Deno.mkdir(source.slice(0, source.lastIndexOf('/')), {
      recursive: true,
    })
    await Deno.writeTextFile(external, 'external bytes\n')
    await Deno.symlink(external, source)
    const digest = await layoutSha256(external)
    const placement = {
      source: 'chromium-rust/lib/libclang.so.23.0.0git',
      destination: 'clang/lib/libclang.so',
      sha256: digest,
    }
    await expectLayoutRejection(
      () => materializeLayoutCopies(root, [placement]),
      'must be a regular file',
    )

    await Deno.remove(source)
    await Deno.writeTextFile(source, 'verified bytes\n')
    await expectLayoutRejection(
      () => materializeLayoutCopies(root, [placement]),
      'source identity mismatch',
    )

    const verifiedDigest = await layoutSha256(source)
    const destination = `${root}/clang/lib/libclang.so`
    await Deno.mkdir(destination.slice(0, destination.lastIndexOf('/')), {
      recursive: true,
    })
    await Deno.writeTextFile(destination, 'occupied\n')
    await expectLayoutRejection(
      () =>
        materializeLayoutCopies(root, [{
          ...placement,
          sha256: verifiedDigest,
        }]),
      'destination already exists',
    )
  } finally {
    await Deno.remove(root, { recursive: true })
  }
})

Deno.test('tool environment root placements are canonical receipt paths', () => {
  const output = '/tmp/prepared-tools'
  if (expandEnvironment('@tool/clang/.', output) !== `${output}/clang`) {
    throw new Error('clang root placement retained a terminal slash')
  }
  if (
    expandEnvironment('@tool/chromium-rust/.', output) !==
      `${output}/chromium-rust`
  ) {
    throw new Error('Chromium Rust root placement retained a terminal slash')
  }
  if (
    expandEnvironment('@tool/clang/lib', output) !== `${output}/clang/lib`
  ) {
    throw new Error('nested tool placement changed unexpectedly')
  }
})
