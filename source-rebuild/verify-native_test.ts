import { createHash } from 'node:crypto'
import {
  assertSafeTree,
  captureCargoFingerprintCollection,
  emitNativeTargetProof,
  extractArchive,
  prepareBuildDirectories,
  resolveSourceArchivePaths,
  scanArchiveForUnsafeMembers,
  verifyCargoFingerprintCollection,
} from './verify-native.ts'
import { verifyNativeSourceRebuildProof } from '../scripts/release/source-materials.ts'
import { expandEnvironment, materializeLayoutCopies } from './prepare-tools.ts'

const nativeRecipe = new URL('./build-baseline-denort.sh', import.meta.url)

function requireFixture(
  condition: unknown,
  message: string,
): asserts condition {
  if (!condition) throw new Error(message)
}

async function recipeNinjaLauncher(
  output: string,
  pinnedNinja: string,
): Promise<string> {
  const recipe = await Deno.readTextFile(nativeRecipe)
  const begin = '# NINJA_LAUNCHER_GENERATOR_BEGIN'
  const end = '# NINJA_LAUNCHER_GENERATOR_END'
  const beginOffset = recipe.indexOf(begin)
  const endOffset = recipe.indexOf(end)
  requireFixture(
    beginOffset >= 0 && endOffset > beginOffset,
    'native recipe launcher generator markers are missing or malformed',
  )
  const generator = recipe.slice(beginOffset + begin.length, endOffset)
  const result = await new Deno.Command('/usr/bin/bash', {
    args: ['-euo', 'pipefail', '-c', `${generator}\nwrite_ninja_launcher`],
    clearEnv: true,
    env: {
      PATH: '/usr/bin:/bin',
      PYTHON: '/usr/bin/python3',
      output,
      pinned_ninja: pinnedNinja,
    },
    stdout: 'piped',
    stderr: 'piped',
  }).output()
  requireFixture(
    result.success,
    `native recipe launcher generator failed: ${
      new TextDecoder().decode(result.stderr)
    }`,
  )
  const launcher = new TextDecoder().decode(result.stdout).trim()
  requireFixture(launcher.startsWith(`${output}/`), 'launcher escaped output')
  requireFixture(
    (await Deno.stat(launcher)).mode! & 0o111,
    'launcher is not executable',
  )
  return launcher
}

async function waitForFixture(path: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      await Deno.stat(path)
      return
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
  }
  throw new Error(`fixture did not create ${path}`)
}

async function runRecipeCommand(
  command: string,
  setup: string,
  root: string,
): Promise<string[]> {
  const capture = `${root}/arguments-${crypto.randomUUID()}.log`
  const fixture = `${root}/capture-arguments.sh`
  await Deno.writeTextFile(
    fixture,
    '#!/usr/bin/bash\nprintf \'%s\\n\' "$@" > "$capture"\n',
  )
  await Deno.chmod(fixture, 0o755)
  const result = await new Deno.Command('/usr/bin/bash', {
    args: ['-euo', 'pipefail', '-c', `${setup}\n${command}`],
    clearEnv: true,
    env: {
      PATH: '/usr/bin:/bin',
      SLV_APPLE_SDK_PATH: 'fixture SDK with spaces',
      apple_link_target: 'fixture-apple-target',
      clang: fixture,
      cargo: fixture,
      jobs: '2',
      output: root,
      linker_driver_probe_log: `${root}/linker-driver-probe.log`,
      capture,
    },
    stdout: 'piped',
    stderr: 'piped',
  }).output()
  requireFixture(
    result.success,
    `recipe command failed: ${new TextDecoder().decode(result.stderr)}`,
  )
  const text = await Deno.readTextFile(capture)
  return text === '' ? [] : text.slice(0, -1).split('\n')
}

