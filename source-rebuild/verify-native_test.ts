import {
  assertSafeTree,
  extractArchive,
  prepareBuildDirectories,
  resolveSourceArchivePaths,
  scanArchiveForUnsafeMembers,
} from './verify-native.ts'

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