Deno.test('native recipe guarded arrays preserve zero and spaced values on the observed Bash', async () => {
  // This is the local Bash boundary only; it makes no claim about an
  // unmeasured Bash 3 host.
  const version = await new Deno.Command('/usr/bin/bash', {
    args: ['-c', 'printf %s "$BASH_VERSION"'],
    clearEnv: true,
    stdout: 'piped',
    stderr: 'piped',
  }).output()
  const bashVersion = new TextDecoder().decode(version.stdout)
  requireFixture(
    version.success && bashVersion.length > 0,
    'Bash version was not recorded',
  )

  const root = await Deno.makeTempDir({ prefix: 'slv-native-guarded-arrays-' })
  try {
    const recipe = await Deno.readTextFile(nativeRecipe)
    const apple = recipe.match(
      / {2}"\$clang" -target "\$apple_link_target" -isysroot "\$SLV_APPLE_SDK_PATH" \\\n {4}\$\{apple_link_flags\[@\]\+"\$\{apple_link_flags\[@\]\}"\} -### -x c \/dev\/null -o "\$output\/linker-driver-probe" \\\n {4}> \/dev\/null 2>"\$linker_driver_probe_log"/,
    )?.[0]
    const cargo = [...recipe.matchAll(
      / {4}"\$cargo" build --locked --offline --release \$\{target_args\[@\]\+"\$\{target_args\[@\]\}"\} -j "\$jobs" -p denort/g,
    )].map((match) => match[0])
    requireFixture(
      apple,
      `Apple guarded invocation missing under Bash ${bashVersion}`,
    )
    requireFixture(
      cargo.length === 2,
      `expected fresh and resume guarded Cargo calls under Bash ${bashVersion}`,
    )

    const appleEmpty = await runRecipeCommand(
      apple,
      'apple_link_flags=()',
      root,
    )
    requireFixture(
      JSON.stringify(appleEmpty) === JSON.stringify([
        '-target',
        'fixture-apple-target',
        '-isysroot',
        'fixture SDK with spaces',
        '-###',
        '-x',
        'c',
        '/dev/null',
        '-o',
        `${root}/linker-driver-probe`,
      ]),
      'empty Apple array added an empty argument or changed ordering',
    )
    const appleTwo = await runRecipeCommand(
      apple,
      "apple_link_flags=(-fuse-ld=lld 'flag with spaces')",
      root,
    )
    requireFixture(
      JSON.stringify(appleTwo.slice(4, 6)) ===
        JSON.stringify(['-fuse-ld=lld', 'flag with spaces']),
      'two-element Apple array did not preserve ordered spaced values',
    )

    for (const cargoCall of cargo) {
      const empty = await runRecipeCommand(cargoCall, 'target_args=()', root)
      requireFixture(
        JSON.stringify(empty) === JSON.stringify([
          'build',
          '--locked',
          '--offline',
          '--release',
          '-j',
          '2',
          '-p',
          'denort',
        ]),
        'empty Cargo array added an empty argument or changed ordering',
      )
      const two = await runRecipeCommand(
        cargoCall,
        "target_args=(--target 'aarch64 target with spaces')",
        root,
      )
      requireFixture(
        JSON.stringify(two.slice(4, 6)) ===
          JSON.stringify(['--target', 'aarch64 target with spaces']),
        'two-element Cargo array did not preserve ordered spaced values',
      )
    }
  } finally {
    await Deno.remove(root, { recursive: true })
  }
})

Deno.test('frozen Ninja launcher isolates bindgen flags while preserving pinned Ninja identity', async () => {
  const root = await Deno.makeTempDir({ prefix: 'slv-native-ninja-launcher-' })
  try {
    const pinnedNinja = `${root}/pinned's ninja.py`
    await Deno.writeTextFile(
      pinnedNinja,
      String.raw`#!/usr/bin/python3
import json
import os
import pathlib
import signal
import sys

mode, record, *arguments = sys.argv[1:]
payload = {
    'argv': arguments,
    'pid': os.getpid(),
    'environment': {key: os.environ.get(key) for key in (
        'BINDGEN_EXTRA_CLANG_ARGS',
        'BINDGEN_EXTRA_CLANG_ARGS_AARCH64_UNKNOWN_LINUX_GNU',
        'BINDGEN_EXTRA_CLANG_ARGS_SECOND_TARGET',
        'BINDGEN_EXTRA_CLANG_ARGSX',
        'CARGO_TARGET_AARCH64_UNKNOWN_LINUX_GNU_RUSTFLAGS',
        'UNRELATED_ENV',
    )},
}
record_path = pathlib.Path(record)
if mode == 'wait':
    signal.signal(signal.SIGTERM, lambda _signal, _frame: sys.exit(75))
    temporary = record_path.with_name(f'.{record_path.name}.{os.getpid()}.tmp')
    temporary.write_text(json.dumps(payload, sort_keys=True))
    os.replace(temporary, record_path)
    while True:
        signal.pause()
record_path.write_text(json.dumps(payload, sort_keys=True))
if mode == 'exit':
    raise SystemExit(int(arguments[-1]))
raise SystemExit(0)
`,
    )
    await Deno.chmod(pinnedNinja, 0o755)
    const launcher = await recipeNinjaLauncher(root, pinnedNinja)
    const pinnedBytes = await Deno.readFile(pinnedNinja)
    const launcherBytes = await Deno.readFile(launcher)
    const pinnedHash = createHash('sha256').update(pinnedBytes).digest('hex')
    const launcherHash = createHash('sha256').update(launcherBytes).digest(
      'hex',
    )
    requireFixture(
      pinnedHash !== launcherHash,
      'underlying Ninja and launcher hashes unexpectedly match',
    )

    const environment = {
      BINDGEN_EXTRA_CLANG_ARGS: '--target=aarch64-unknown-linux-gnu -msse3',
      BINDGEN_EXTRA_CLANG_ARGS_AARCH64_UNKNOWN_LINUX_GNU: '-msse3',
      BINDGEN_EXTRA_CLANG_ARGS_SECOND_TARGET: '-msse3',
      BINDGEN_EXTRA_CLANG_ARGSX: 'near-match-must-survive',
      CARGO_TARGET_AARCH64_UNKNOWN_LINUX_GNU_RUSTFLAGS: '-C target-cpu=generic',
      UNRELATED_ENV: 'preserved',
    }
    const record = `${root}/exit.json`
    const exited = await new Deno.Command(launcher, {
      args: ['exit', record, 'argument with spaces', '--status', '37'],
      clearEnv: true,
      env: environment,
      stdout: 'piped',
      stderr: 'piped',
    }).output()
    requireFixture(
      exited.code === 37,
      'launcher did not preserve Ninja exit code',
    )
    const observed = JSON.parse(await Deno.readTextFile(record)) as {
      argv: string[]
      environment: Record<string, string | null>
    }
    requireFixture(
      JSON.stringify(observed.argv) ===
        JSON.stringify(['argument with spaces', '--status', '37']),
      'launcher did not preserve Ninja argument order and spaces',
    )
    for (
      const key of [
        'BINDGEN_EXTRA_CLANG_ARGS',
        'BINDGEN_EXTRA_CLANG_ARGS_AARCH64_UNKNOWN_LINUX_GNU',
        'BINDGEN_EXTRA_CLANG_ARGS_SECOND_TARGET',
      ]
    ) {
      requireFixture(observed.environment[key] === null, `${key} reached Ninja`)
    }
    requireFixture(
      observed.environment.BINDGEN_EXTRA_CLANG_ARGSX ===
          'near-match-must-survive' &&
        observed.environment
            .CARGO_TARGET_AARCH64_UNKNOWN_LINUX_GNU_RUSTFLAGS ===
          '-C target-cpu=generic' &&
        observed.environment.UNRELATED_ENV === 'preserved',
      'launcher changed a non-bindgen or parent Cargo ARM environment value',
    )

    const signalRecord = `${root}/signal.json`
    const child = new Deno.Command(launcher, {
      args: ['wait', signalRecord],
      clearEnv: true,
      env: environment,
      stdout: 'piped',
      stderr: 'piped',
    }).spawn()
    await waitForFixture(signalRecord)
    const signalFixture = JSON.parse(await Deno.readTextFile(signalRecord)) as {
      pid: number
    }
    requireFixture(
      signalFixture.pid === child.pid,
      'launcher did not exec the pinned Ninja process',
    )
    Deno.kill(child.pid, 'SIGTERM')
    const terminated = await child.status
    requireFixture(
      terminated.code === 75 && terminated.signal === null,
      'launcher did not propagate SIGTERM to the execed Ninja process',
    )

    const recipe = await Deno.readTextFile(nativeRecipe)
    for (
      const field of [
        'ninja_sha256=%s',
        'ninja_path=%s',
        'ninja_launcher_path=%s',
        'ninja_launcher_sha256=%s',
        'ninja_environment_policy=remove-BINDGEN_EXTRA_CLANG_ARGS-and-BINDGEN_EXTRA_CLANG_ARGS_-prefix',
      ]
    ) {
      requireFixture(recipe.includes(field), `recipe receipt omits ${field}`)
    }
    requireFixture(
      recipe.includes('sha256_file "$pinned_ninja"'),
      'recipe receipt hashes launcher in place of the pinned Ninja binary',
    )
  } finally {
    await Deno.remove(root, { recursive: true })
  }
})

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
    unicode_name = tarfile.TarInfo('deno-source/fixture/Begrænset.js')
    unicode_name.mode = 0o644
    unicode_name.size = len(b'export const source = "utf8";\n')
    payload.addfile(unicode_name, io.BytesIO(b'export const source = "utf8";\n'))
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
    await createArchive(archive, 'Begrænset.js')

    await extractArchive(
      archive,
      destination,
      'deno-source',
      `${root}/extract.log`,
    )
    const link = `${destination}/deno-source/fixture/copy_dir_link_file`
    if (await Deno.readLink(link) !== 'Begrænset.js') {
      throw new Error('contained symlink target bytes changed on extraction')
    }
    const unicode = await Deno.readTextFile(
      `${destination}/deno-source/fixture/Begrænset.js`,
    )
    if (unicode !== 'export const source = "utf8";\n') {
      throw new Error('UTF-8 archive member bytes changed on extraction')
    }
    await Deno.lstat(`${root}/extract.log.scan`)
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

async function createForbiddenCharacterArchive(
  archive: string,
  kind: 'backslash-member' | 'nul-member' | 'backslash-link' | 'nul-link',
): Promise<void> {
  const program = String.raw`
import io
import sys
import tarfile

archive, kind = sys.argv[1:]
bad = chr(92) if kind.startswith('backslash') else chr(0)
with tarfile.open(archive, 'w:gz', format=tarfile.PAX_FORMAT) as payload:
    for name in ('deno-source', 'deno-source/fixture'):
        entry = tarfile.TarInfo(name)
        entry.type = tarfile.DIRTYPE
        entry.mode = 0o755
        payload.addfile(entry)
    if kind.endswith('member'):
        name = 'deno-source/fixture/member' + bad + 'suffix'
        entry = tarfile.TarInfo('deno-source/fixture/member')
        if kind == 'nul-member':
            entry.pax_headers = {'path': name}
        else:
            entry.name = name
        entry.mode = 0o644
        entry.size = 1
        payload.addfile(entry, io.BytesIO(b'x'))
    else:
        target = 'target' + bad + 'suffix'
        entry = tarfile.TarInfo('deno-source/fixture/link')
        entry.type = tarfile.SYMTYPE
        if kind == 'nul-link':
            entry.linkname = 'target'
            entry.pax_headers = {'linkpath': target}
        else:
            entry.linkname = target
        payload.addfile(entry)
`
  const created = await new Deno.Command('/usr/bin/python3', {
    args: ['-c', program, archive, kind],
    clearEnv: true,
    env: { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C', TZ: 'UTC' },
    stdout: 'piped',
    stderr: 'piped',
  }).output()
  if (!created.success) {
    throw new Error(new TextDecoder().decode(created.stderr))
  }
}

async function expectExtractRejection(
  archive: string,
  destination: string,
  label: string,
): Promise<void> {
  try {
    await extractArchive(
      archive,
      destination,
      'deno-source',
      `${destination}/extract.log`,
    )
  } catch (error) {
    if (
      error instanceof Error &&
      error.message.includes('pre-extraction archive scan')
    ) {
      await Deno.lstat(`${destination}/deno-source`).then(
        () => {
          throw new Error(`${label} created its root before rejection`)
        },
        (lstatError) => {
          if (!(lstatError instanceof Deno.errors.NotFound)) throw lstatError
        },
      )
      return
    }
    throw error
  }
  throw new Error(`${label} reached extraction`)
}

Deno.test('extractArchive rejects literal backslash and NUL member and link values before extraction', async () => {
  const root = await Deno.makeTempDir({
    prefix: 'slv-native-member-characters-',
  })
  try {
    for (
      const kind of [
        'backslash-member',
        'nul-member',
        'backslash-link',
        'nul-link',
      ] as const
    ) {
      const archive = `${root}/${kind}.tar.gz`
      const destination = `${root}/${kind}`
      await Deno.mkdir(destination)
      await createForbiddenCharacterArchive(archive, kind)
      await expectExtractRejection(archive, destination, kind)
    }
  } finally {
    await Deno.remove(root, { recursive: true })
  }
})

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

    let extractionRejected = false
    try {
      await extractArchive(
        archive,
        destination,
        'deno-source',
        `${root}/extract.log`,
      )
    } catch (error) {
      extractionRejected = error instanceof Error && error.message.includes(
        'pre-extraction archive scan',
      )
    }
    if (!extractionRejected) {
      throw new Error(
        'chained directory-link escape reached extraction',
      )
    }
    await Deno.lstat(`${destination}/deno-source`).then(
      () => {
        throw new Error('rejected archive created its root')
      },
      (error) => {
        if (!(error instanceof Deno.errors.NotFound)) throw error
      },
    )
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

function fingerprintExpectation(
  phase: 'baseline' | 'modified' = 'baseline',
  target = 'x86_64-unknown-linux-gnu',
) {
  return {
    phase,
    target,
    runtime_sha256: 'a'.repeat(64),
    derived_relink_cargo_lock_sha256: 'b'.repeat(64),
  } as const
}

function decodeBase64(value: string): Uint8Array {
  return Uint8Array.from(atob(value), (character) => character.charCodeAt(0))
}

Deno.test('Cargo fingerprint evidence preserves raw host and target records before scratch cleanup', async () => {
  const root = await Deno.makeTempDir({
    prefix: 'slv-native-cargo-fingerprints-',
  })
  try {
    const expectation = fingerprintExpectation()
    const host = `${root}/target/release/.fingerprint/host-unit`
    const target =
      `${root}/target/${expectation.target}/release/.fingerprint/target-unit`
    const hostBytes = '{ "features": ["dnssec"] }\n'
    const targetBytes = '{"deps":["deno_ffi"],"features":[]}\n'
    await Deno.mkdir(host, { recursive: true })
    await Deno.mkdir(target, { recursive: true })
    await Deno.writeTextFile(`${host}/lib-host.json`, hostBytes)
    await Deno.writeTextFile(`${target}/lib-target.json`, targetBytes)

    const collection = await captureCargoFingerprintCollection(
      root,
      expectation,
    )
    if (collection.records.length !== 2) {
      throw new Error('did not capture both Cargo fingerprint contexts')
    }
    const captured = collection.records.map((record) =>
      `${record.context}:${record.path}:${
        new TextDecoder().decode(decodeBase64(record.content_base64))
      }`
    )
    if (
      captured[0] !== `host-release:host-unit/lib-host.json:${hostBytes}` ||
      captured[1] !==
        `target-release:target-unit/lib-target.json:${targetBytes}`
    ) {
      throw new Error('Cargo fingerprint raw bytes or contexts changed')
    }

    await Deno.remove(`${root}/target`, { recursive: true })
    await verifyCargoFingerprintCollection(collection, expectation)
  } finally {
    await Deno.remove(root, { recursive: true })
  }
})

Deno.test('Cargo fingerprint evidence rejects absent, tampered, and wrongly bound records', async () => {
  const root = await Deno.makeTempDir({
    prefix: 'slv-native-cargo-fingerprints-negative-',
  })
  try {
    const expectation = fingerprintExpectation('modified')
    await expectLayoutRejection(
      () => captureCargoFingerprintCollection(root, expectation).then(() => {}),
      'emitted no Cargo fingerprint JSON records',
    )

    const fingerprints = `${root}/target/release/.fingerprint/only-host-record`
    await Deno.mkdir(fingerprints, { recursive: true })
    await Deno.writeTextFile(`${fingerprints}/unit.json`, '{"ok":true}\n')
    await expectLayoutRejection(
      () => captureCargoFingerprintCollection(root, expectation).then(() => {}),
      'fingerprint contexts differ',
    )
    const targetFingerprints =
      `${root}/target/${expectation.target}/release/.fingerprint/target-record`
    await Deno.mkdir(targetFingerprints, { recursive: true })
    await Deno.writeTextFile(
      `${targetFingerprints}/unit.json`,
      '{"target":true}\n',
    )
    const collection = await captureCargoFingerprintCollection(
      root,
      expectation,
    )

    const tampered = structuredClone(collection)
    tampered.records[0].content_base64 = btoa('{"ok":false}\n')
    await expectLayoutRejection(
      () =>
        verifyCargoFingerprintCollection(tampered, expectation).then(() => {}),
      'digest differs from bytes',
    )
    await expectLayoutRejection(
      () =>
        verifyCargoFingerprintCollection(collection, {
          ...expectation,
          runtime_sha256: 'c'.repeat(64),
        }).then(() => {}),
      'does not bind this build',
    )
    await expectLayoutRejection(
      () =>
        verifyCargoFingerprintCollection(collection, {
          ...expectation,
          derived_relink_cargo_lock_sha256: 'd'.repeat(64),
        }).then(() => {}),
      'does not bind this build',
    )
  } finally {
    await Deno.remove(root, { recursive: true })
  }
})

Deno.test('Cargo fingerprint evidence accepts macOS host records only and rejects target output', async () => {
  const root = await Deno.makeTempDir({
    prefix: 'slv-native-cargo-fingerprints-macos-',
  })
  try {
    const expectation = fingerprintExpectation(
      'baseline',
      'x86_64-apple-darwin',
    )
    const host = `${root}/target/release/.fingerprint/host-unit`
    await Deno.mkdir(host, { recursive: true })
    await Deno.writeTextFile(`${host}/unit.json`, '{"host":true}\n')
    const collection = await captureCargoFingerprintCollection(
      root,
      expectation,
    )
    if (
      collection.records.length !== 1 ||
      collection.records[0].context !== 'host-release'
    ) {
      throw new Error('macOS host-only fingerprint evidence was not retained')
    }
    const target =
      `${root}/target/${expectation.target}/release/.fingerprint/stale-target`
    await Deno.mkdir(target, { recursive: true })
    await Deno.writeTextFile(`${target}/unit.json`, '{"stale":true}\n')
    await expectLayoutRejection(
      () => captureCargoFingerprintCollection(root, expectation).then(() => {}),
      'fingerprint contexts differ',
    )
  } finally {
    await Deno.remove(root, { recursive: true })
  }
})

Deno.test('build setup measures all initialized real directories and rejects insufficient capacity', async () => {
  const descriptor = Object.getOwnPropertyDescriptor(Deno, 'Command')
  if (!descriptor) throw new Error('Deno.Command descriptor is missing')
  const OriginalCommand = Deno.Command
  const calls: Array<{
    executable: string
    options: Deno.CommandOptions | undefined
  }> = []
  let expectedPaths: string[] = []
  let availableKiB = 0
  let outputCalls = 0
  const encoder = new TextEncoder()

  class CapacityFixtureCommand extends OriginalCommand {
    #call: { executable: string; options: Deno.CommandOptions | undefined }

    constructor(executable: string | URL, options?: Deno.CommandOptions) {
      super(executable, options)
      this.#call = { executable: String(executable), options }
      calls.push(this.#call)
    }

    override async output(): Promise<Deno.CommandOutput> {
      const expectedPath = expectedPaths[outputCalls]
      const args = this.#call.options?.args
      if (
        !expectedPath || this.#call.executable !== 'df' ||
        args?.length !== 2 || args[0] !== '-Pk' || args[1] !== expectedPath
      ) {
        throw new Error(
          `unexpected capacity command: ${this.#call.executable} ${
            args?.join(' ') ?? ''
          }`,
        )
      }
      for (const path of expectedPaths) {
        const info = await Deno.lstat(path)
        if (!info.isDirectory || info.isSymlink) {
          throw new Error(
            `capacity measurement saw a non-real directory: ${path}`,
          )
        }
      }
      outputCalls += 1
      return {
        success: true,
        code: 0,
        signal: null,
        stdout: encoder.encode(
          `Filesystem 1024-blocks Used Available Capacity Mounted on\nfixture 25165824 12582912 ${availableKiB} 50% /\n`,
        ),
        stderr: new Uint8Array(),
      }
    }
  }

  const runCase = async (
    name: string,
    freeKiB: number,
    expectFailure: boolean,
  ): Promise<void> => {
    const root = await Deno.makeTempDir({
      prefix: `slv-native-build-directories-${name}-`,
    })
    const paths: [string, string, string] = [
      `${root}/out`,
      `${root}/work`,
      `${root}/fresh-source-root`,
    ]
    expectedPaths = paths
    availableKiB = freeKiB
    outputCalls = 0
    calls.length = 0
    try {
      if (expectFailure) {
        let rejected = false
        try {
          await prepareBuildDirectories(...paths)
        } catch (error) {
          rejected = error instanceof Error &&
            error.message.includes(`: ${freeKiB} KiB, need 12582912 KiB`)
        }
        if (!rejected) {
          throw new Error(
            'insufficient capacity did not preserve the measured threshold error',
          )
        }
        if (calls.length !== 1 || outputCalls !== 1) {
          throw new Error(
            'insufficient capacity did not fail after its first measurement',
          )
        }
        return
      }

      const prepared = await prepareBuildDirectories(...paths)
      if (outputCalls !== 3 || calls.length !== 3) {
        throw new Error(
          'capacity receipt did not cover output, work, and source root',
        )
      }
      for (const [index, path] of paths.entries()) {
        const call = calls[index]
        if (
          call.executable !== 'df' || call.options?.args?.length !== 2 ||
          call.options.args[0] !== '-Pk' || call.options.args[1] !== path
        ) {
          throw new Error(
            `capacity command ${index} did not measure its exact path`,
          )
        }
      }
      if (
        prepared.capacity.minimum_free_kib !== 12582912 ||
        prepared.capacity.measurements.length !== 3
      ) {
        throw new Error('capacity receipt did not retain its exact threshold')
      }
      for (
        const [index, measurement] of prepared.capacity.measurements.entries()
      ) {
        if (
          measurement.path !== paths[index] || measurement.free_kib !== freeKiB
        ) {
          throw new Error(
            'capacity receipt did not retain each exact measurement',
          )
        }
      }
    } finally {
      await Deno.remove(root, { recursive: true })
    }
  }

  Object.defineProperty(Deno, 'Command', {
    configurable: true,
    enumerable: descriptor.enumerable,
    writable: true,
    value: CapacityFixtureCommand,
  })
  try {
    await runCase('sufficient', 12582912, false)
    await runCase('insufficient', 12582911, true)
  } finally {
    Object.defineProperty(Deno, 'Command', descriptor)
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
  const cargoFingerprints = (
    phase: 'baseline' | 'modified',
    runtimeSha256: string,
    derivedRelinkCargoLockSha256: string,
  ) => {
    const content = `{"phase":"${phase}","context":"host-release"}\n`
    return {
      schema_version: 1,
      kind: 'slv-cargo-fingerprint-records',
      phase,
      target: 'x86_64-apple-darwin',
      runtime_sha256: runtimeSha256,
      derived_relink_cargo_lock_sha256: derivedRelinkCargoLockSha256,
      records: [{
        context: 'host-release',
        path: `${phase}-host/output-unit.json`,
        sha256: createHash('sha256').update(content).digest('hex'),
        content_base64: btoa(content),
      }],
    }
  }
  const checks = {
    baseline_build: {
      passed: true,
      command,
      derived_relink_cargo_lock_sha256:
        artifacts.baseline.derived_relink_cargo_lock_sha256,
      runtime_abi: runtimeAbi(artifacts.baseline.denort_sha256),
      runtime_abi_receipt_sha256: hash('e'),
      cargo_fingerprints: cargoFingerprints(
        'baseline',
        artifacts.baseline.denort_sha256,
        artifacts.baseline.derived_relink_cargo_lock_sha256,
      ),
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
      derived_relink_cargo_lock_sha256: hash('e'),
      runtime_abi: runtimeAbi(artifacts.modified.denort_sha256),
      runtime_abi_receipt_sha256: hash('1'),
      cargo_fingerprints: cargoFingerprints(
        'modified',
        artifacts.modified.denort_sha256,
        hash('e'),
      ),
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
