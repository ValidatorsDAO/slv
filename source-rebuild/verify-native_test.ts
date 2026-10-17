import { createHash } from 'node:crypto'
import {
  assertExecutionSucceeded,
  assertSafeTree,
  captureArmObservation,
  captureCargoFingerprintCollection,
  emitNativeTargetProof,
  extractArchive,
  internalWriteArmObservation,
  parseNativeArgs,
  prepareBuildDirectories,
  resolveSourceArchivePaths,
  scanArchiveForUnsafeMembers,
  verifyCargoFingerprintCollection,
  verifyNative,
  verifySplitBuildEvidence,
} from './verify-native.ts'
import { verifyNativeSourceRebuildProof } from '../scripts/release/source-materials.ts'
import {
  canonicalTargetDescriptorBytes,
  expandEnvironment,
  materializeLayoutCopies,
  parseToolPins,
} from './prepare-tools.ts'

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

async function recipeFragment(begin: string, end: string): Promise<string> {
  const recipe = await Deno.readTextFile(nativeRecipe)
  const beginOffset = recipe.indexOf(begin)
  const endOffset = recipe.indexOf(end)
  requireFixture(
    beginOffset >= 0 && endOffset > beginOffset,
    `native recipe fragment ${begin} is missing or malformed`,
  )
  return recipe.slice(beginOffset + begin.length, endOffset)
}

async function macosBindgenArguments(
  target: string,
  sdk: string,
  resource: string,
): Promise<string> {
  const fragment = await recipeFragment(
    '# MACOS_BINDGEN_ARGS_BEGIN',
    '# MACOS_BINDGEN_ARGS_END',
  )
  const result = await new Deno.Command('/usr/bin/bash', {
    args: [
      '-euo',
      'pipefail',
      '-c',
      `${fragment}\nprintf '%s' "$BINDGEN_EXTRA_CLANG_ARGS"`,
    ],
    clearEnv: true,
    env: {
      PATH: '/usr/bin:/bin',
      PYTHON: '/usr/bin/python3',
      SLV_APPLE_SDK_PATH: sdk,
      apple_link_target: target,
      resource_dir: resource,
    },
    stdout: 'piped',
    stderr: 'piped',
  }).output()
  requireFixture(
    result.success,
    `macOS bindgen argument fragment failed: ${
      new TextDecoder().decode(result.stderr)
    }`,
  )
  return new TextDecoder().decode(result.stdout)
}

async function parseShellArguments(value: string): Promise<string[]> {
  const result = await new Deno.Command('/usr/bin/python3', {
    args: [
      '-c',
      'import json, shlex, sys; print(json.dumps(shlex.split(sys.argv[1])))',
      value,
    ],
    clearEnv: true,
    env: { PATH: '/usr/bin:/bin' },
    stdout: 'piped',
    stderr: 'piped',
  }).output()
  requireFixture(
    result.success,
    `Python could not parse bindgen arguments: ${
      new TextDecoder().decode(result.stderr)
    }`,
  )
  return JSON.parse(new TextDecoder().decode(result.stdout)) as string[]
}

async function writeFixtureLibclang(root: string): Promise<string> {
  const source = `${root}/fixture-libclang.c`
  const library = `${root}/libclang.dylib`
  await Deno.writeTextFile(
    source,
    String.raw`#include <stdio.h>
#include <stdlib.h>
#include <string.h>

typedef struct { const void *data; unsigned private_flags; } CXString;
static int mode = 0;

void *clang_createIndex(int exclude_decls_from_pch, int display_diagnostics) {
  (void)exclude_decls_from_pch;
  (void)display_diagnostics;
  return malloc(1);
}

unsigned clang_parseTranslationUnit2(
  void *index,
  const char *source_filename,
  const char * const *command_line_args,
  int num_command_line_args,
  void *unsaved_files,
  unsigned num_unsaved_files,
  unsigned options,
  void **out_translation_unit
) {
  (void)index;
  (void)source_filename;
  (void)unsaved_files;
  (void)num_unsaved_files;
  (void)options;
  const char *mode_env = getenv("FAKE_LIBCLANG_MODE");
  mode = mode_env && strcmp(mode_env, "fatal") == 0 ? 2 : 0;
  FILE *record = fopen(getenv("FAKE_LIBCLANG_ARGS_LOG"), "w");
  if (record) {
    for (int i = 0; i < num_command_line_args; ++i) fprintf(record, "%s\n", command_line_args[i]);
    fclose(record);
  }
  if (mode_env && strcmp(mode_env, "parse") == 0) return 1;
  *out_translation_unit = malloc(1);
  return 0;
}

unsigned clang_getNumDiagnostics(void *translation_unit) {
  (void)translation_unit;
  return mode == 2 ? 1 : 0;
}

void *clang_getDiagnostic(void *translation_unit, unsigned index) {
  (void)translation_unit;
  (void)index;
  return malloc(1);
}

unsigned clang_getDiagnosticSeverity(void *diagnostic) {
  (void)diagnostic;
  return mode == 2 ? 4 : 0;
}

CXString clang_getDiagnosticSpelling(void *diagnostic) {
  (void)diagnostic;
  CXString value = { "fixture fatal diagnostic", 0 };
  return value;
}

void clang_disposeString(CXString value) { (void)value; }
void clang_disposeDiagnostic(void *diagnostic) { free(diagnostic); }
void clang_disposeTranslationUnit(void *translation_unit) { free(translation_unit); }
void clang_disposeIndex(void *index) { free(index); }
`,
  )
  const result = await new Deno.Command('/usr/bin/cc', {
    args: ['-shared', '-fPIC', source, '-o', library],
    clearEnv: true,
    env: { PATH: '/usr/bin:/bin' },
    stdout: 'piped',
    stderr: 'piped',
  }).output()
  requireFixture(
    result.success,
    `fixture libclang compilation failed: ${
      new TextDecoder().decode(result.stderr)
    }`,
  )
  return library
}

async function runMacosBindgenPreflight(
  directory: string,
  library: string,
  sdk: string,
  target: string,
  bindgenArgs: string,
  mode?: 'parse' | 'fatal',
): Promise<
  {
    code: number
    receipt: Record<string, unknown>
    parsed: string[]
    retainedLog: string
    envelope: Record<string, unknown>
  }
> {
  const fragment = await recipeFragment(
    '# MACOS_BINDGEN_PREFLIGHT_BEGIN',
    '# MACOS_BINDGEN_PREFLIGHT_END',
  )
  const argumentsLog = `${directory}/libclang-arguments.log`
  const retainedLog = `${directory}/build.log`
  await Deno.mkdir(directory, { recursive: true })
  const result = await new Deno.Command('/usr/bin/bash', {
    args: [
      '-euo',
      'pipefail',
      '-c',
      `${fragment}
set +e
write_macos_bindgen_preflight "$preflight_dir" 2>&1 | tee "$retained_log"
preflight_status="\${PIPESTATUS[0]}"
set -e
exit "$preflight_status"`,
    ],
    clearEnv: true,
    env: {
      PATH: '/usr/bin:/bin',
      PYTHON: '/usr/bin/python3',
      preflight_dir: directory,
      retained_log: retainedLog,
      libclang: library,
      apple_sdk_path: sdk,
      apple_sdk_version: '15.2',
      apple_link_target: target,
      BINDGEN_EXTRA_CLANG_ARGS: bindgenArgs,
      FAKE_LIBCLANG_ARGS_LOG: argumentsLog,
      ...(mode ? { FAKE_LIBCLANG_MODE: mode } : {}),
    },
    stdout: 'piped',
    stderr: 'piped',
  }).output()
  const receipt = JSON.parse(
    await Deno.readTextFile(`${directory}/preflight.json`),
  ) as Record<string, unknown>
  const retainedText = await Deno.readTextFile(retainedLog)
  const marker = 'SLV_MACOS_BINDGEN_PREFLIGHT_EVIDENCE='
  const emitted = retainedText.split('\n').filter((line) =>
    line.startsWith(marker)
  )
  requireFixture(
    emitted.length === 1,
    'macOS preflight did not emit one evidence envelope through tee',
  )
  const envelope = JSON.parse(emitted[0].slice(marker.length)) as Record<
    string,
    unknown
  >
  let parsed: string[] = []
  try {
    const text = await Deno.readTextFile(argumentsLog)
    parsed = text === '' ? [] : text.slice(0, -1).split('\n')
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error
  }
  return { code: result.code, receipt, parsed, retainedLog, envelope }
}

async function runCargoGuard(
  root: string,
  preflightStatus: number,
): Promise<{ code: number; cargoRan: boolean }> {
  const fragment = await recipeFragment(
    '# CARGO_BUILD_GUARD_BEGIN',
    '# CARGO_BUILD_GUARD_END',
  )
  const work = `${root}/work`
  const sentinel = `${root}/cargo-ran`
  const cargo = `${root}/cargo-sentinel.sh`
  await Deno.mkdir(`${work}/deno`, { recursive: true })
  await Deno.writeTextFile(cargo, `#!/usr/bin/bash\ntouch "${sentinel}"\n`)
  await Deno.chmod(cargo, 0o755)
  const result = await new Deno.Command('/usr/bin/bash', {
    args: [
      '-euo',
      'pipefail',
      '-c',
      `${fragment}\ntest "$status" -eq "$expected_status"`,
    ],
    clearEnv: true,
    env: {
      PATH: '/usr/bin:/bin',
      cargo,
      expected_status: String(preflightStatus),
      jobs: '2',
      log: `${root}/baseline-denort.log`,
      macos_bindgen_preflight_status: String(preflightStatus),
      output: root,
      resume: 'true',
      target_args: '()',
      work,
    },
    stdout: 'piped',
    stderr: 'piped',
  }).output()
  let cargoRan = true
  try {
    await Deno.stat(sentinel)
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error
    cargoRan = false
  }
  return { code: result.code, cargoRan }
}

async function assertRetainedMacosPreflightEvidence(
  probe: {
    receipt: Record<string, unknown>
    retainedLog: string
    envelope: Record<string, unknown>
  },
): Promise<void> {
  const files = probe.envelope.files as Record<string, Record<string, unknown>>
  requireFixture(
    probe.envelope.schema_version === 1 &&
      probe.envelope.kind === 'slv-macos-bindgen-preflight-evidence' &&
      JSON.stringify(probe.envelope.preflight) ===
        JSON.stringify(probe.receipt),
    'retained preflight evidence did not carry the complete written receipt',
  )
  for (const name of ['receipt', 'diagnostics']) {
    const binding = files[name]
    const path = binding?.path
    requireFixture(
      typeof path === 'string',
      `retained ${name} binding lacks path`,
    )
    const bytes = await Deno.readFile(path)
    requireFixture(
      binding.size === bytes.length &&
        binding.sha256 === createHash('sha256').update(bytes).digest('hex'),
      `retained ${name} binding does not match its written file`,
    )
  }
  const retained = await Deno.readTextFile(probe.retainedLog)
  requireFixture(
    retained.includes('SLV_MACOS_BINDGEN_PREFLIGHT_EVIDENCE='),
    'preflight evidence was not retained by the tee log',
  )
}

async function runExecutionFailureFixture(
  root: string,
  log: string,
  digest: string,
  exitCode: number,
  executeLog: string,
): Promise<Deno.CommandOutput> {
  const fixture = `${root}/execution-failure-fixture.ts`
  const runner = `${root}/retain-execute-log.sh`
  await Deno.writeTextFile(
    fixture,
    `import { assertExecutionSucceeded } from ${
      JSON.stringify(
        new URL('./verify-native.ts', import.meta.url).href,
      )
    }
const [log, digest, code] = Deno.args
await assertExecutionSucceeded({
  command: ['fixture'],
  cwd: '.',
  started_at: '2026-10-14T00:00:00Z',
  finished_at: '2026-10-14T00:00:01Z',
  exit_code: Number(code),
  log,
  log_sha256: digest,
  environment: {},
}, 'synthetic bridge acceptance')
`,
  )
  await Deno.writeTextFile(
    runner,
    `#!/usr/bin/bash
set -uo pipefail
"$1" run --quiet --allow-read "$2" "$3" "$4" "$5" 2>&1 | /usr/bin/tee "$6"
status="\${PIPESTATUS[0]}"
exit "$status"
`,
  )
  await Deno.chmod(runner, 0o755)
  return await new Deno.Command('/usr/bin/bash', {
    args: [
      runner,
      Deno.execPath(),
      fixture,
      log,
      digest,
      String(exitCode),
      executeLog,
    ],
    clearEnv: true,
    env: { PATH: '/usr/bin:/bin' },
    stdout: 'piped',
    stderr: 'piped',
  }).output()
}

Deno.test('execution failures retain bounded redacted diagnostics in execute logs', async () => {
  const root = await Deno.makeTempDir({
    prefix: 'slv-native-execute-diagnostics-',
  })
  try {
    const commandLog = `${root}/command.log`
    const executeLog = `${root}/execute.log`
    const leak = 'fixture-secret-value-must-not-appear'
    await Deno.writeTextFile(
      commandLog,
      `${'é'.repeat(2600)}
FIXTURE_ENVIRONMENT_DUMP=${leak}
Authorization: Bearer ${leak}
synthetic execution reason
`,
    )
    const failed = await runExecutionFailureFixture(
      root,
      commandLog,
      'a'.repeat(64),
      23,
      executeLog,
    )
    if (failed.success) {
      throw new Error('nonzero execution receipt unexpectedly succeeded')
    }
    const retained = await Deno.readTextFile(executeLog)
    for (
      const expected of [
        'execution failure diagnostics: synthetic bridge acceptance',
        'exit_code: 23',
        `recorded_log_sha256: ${'a'.repeat(64)}`,
        `log_tail_bytes: 4096/${
          (await Deno.stat(commandLog)).size
        } (truncated)`,
        'synthetic execution reason',
        'synthetic bridge acceptance failed (exit 23); inspect',
      ]
    ) {
      if (!retained.includes(expected)) {
        throw new Error(`retained execute log is missing: ${expected}`)
      }
    }
    if (retained.includes(leak)) {
      throw new Error('retained execute log exposed a fixture secret')
    }

    const missingExecuteLog = `${root}/missing-execute.log`
    const missing = await runExecutionFailureFixture(
      root,
      `${root}/missing-command.log`,
      'b'.repeat(64),
      23,
      missingExecuteLog,
    )
    if (missing.success) {
      throw new Error('missing-log execution receipt unexpectedly succeeded')
    }
    const missingRetained = await Deno.readTextFile(missingExecuteLog)
    if (
      !missingRetained.includes('execution failure log unavailable') ||
      !missingRetained.includes(
        'synthetic bridge acceptance failed (exit 23); inspect',
      )
    ) {
      throw new Error('missing log did not preserve its failure diagnostics')
    }

    const success = await assertExecutionSucceeded(
      {
        command: ['fixture'],
        cwd: '.',
        started_at: '2026-10-14T00:00:00Z',
        finished_at: '2026-10-14T00:00:01Z',
        exit_code: 0,
        log: `${root}/unread-success.log`,
        log_sha256: 'c'.repeat(64),
        environment: {},
      },
      'successful fixture',
    )
    if (success !== undefined) {
      throw new Error('successful execution receipt changed its success result')
    }
  } finally {
    await Deno.remove(root, { recursive: true })
  }
})

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
      / {2,6}run_guarded_cargo_command "\$cargo" build --locked --offline --release \${target_args\[@\]\+"\${target_args\[@\]}"} -j "\$jobs" -p denort/g,
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
      const executableCargoCall = cargoCall.replace(
        'run_guarded_cargo_command ',
        '',
      )
      const empty = await runRecipeCommand(
        executableCargoCall,
        'target_args=()',
        root,
      )
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
        executableCargoCall,
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

Deno.test('macOS bindgen preflight passes exact SDK tokens to paired libclang before Cargo', async () => {
  const root = await Deno.makeTempDir({
    prefix: 'slv-macos-bindgen-preflight-',
  })
  try {
    const sdk = `${root}/selected SDK with spaces`
    const resource = `${root}/paired resource with spaces`
    await Deno.mkdir(`${sdk}/usr/include`, { recursive: true })
    for (
      const header of [
        'stdlib.h',
        'stdint.h',
        'stddef.h',
        'sys/types.h',
      ]
    ) {
      if (header.includes('/')) {
        await Deno.mkdir(
          `${sdk}/usr/include/${header.slice(0, header.lastIndexOf('/'))}`,
          { recursive: true },
        )
      }
      await Deno.writeTextFile(
        `${sdk}/usr/include/${header}`,
        '/* fixture */\n',
      )
    }
    await Deno.mkdir(`${resource}/include`, { recursive: true })
    await Deno.writeTextFile(`${resource}/include/stddef.h`, '/* fixture */\n')
    const library = await writeFixtureLibclang(root)
    const librarySha256 = createHash('sha256').update(
      await Deno.readFile(library),
    ).digest('hex')
    const expectedSdk = await Deno.realPath(sdk)
    const expectedLibrary = await Deno.realPath(library)
    const expectedResource = await Deno.realPath(resource)

    for (const target of ['x86_64-apple-darwin', 'aarch64-apple-darwin']) {
      const serialized = await macosBindgenArguments(target, sdk, resource)
      const expected = [
        `--target=${target}`,
        '-isysroot',
        expectedSdk,
        '-isystem',
        `${expectedResource}/include`,
      ]
      requireFixture(
        JSON.stringify(await parseShellArguments(serialized)) ===
          JSON.stringify(expected),
        `serialized ${target} bindgen arguments changed an SDK/resource path with spaces`,
      )
      const probe = await runMacosBindgenPreflight(
        `${root}/${target}-probe`,
        library,
        sdk,
        target,
        serialized,
      )
      await assertRetainedMacosPreflightEvidence(probe)
      const libclang = probe.receipt.libclang as Record<string, unknown>
      const selectedSdk = probe.receipt.sdk as Record<string, unknown>
      const logs = probe.receipt.logs as Record<string, Record<string, unknown>>
      requireFixture(
        probe.code === 0 && probe.receipt.status === 'passed',
        `${target} preflight did not pass`,
      )
      requireFixture(
        probe.receipt.target === target &&
          JSON.stringify(probe.receipt.parsed_args) ===
            JSON.stringify(expected) &&
          JSON.stringify(probe.parsed) === JSON.stringify(expected),
        `${target} preflight did not give libclang the serialized bindgen tokens`,
      )
      requireFixture(
        libclang.path === expectedLibrary &&
          libclang.sha256 === librarySha256 &&
          selectedSdk.path === expectedSdk && selectedSdk.version === '15.2',
        `${target} preflight receipt did not bind the selected libclang and SDK`,
      )
      const diagnostics = await Deno.readFile(
        `${root}/${target}-probe/diagnostics.log`,
      )
      requireFixture(
        logs['diagnostics.log'].sha256 ===
          createHash('sha256').update(diagnostics).digest('hex'),
        `${target} preflight diagnostics log is not hash-bound`,
      )
    }

    const recipe = await Deno.readTextFile(nativeRecipe)
    for (
      const field of [
        'macos_bindgen_preflight_receipt_sha256=%s',
        'macos_bindgen_preflight_diagnostics_log_sha256=%s',
        'macos_bindgen_preflight_status=%s',
        'SLV_MACOS_BINDGEN_PREFLIGHT_EVIDENCE=',
        'sys.stdout.flush()',
      ]
    ) {
      requireFixture(
        recipe.includes(field),
        `baseline recipe receipt does not bind ${field}`,
      )
    }
    const successfulCargo = await runCargoGuard(`${root}/successful-cargo`, 0)
    requireFixture(
      successfulCargo.code === 0 && successfulCargo.cargoRan,
      'successful macOS preflight did not release Cargo',
    )
  } finally {
    await Deno.remove(root, { recursive: true })
  }
})

Deno.test('macOS bindgen preflight records invalid SDK and libclang failures before Cargo', async () => {
  const root = await Deno.makeTempDir({ prefix: 'slv-macos-bindgen-negative-' })
  try {
    const sdk = `${root}/selected SDK`
    const resource = `${root}/paired resource`
    await Deno.mkdir(`${sdk}/usr/include`, { recursive: true })
    for (
      const header of [
        'stdlib.h',
        'stdint.h',
        'stddef.h',
        'sys/types.h',
      ]
    ) {
      if (header.includes('/')) {
        await Deno.mkdir(
          `${sdk}/usr/include/${header.slice(0, header.lastIndexOf('/'))}`,
          { recursive: true },
        )
      }
      await Deno.writeTextFile(
        `${sdk}/usr/include/${header}`,
        '/* fixture */\n',
      )
    }
    await Deno.mkdir(`${resource}/include`, { recursive: true })
    const library = await writeFixtureLibclang(root)
    const invalidLibrary = `${root}/invalid-libclang.dylib`
    await Deno.writeTextFile(invalidLibrary, 'not a shared library\n')
    const target = 'x86_64-apple-darwin'
    const validArgs = await macosBindgenArguments(target, sdk, resource)

    const missingHeaderSdk = `${root}/SDK missing sys types`
    for (const header of ['stdlib.h', 'stdint.h', 'stddef.h']) {
      await Deno.mkdir(`${missingHeaderSdk}/usr/include`, { recursive: true })
      await Deno.writeTextFile(
        `${missingHeaderSdk}/usr/include/${header}`,
        '/* fixture */\n',
      )
    }
    const cases: Array<{
      name: string
      library?: string
      sdk: string
      args: string
      mode?: 'parse' | 'fatal'
      requiredDiagnostic: string
    }> = [
      {
        name: 'invalid-libclang',
        library: invalidLibrary,
        sdk,
        args: validArgs,
        requiredDiagnostic: 'file too short',
      },
      {
        name: 'invalid-sdk',
        sdk: `${root}/SDK absent`,
        args: await macosBindgenArguments(
          target,
          `${root}/SDK absent`,
          resource,
        ),
        requiredDiagnostic: 'not a directory',
      },
      {
        name: 'missing-header',
        sdk: missingHeaderSdk,
        args: await macosBindgenArguments(target, missingHeaderSdk, resource),
        requiredDiagnostic: 'sys/types.h',
      },
      {
        name: 'parse-failure',
        sdk,
        args: validArgs,
        mode: 'parse',
        requiredDiagnostic: 'could not parse',
      },
      {
        name: 'fatal-diagnostic',
        sdk,
        args: validArgs,
        mode: 'fatal',
        requiredDiagnostic: 'error or fatal diagnostic',
      },
    ]
    for (const fixture of cases) {
      const probe = await runMacosBindgenPreflight(
        `${root}/${fixture.name}`,
        fixture.library ?? library,
        fixture.sdk,
        target,
        fixture.args,
        fixture.mode,
      )
      await assertRetainedMacosPreflightEvidence(probe)
      const diagnostics = probe.receipt.diagnostics as Array<
        Record<string, unknown>
      >
      const retainedRecord = probe.envelope.preflight as Record<string, unknown>
      const guard = await runCargoGuard(
        `${root}/${fixture.name}-cargo`,
        probe.code,
      )
      requireFixture(
        probe.code === 65 && probe.receipt.status === 'failed' &&
          retainedRecord.status === 'failed' &&
          retainedRecord.target === target &&
          Array.isArray(retainedRecord.parsed_args) &&
          JSON.stringify(diagnostics).includes(fixture.requiredDiagnostic),
        `${fixture.name} did not retain its pre-Cargo failure receipt`,
      )
      requireFixture(
        guard.code === 0 && !guard.cargoRan,
        `${fixture.name} reached Cargo after bindgen preflight failure`,
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

Deno.test('split native CLI permits bounded Linux parallelism and retains macOS jobs and producer requirements', () => {
  const common = [
    '--target',
    'x86_64-apple-darwin',
    '--source-root',
    'source',
    '--work-dir',
    'work',
    '--out',
    'out',
    '--pins',
    'pins.json',
    '--source-receipt',
    'source-receipt.json',
    '--slv-source',
    'slv.tar.gz',
    '--deno-source',
    'deno.tar.gz',
    '--cargo-vendor',
    'vendor.tar.gz',
    '--notice-file',
    'THIRD_PARTY_NOTICES',
  ]
  const producer = (target: string, jobs: string) => [
    '--phase',
    'build-variant',
    ...common.map((value) => value === 'x86_64-apple-darwin' ? target : value),
    '--variant',
    'baseline',
    '--build-host',
    target === 'aarch64-unknown-linux-gnu'
      ? 'x86_64-unknown-linux-gnu'
      : target,
    '--jobs',
    jobs,
    '--tools-receipt',
    'tools.json',
    '--producer-context',
    'producer.json',
  ]
  for (
    const [target, jobs] of [
      ['x86_64-unknown-linux-gnu', '2'],
      ['x86_64-unknown-linux-gnu', '4'],
      ['x86_64-unknown-linux-gnu', '8'],
      ['x86_64-unknown-linux-gnu', '16'],
      ['aarch64-unknown-linux-gnu', '2'],
      ['aarch64-unknown-linux-gnu', '4'],
      ['aarch64-unknown-linux-gnu', '8'],
      ['aarch64-unknown-linux-gnu', '16'],
      ['x86_64-apple-darwin', '4'],
    ] as const
  ) {
    const parsed = parseNativeArgs(producer(target, jobs))
    if (parsed['--variant'] !== 'baseline' || parsed['--jobs'] !== jobs) {
      throw new Error(
        `valid ${target} split producer arguments were not retained`,
      )
    }
  }
  const rejected = (argv: string[], expected: string) => {
    try {
      parseNativeArgs(argv)
    } catch (error) {
      if (error instanceof Error && error.message.includes(expected)) return
    }
    throw new Error(`expected split CLI rejection containing: ${expected}`)
  }
  rejected(
    producer('x86_64-apple-darwin', '2'),
    'requires --jobs 4',
  )
  for (
    const target of ['x86_64-unknown-linux-gnu', 'aarch64-unknown-linux-gnu']
  ) {
    for (const jobs of ['1', '3', '15']) {
      rejected(producer(target, jobs), 'requires --jobs 2, 4, 8, or 16')
    }
    for (const jobs of ['0', '17', '32', '016', '16.0', '16x']) {
      rejected(producer(target, jobs), '--jobs is permitted only')
    }
  }
  rejected(producer('x86_64-apple-darwin', '16'), 'requires --jobs 4')
  rejected(
    producer('x86_64-apple-darwin', '4').filter((_, index, argv) =>
      index < argv.indexOf('--producer-context')
    ),
    'requires --producer-context',
  )
  rejected(
    [
      '--phase',
      'join-build',
      ...common,
      '--producer-context',
      'join.json',
      '--variant-dependencies',
      'dependencies.json',
      '--jobs',
      '4',
    ],
    '--jobs is permitted only',
  )
  rejected(
    [
      ...producer('x86_64-apple-darwin', '4'),
      '--variant-dependencies',
      'dependencies.json',
    ],
    'does not accept --variant-dependencies',
  )
})

Deno.test('split evidence preserves original producer receipt bytes and combined baseline-only product inputs', async () => {
  const hash = (character: string) => character.repeat(64)
  const command = {
    command: ['fixture'],
    cwd: '/producer/work',
    started_at: '2026-10-14T00:00:00Z',
    finished_at: '2026-10-14T00:00:01Z',
    exit_code: 0,
    log: '/producer/work/fixture.log',
    log_sha256: hash('a'),
  }
  const sourceAssets = [
    { name: 'slv-source.tar.gz', sha256: hash('1'), size: 1 },
    { name: 'deno-source.tar.gz', sha256: hash('2'), size: 1 },
    { name: 'deno-cargo-vendor.tar.gz', sha256: hash('3'), size: 1 },
  ]
  const names = [
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
  ]
  const entries = Object.fromEntries(
    names.map((name, index) => [
      name,
      { path: name, sha256: hash((index + 1).toString(16)), size: index + 1 },
    ]),
  ) as Record<string, { path: string; sha256: string; size: number }>
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
  const context = (job_id: string) => ({
    schema_version: 1,
    kind: 'slv-native-producer-context',
    repository: 'ValidatorsDAO/slv',
    workflow:
      'ValidatorsDAO/slv/.github/workflows/slv-remote-build.yml@fixture',
    run_id: '42',
    run_attempt: '3',
    job_id,
  })
  const fingerprints = (
    phase: 'baseline' | 'modified',
    runtime_sha256: string,
  ) => {
    const content = `{"phase":"${phase}"}\n`
    return {
      schema_version: 1,
      kind: 'slv-cargo-fingerprint-records',
      phase,
      target: 'x86_64-apple-darwin',
      runtime_sha256,
      derived_relink_cargo_lock_sha256:
        artifacts.baseline.derived_relink_cargo_lock_sha256,
      records: [{
        context: 'host-release',
        path: `${phase}/fixture.json`,
        sha256: createHash('sha256').update(content).digest('hex'),
        content_base64: btoa(content),
      }],
    }
  }
  const identities = {
    'fixture-tool': { path: '/producer/tools/fixture', sha256: hash('4') },
  }
  const archives = {
    fixture: { sha256: hash('5'), size: 1, url: 'https://example.test/tool' },
  }
  const variantReceipt = (variant: 'baseline' | 'modified') => {
    const runtime = variant === 'baseline'
      ? artifacts.baseline.denort_sha256
      : artifacts.modified.denort_sha256
    const primary = {
      passed: true,
      command,
      probe_compile: command,
      derived_relink_cargo_lock_sha256:
        artifacts.baseline.derived_relink_cargo_lock_sha256,
      runtime_abi: { denort_sha256: runtime, status: 'passed' },
      runtime_abi_receipt_sha256: hash('a'),
      cargo_fingerprints: fingerprints(variant, runtime),
    }
    return {
      schema_version: 1,
      kind: 'slv-source-build-variant-receipt',
      variant,
      producer: context(`source-macos-x64-${variant}`),
      target: 'x86_64-apple-darwin',
      build_mode: 'native',
      build_host: { os: 'darwin', arch: 'x64' },
      source_commit: 'c'.repeat(40),
      source_receipt_sha256: hash('6'),
      source_assets: sourceAssets,
      source_pin_sha256: hash('7'),
      notice_sha256: hash('8'),
      source_selected_cargo_lock_sha256: hash('9'),
      tool_pin_sha256: hash('b'),
      toolchain: { pins_sha256: hash('c'), identities },
      tool_archives: archives,
      tools_receipt_sha256: hash('d'),
      jobs: '4',
      resources: { capacity_preflight: {} },
      extraction: {
        slv_scan: command,
        deno_scan: command,
        vendor_scan: command,
        slv: command,
        deno: command,
        vendor: command,
      },
      recipe_sha256: hash('e'),
      patch_sha256: hash('f'),
      derived_relink_cargo_lock_sha256:
        artifacts.baseline.derived_relink_cargo_lock_sha256,
      transport: {
        manifest: 'transport/manifest.json',
        manifest_sha256: hash('a'),
      },
      entries: Object.fromEntries(
        Object.entries(entries).filter(([name]) =>
          name.startsWith(`${variant}-`) ||
          (variant === 'baseline' && name.startsWith('tls-'))
        ),
      ),
      checks: variant === 'baseline'
        ? {
          baseline_build: primary,
          slv_compile: { passed: true, command, bridge_compile: command },
        }
        : {
          patch: {
            passed: true,
            before_sha256: hash('1'),
            after_sha256: hash('2'),
            command,
          },
          modified_build: primary,
        },
      timing: {
        started_at: '2026-10-14T00:00:00Z',
        finished_at: '2026-10-14T00:00:01Z',
      },
    }
  }
  const baseline = variantReceipt('baseline')
  const modified = variantReceipt('modified')
  const encodedRole = (receipt: Record<string, unknown>, id: string) => {
    const bytes = new TextEncoder().encode(
      JSON.stringify(receipt, null, 2) + '\n',
    )
    return {
      receipt_sha256: createHash('sha256').update(bytes).digest('hex'),
      artifact_id: id,
      artifact_digest: hash(id === '100' ? 'c' : 'd'),
      receipt,
      receipt_bytes_base64: btoa(String.fromCharCode(...bytes)),
    }
  }
  const split = {
    schema_version: 1,
    kind: 'slv-source-split-build-evidence',
    join_producer: context('source-native-macos-x64'),
    baseline: encodedRole(baseline, '100'),
    modified: encodedRole(modified, '101'),
  }
  const build = {
    build_mode: 'native',
    build_host: { os: 'darwin', arch: 'x64' },
    jobs: '4',
    patch_sha256: hash('f'),
    tool_pin_sha256: hash('b'),
    toolchain: { pins_sha256: hash('c'), identities },
    recipe_sha256: { baseline: hash('e'), modified: hash('e') },
    checks: {
      baseline_build: baseline.checks.baseline_build,
      slv_compile: baseline.checks.slv_compile,
      patch: modified.checks.patch,
      modified_build: modified.checks.modified_build,
    },
  }
  const inputs = {
    assembly: {
      source: { commit: 'c'.repeat(40) },
      runtime_security: { selected: { cargo_lock: { sha256: hash('9') } } },
    },
    assemblyReceiptSha256: hash('6'),
    pinsSha256: hash('7'),
    noticeSha256: hash('8'),
    sourceAssets,
  }
  await verifySplitBuildEvidence(
    split,
    build,
    inputs as never,
    'x86_64-apple-darwin',
    artifacts,
    entries,
  )
  const tampered = structuredClone(split)
  tampered.baseline.receipt_bytes_base64 = btoa('{"tampered":true}\n')
  await expectLayoutRejection(
    () =>
      verifySplitBuildEvidence(
        tampered,
        build,
        inputs as never,
        'x86_64-apple-darwin',
        artifacts,
        entries,
      ),
    'differs from original bytes',
  )
  const archiveMismatch = structuredClone(split)
  const changedModified = structuredClone(modified) as Record<string, unknown>
  const changedArchives = changedModified.tool_archives as Record<
    string,
    Record<string, unknown>
  >
  changedArchives.fixture = {
    ...changedArchives.fixture,
    included_members: ['fixture/member'],
  }
  archiveMismatch.modified = encodedRole(changedModified, '101')
  await expectLayoutRejection(
    () =>
      verifySplitBuildEvidence(
        archiveMismatch,
        build,
        inputs as never,
        'x86_64-apple-darwin',
        artifacts,
        entries,
      ),
    'tool archives',
  )
})

function fixtureSha256(bytes: Uint8Array | string): string {
  return createHash('sha256').update(bytes).digest('hex')
}

async function fixtureFileSha256(path: string): Promise<string> {
  return fixtureSha256(await Deno.readFile(path))
}

async function writeFixtureJson(path: string, value: unknown): Promise<string> {
  await Deno.mkdir(path.slice(0, path.lastIndexOf('/')), { recursive: true })
  await Deno.writeTextFile(path, JSON.stringify(value, null, 2) + '\n')
  return await fixtureFileSha256(path)
}

async function writeFixtureFile(path: string, text: string): Promise<void> {
  await Deno.mkdir(path.slice(0, path.lastIndexOf('/')), { recursive: true })
  await Deno.writeTextFile(path, text)
}

async function archiveFixtureRoot(
  stage: string,
  root: string,
  archive: string,
): Promise<void> {
  const result = await new Deno.Command('/usr/bin/tar', {
    args: ['-C', stage, '-czf', archive, root],
    clearEnv: true,
    env: { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C', TZ: 'UTC' },
    stdout: 'piped',
    stderr: 'piped',
  }).output()
  if (!result.success) {
    throw new Error(
      `fixture archive failed: ${new TextDecoder().decode(result.stderr)}`,
    )
  }
}

type NativeJoinFixture = {
  root: string
  target: string
  args: Record<string, string>
  out: string
  dependenciesPath: string
  baselineMaterials: string
  modifiedMaterials: string
  baselineReceipt: string
  modifiedReceipt: string
  sourceReceipt: string
  notice: string
  pins: string
  slvSource: string
  denoSource: string
  cargoVendor: string
  producerContext: Record<string, unknown>
}

/**
 * This is intentionally a file-backed join fixture.  It has miniature source
 * archives, real producer directories, raw receipt sidecars, descriptors,
 * manifests, and payload bytes so the production join phase owns every
 * boundary that a downloaded workflow artifact crosses.
 */
async function createNativeJoinFixture(
  root: string,
  target: 'x86_64-apple-darwin' | 'x86_64-unknown-linux-gnu' =
    'x86_64-apple-darwin',
  jobs = target === 'x86_64-unknown-linux-gnu' ? '2' : '4',
): Promise<NativeJoinFixture> {
  const linux = target === 'x86_64-unknown-linux-gnu'
  const buildHost = linux ? { os: 'linux', arch: 'x64' } : {
    os: 'darwin',
    arch: 'x64',
  }
  const producerPrefix = linux ? 'source-linux-x64' : 'source-macos-x64'
  const stage = `${root}/source-stage`
  const input = `${root}/input`
  const notice = `${input}/THIRD_PARTY_NOTICES`
  const pins = `${input}/source-pins.json`
  const slvSource = `${input}/slv-source.tar.gz`
  const denoSource = `${input}/deno-source.tar.gz`
  const cargoVendor = `${input}/deno-cargo-vendor.tar.gz`
  const closure = '{"fixture":"closure"}\n'
  const inventory = '{"fixture":"inventory"}\n'
  const noticeBytes = 'fixture notices\n'
  await writeFixtureFile(notice, noticeBytes)
  const sourcePins = {
    schema_version: 1,
    deno: {
      commit: 'a'.repeat(40),
      version: '1.2.3',
      archive:
        'https://github.com/denoland/deno/archive/refs/tags/v1.2.3.tar.gz',
      sha256: fixtureSha256('deno'),
    },
    rusty_v8: {
      commit: 'b'.repeat(40),
      archive: `https://github.com/denoland/rusty_v8/archive/${
        'b'.repeat(40)
      }.tar.gz`,
      sha256: fixtureSha256('rusty-v8'),
    },
    v8: {
      commit: 'c'.repeat(40),
      archive: `https://github.com/denoland/v8/archive/${
        'c'.repeat(40)
      }.tar.gz`,
      sha256: fixtureSha256('v8'),
    },
    gitlink_closure: {
      path: 'source-materials/rusty-v8-gitlinks.json',
      sha256: fixtureSha256('gitlinks'),
    },
  }
  const sourcePinsSha256 = await writeFixtureJson(pins, sourcePins)
  const roots = ['slv-source', 'deno-source', 'deno-cargo-vendor']
  for (const name of roots) {
    await writeFixtureFile(
      `${stage}/${name}/source-materials/pack-manifest.json`,
      '{"fixture":true}\n',
    )
    await writeFixtureFile(
      `${stage}/${name}/source-materials/closure.json`,
      closure,
    )
    await writeFixtureFile(
      `${stage}/${name}/source-materials/inventory.json`,
      inventory,
    )
    await writeFixtureFile(`${stage}/${name}/THIRD_PARTY_NOTICES`, noticeBytes)
  }
  const toolPinsPath = `${Deno.cwd()}/source-rebuild/tool-prereqs.json`
  await Deno.mkdir(`${stage}/slv-source/source-rebuild`, { recursive: true })
  await Deno.copyFile(
    toolPinsPath,
    `${stage}/slv-source/source-rebuild/tool-prereqs.json`,
  )
  await writeFixtureFile(
    `${stage}/slv-source/source-rebuild/build-baseline-denort.sh`,
    '#!/usr/bin/env bash\necho fixture\n',
  )
  await writeFixtureFile(
    `${stage}/slv-source/source-rebuild/glibc-sin-sentinel.patch`,
    'fixture patch bytes\n',
  )
  await Deno.mkdir(`${stage}/slv-source/deno-cache`, { recursive: true })
  const securityFiles = {
    'source-materials/security/upstream-Cargo.lock': 'upstream lock\n',
    'source-materials/security/upstream-Cargo.toml': 'upstream manifest\n',
    'deno/Cargo.lock': 'selected lock\n',
    'deno/Cargo.toml': 'selected manifest\n',
    'source-materials/security/selection.json': '{}\n',
    'source-materials/security/manifest-patch.json': '{}\n',
    'source-materials/security/resolution-receipt.json': '{}\n',
    'source-materials/security/added-identities-osv.json': '{}\n',
  }
  for (const [relative, content] of Object.entries(securityFiles)) {
    await writeFixtureFile(`${stage}/deno-source/${relative}`, content)
  }
  await writeFixtureFile(
    `${stage}/deno-source/rusty_v8/v8/BUILD.gn`,
    'fixture gn\n',
  )
  await writeFixtureFile(
    `${stage}/deno-cargo-vendor/Cargo.lock`,
    securityFiles['deno/Cargo.lock'],
  )
  await Deno.mkdir(`${stage}/deno-cargo-vendor/vendor`, { recursive: true })
  await archiveFixtureRoot(stage, 'slv-source', slvSource)
  await archiveFixtureRoot(stage, 'deno-source', denoSource)
  await archiveFixtureRoot(stage, 'deno-cargo-vendor', cargoVendor)
  const archiveAssets = await Promise.all([
    ['slv-source.tar.gz', slvSource],
    ['deno-source.tar.gz', denoSource],
    ['deno-cargo-vendor.tar.gz', cargoVendor],
  ].map(async ([name, path]) => ({
    name,
    sha256: await fixtureFileSha256(path),
    size: (await Deno.stat(path)).size,
    embedded_manifest_path: 'source-materials/pack-manifest.json',
  })))
  const security = async (relative: string) => ({
    path: relative,
    sha256: await fixtureFileSha256(`${stage}/deno-source/${relative}`),
  })
  const selectedLock = await security('deno/Cargo.lock')
  const sourceReceiptValue = {
    schema_version: 1,
    kind: 'slv-source-materials',
    mode: 'reviewed',
    source: {
      commit: 'd'.repeat(40),
      tree_sha256: fixtureSha256('tree'),
      timestamp: '2026-10-14T00:00:00Z',
      timestamp_epoch: 1,
    },
    canonical_notice: {
      path: 'THIRD_PARTY_NOTICES',
      sha256: fixtureSha256(noticeBytes),
      size: noticeBytes.length,
    },
    pins: { ...sourcePins, sha256: sourcePinsSha256 },
    closure: {
      embedded_path: 'source-materials/closure.json',
      sha256: fixtureSha256(closure),
      entry_count: 1,
    },
    inventory: {
      embedded_path: 'source-materials/inventory.json',
      sha256: fixtureSha256(inventory),
    },
    vendor: {
      policy: 'full-locked-vendor',
      lock_path: 'Cargo.lock',
      lock_sha256: selectedLock.sha256,
      crate_count: 1,
      omissions: [],
    },
    runtime_security: {
      upstream: {
        cargo_lock: {
          ...(await security('source-materials/security/upstream-Cargo.lock')),
          package_count: 1,
        },
        cargo_manifest: await security(
          'source-materials/security/upstream-Cargo.toml',
        ),
      },
      selected: {
        cargo_lock: { ...selectedLock, package_count: 2 },
        cargo_manifest: await security('deno/Cargo.toml'),
      },
      transform: {
        selection: await security('source-materials/security/selection.json'),
        manifest_patch: await security(
          'source-materials/security/manifest-patch.json',
        ),
        resolution_receipt: await security(
          'source-materials/security/resolution-receipt.json',
        ),
        added_identities_osv: await security(
          'source-materials/security/added-identities-osv.json',
        ),
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
    },
    gitlink_closure: {
      path: 'source-materials/rusty-v8-gitlinks.json',
      sha256: sourcePins.gitlink_closure.sha256,
      root_tree: 'e'.repeat(40),
      gitlink_count: 1,
    },
    source_legal_evidence: {
      index_path: 'source-materials/rusty-v8-source-license-index.json',
      sha256: fixtureSha256('legal'),
      source_distributed_extra_tree_count: 7,
      supplement_count: 3,
    },
    assets: archiveAssets,
    rebuild_proof: { required: true, status: 'separate' },
  }
  const sourceReceipt = `${input}/source-materials-receipt.json`
  const sourceReceiptSha256 = await writeFixtureJson(
    sourceReceipt,
    sourceReceiptValue,
  )
  const sourceAssets = archiveAssets.map(({ name, sha256, size }) => ({
    name,
    sha256,
    size,
  }))
  const recipeSha256 = await fixtureFileSha256(
    `${stage}/slv-source/source-rebuild/build-baseline-denort.sh`,
  )
  const patchSha256 = await fixtureFileSha256(
    `${stage}/slv-source/source-rebuild/glibc-sin-sentinel.patch`,
  )
  const toolPinsBytes = await Deno.readFile(
    `${stage}/slv-source/source-rebuild/tool-prereqs.json`,
  )
  const toolPinsSha256 = fixtureSha256(toolPinsBytes)
  const descriptor = canonicalTargetDescriptorBytes(
    parseToolPins(JSON.parse(new TextDecoder().decode(toolPinsBytes))),
    target,
  )
  const descriptorSha256 = fixtureSha256(descriptor)
  const command = (variant: string, name: string) => ({
    command: ['fixture', name],
    cwd: `${root}/${variant}/work`,
    started_at: '2026-10-14T00:00:00Z',
    finished_at: '2026-10-14T00:00:01Z',
    exit_code: 0,
    log: `${root}/${variant}/logs/${name}.log`,
    log_sha256: fixtureSha256(`${variant}-${name}`),
  })
  const producerContext = {
    schema_version: 1,
    kind: 'slv-native-producer-context',
    repository: 'ValidatorsDAO/slv',
    workflow:
      'ValidatorsDAO/slv/.github/workflows/slv-remote-build.yml@fixture',
    run_id: '42',
    run_attempt: '3',
    job_id: `source-native-${linux ? 'linux-x64' : 'macos-x64'}`,
  }
  const makeRole = async (variant: 'baseline' | 'modified') => {
    const materials = `${root}/${variant}`
    const transport = `${materials}/transport`
    await Deno.mkdir(transport, { recursive: true })
    const names = variant === 'baseline'
      ? [
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
      ]
      : [
        'modified-denort',
        'modified-v8-archive',
        'modified-ninja',
        'modified-probe',
      ]
    const entries: Record<
      string,
      { path: string; sha256: string; size: number }
    > = {}
    for (const name of names) {
      const bytes = `${variant} ${name} payload\n`
      await writeFixtureFile(`${transport}/${name}`, bytes)
      entries[name] = {
        path: name,
        sha256: fixtureSha256(bytes),
        size: bytes.length,
      }
    }
    const manifest = {
      schema_version: 1,
      kind: 'slv-source-native-variant-transport',
      variant,
      target,
      source_receipt_sha256: sourceReceiptSha256,
      entries,
    }
    const manifestSha256 = await writeFixtureJson(
      `${transport}/manifest.json`,
      manifest,
    )
    await Deno.writeFile(`${materials}/tool-pin.json`, descriptor)
    const identities = {
      'fixture-tool': {
        path: `${root}/${variant}/tools/fixture-tool`,
        sha256: fixtureSha256('fixture tool'),
      },
    }
    const archives = {
      fixture: {
        sha256: fixtureSha256('fixture archive'),
        size: 1,
        url: 'https://example.test/fixture.tar.gz',
        included_members: ['fixture/member'],
      },
    }
    const toolReceipt = {
      schema_version: 1,
      kind: 'slv-native-toolchain',
      target,
      build_host: target,
      purpose: 'build',
      pins: { sha256: toolPinsSha256 },
      target_descriptor: { sha256: descriptorSha256 },
      identities,
      archives,
    }
    const toolsReceiptSha256 = await writeFixtureJson(
      `${materials}/build-tools-receipt.json`,
      toolReceipt,
    )
    const runtime =
      entries[variant === 'baseline' ? 'baseline-denort' : 'modified-denort']
        .sha256
    const derived = fixtureSha256(
      'baseline baseline-derived-relink-Cargo.lock payload\n',
    )
    const fingerprintContent =
      `{"phase":"${variant}","context":"host-release"}\n`
    const primary = {
      passed: true,
      command: command(variant, 'build'),
      probe_compile: command(variant, 'probe'),
      derived_relink_cargo_lock_sha256: derived,
      runtime_abi: linux
        ? {
          schema_version: 1,
          kind: 'slv-linux-denort-abi',
          denort_sha256: runtime,
          glibc_private: 'absent',
          rpath_or_runpath: 'absent',
          glibc_versions: [],
          status: 'passed',
        }
        : {
          schema_version: 1,
          kind: 'slv-macos-denort-abi',
          denort_sha256: runtime,
          minimum_os: '12.0',
          load_commands_sha256: fixtureSha256(`${variant} load commands`),
          status: 'passed',
        },
      runtime_abi_receipt_sha256: fixtureSha256(`${variant} ABI`),
      cargo_fingerprints: {
        schema_version: 1,
        kind: 'slv-cargo-fingerprint-records',
        phase: variant,
        target,
        runtime_sha256: runtime,
        derived_relink_cargo_lock_sha256: derived,
        records: [
          {
            context: 'host-release',
            path: `${variant}/host-release.json`,
            sha256: fixtureSha256(fingerprintContent),
            content_base64: btoa(fingerprintContent),
          },
          ...(linux
            ? [{
              context: 'target-release',
              path: `${variant}/target-release.json`,
              sha256: fixtureSha256(fingerprintContent),
              content_base64: btoa(fingerprintContent),
            }]
            : []),
        ],
      },
    }
    const receipt = {
      schema_version: 1,
      kind: 'slv-source-build-variant-receipt',
      variant,
      producer: {
        ...producerContext,
        job_id: `${producerPrefix}-${variant}`,
        run_attempt: variant === 'baseline' ? '2' : '3',
      },
      target,
      build_mode: 'native',
      build_host: buildHost,
      source_commit: sourceReceiptValue.source.commit,
      source_receipt_sha256: sourceReceiptSha256,
      source_assets: sourceAssets,
      source_pin_sha256: sourcePinsSha256,
      notice_sha256: fixtureSha256(noticeBytes),
      source_selected_cargo_lock_sha256: selectedLock.sha256,
      tool_pin_sha256: descriptorSha256,
      toolchain: { pins_sha256: toolPinsSha256, identities },
      tool_archives: archives,
      tools_receipt_sha256: toolsReceiptSha256,
      jobs,
      resources: { capacity_preflight: { available_bytes: 1 } },
      extraction: {
        slv_scan: command(variant, 'slv-scan'),
        deno_scan: command(variant, 'deno-scan'),
        vendor_scan: command(variant, 'vendor-scan'),
        slv: command(variant, 'slv'),
        deno: command(variant, 'deno'),
        vendor: command(variant, 'vendor'),
      },
      recipe_sha256: recipeSha256,
      patch_sha256: patchSha256,
      derived_relink_cargo_lock_sha256: derived,
      transport: {
        manifest: 'transport/manifest.json',
        manifest_sha256: manifestSha256,
      },
      entries,
      checks: variant === 'baseline'
        ? {
          baseline_build: primary,
          slv_compile: {
            passed: true,
            command: command(variant, 'slv-compile'),
            bridge_compile: command(variant, 'bridge-compile'),
          },
        }
        : {
          patch: {
            passed: true,
            before_sha256: fixtureSha256('before'),
            after_sha256: fixtureSha256('after'),
            command: command(variant, 'patch'),
          },
          modified_build: primary,
        },
      timing: {
        started_at: '2026-10-14T00:00:00Z',
        finished_at: '2026-10-14T00:00:01Z',
      },
    }
    const receiptPath = `${materials}/variant-receipt.json`
    const receiptSha256 = await writeFixtureJson(receiptPath, receipt)
    return {
      materials,
      receiptPath,
      receiptSha256,
      producer: receipt.producer,
    }
  }
  const baseline = await makeRole('baseline')
  const modified = await makeRole('modified')
  const dependenciesPath = `${input}/variant-dependencies.json`
  await writeFixtureJson(dependenciesPath, {
    schema_version: 1,
    kind: 'slv-native-variant-dependencies',
    baseline: {
      receipt: baseline.receiptPath,
      materials: baseline.materials,
      receipt_sha256: baseline.receiptSha256,
      artifact_id: '100',
      artifact_digest: fixtureSha256('baseline artifact'),
      producer: baseline.producer,
    },
    modified: {
      receipt: modified.receiptPath,
      materials: modified.materials,
      receipt_sha256: modified.receiptSha256,
      artifact_id: '101',
      artifact_digest: fixtureSha256('modified artifact'),
      producer: modified.producer,
    },
  })
  const producerContextPath = `${input}/join-producer-context.json`
  await writeFixtureJson(producerContextPath, producerContext)
  const out = `${root}/joined`
  return {
    root,
    target,
    out,
    dependenciesPath,
    baselineMaterials: baseline.materials,
    modifiedMaterials: modified.materials,
    baselineReceipt: baseline.receiptPath,
    modifiedReceipt: modified.receiptPath,
    sourceReceipt,
    notice,
    pins,
    slvSource,
    denoSource,
    cargoVendor,
    producerContext,
    args: {
      '--phase': 'join-build',
      '--target': target,
      '--out': out,
      '--work-dir': `${root}/join-work`,
      '--source-root': `${root}/join-source`,
      '--pins': pins,
      '--source-receipt': sourceReceipt,
      '--slv-source': slvSource,
      '--deno-source': denoSource,
      '--cargo-vendor': cargoVendor,
      '--notice-file': notice,
      '--producer-context': producerContextPath,
      '--variant-dependencies': dependenciesPath,
      // The workflow supplies common args to all phases. Join intentionally
      // ignores this caller value and validates both producer hosts instead.
      '--build-host': target,
    },
  }
}

function joinFixtureInputs(fixture: NativeJoinFixture): Record<string, string> {
  return {
    '--target': fixture.target,
    '--pins': fixture.pins,
    '--source-receipt': fixture.sourceReceipt,
    '--slv-source': fixture.slvSource,
    '--deno-source': fixture.denoSource,
    '--cargo-vendor': fixture.cargoVendor,
    '--notice-file': fixture.notice,
  }
}

Deno.test('join-build production entrypoint preserves raw variants and passes merge proof validation', async () => {
  const root = await Deno.makeTempDir({ prefix: 'slv-native-join-real-' })
  try {
    const fixture = await createNativeJoinFixture(root)
    await verifyNative(fixture.args)
    const buildPath = `${fixture.out}/build-receipt.json`
    const build = JSON.parse(await Deno.readTextFile(buildPath)) as Record<
      string,
      unknown
    >
    const transport = build.transport as Record<string, unknown>
    const manifest = JSON.parse(
      await Deno.readTextFile(`${fixture.out}/${transport.manifest}`),
    ) as Record<string, unknown>
    const entries = manifest.entries as Record<string, unknown>
    requireFixture(
      Object.keys(entries).length === 14,
      'join did not emit the complete 14-entry transport',
    )
    const resources = build.resources as Record<string, unknown>
    requireFixture(
      JSON.stringify(resources) ===
        JSON.stringify({ capacity_preflight: { available_bytes: 1 } }),
      'join nested producer resources instead of preserving capacity_preflight',
    )
    const artifacts = build.artifacts as Record<string, Record<string, string>>
    requireFixture(
      ((build.checks as Record<string, Record<string, unknown>>).baseline_build
        .runtime_abi as Record<string, string>).denort_sha256 ===
        artifacts.baseline.denort_sha256,
      'joined baseline ABI differs from joined baseline artifact',
    )
    requireFixture(
      artifacts.baseline.denort_sha256 ===
        ((entries['baseline-denort'] as Record<string, string>).sha256),
      'combined product artifact did not retain the baseline denort',
    )
    requireFixture(
      !Object.values(artifacts.baseline).includes(
        (entries['modified-denort'] as Record<string, string>).sha256,
      ),
      'combined product artifact included a modified runtime',
    )
    const split = build.split_build as Record<string, Record<string, string>>
    requireFixture(
      atob(split.baseline.receipt_bytes_base64) ===
          await Deno.readTextFile(fixture.baselineReceipt) &&
        atob(split.modified.receipt_bytes_base64) ===
          await Deno.readTextFile(fixture.modifiedReceipt),
      'join did not retain exact producer receipt bytes',
    )
    const executionPath = `${root}/execution-receipt.json`
    const command = {
      command: ['fixture'],
      cwd: `${root}/execution`,
      started_at: '2026-10-14T00:00:00Z',
      finished_at: '2026-10-14T00:00:01Z',
      exit_code: 0,
      log: `${root}/execution.log`,
      log_sha256: fixtureSha256('execution'),
    }
    const execution = {
      schema_version: 1,
      kind: 'slv-source-execution-receipt',
      target: fixture.target,
      build_mode: build.build_mode,
      build_receipt_sha256: await fixtureFileSha256(buildPath),
      execution_host: { os: 'darwin', arch: 'x64' },
      execution_toolchain: {
        pins_sha256: (build.toolchain as Record<string, string>).pins_sha256,
        identities: (build.toolchain as Record<string, unknown>).identities,
      },
      host_python: { path: '/usr/bin/python3', version: '3.11.0' },
      artifacts,
      checks: {
        baseline_probe: {
          passed: true,
          sentinel: { input: 0.125, output: 0.124, command },
          control: { input: 0.126, output: 0.125, command },
        },
        modified_probe: {
          passed: true,
          sentinel: { input: 0.125, output: 0.5, command },
          control: { input: 0.126, output: 0.125, command },
        },
        slv_version: { passed: true, command },
        licenses: {
          passed: true,
          command,
          canonical_notice_sha256: await fixtureFileSha256(fixture.notice),
        },
        slv_help: { passed: true, command },
        release_bridge: {
          passed: true,
          compile: (build.checks as Record<string, Record<string, unknown>>)
            .slv_compile.bridge_compile,
          command,
        },
      },
    }
    await writeFixtureJson(executionPath, execution)
    const mergeOut = `${root}/merge-out`
    await Deno.mkdir(mergeOut)
    await verifyNative({
      '--phase': 'merge',
      ...joinFixtureInputs(fixture),
      '--out': mergeOut,
      '--work-dir': `${root}/merge-work`,
      '--source-root': `${root}/merge-source`,
      '--build-receipt': buildPath,
      '--execution-receipt': executionPath,
    })
    verifyNativeSourceRebuildProof(
      JSON.parse(await Deno.readTextFile(`${mergeOut}/native-proof.json`)),
    )
  } finally {
    await Deno.remove(root, { recursive: true })
  }
})

for (const jobs of ['2', '16']) {
  Deno.test(`join-build production entrypoint preserves Linux x86_64 native split receipts with jobs ${jobs}`, async () => {
    const root = await Deno.makeTempDir({ prefix: 'slv-native-join-linux-' })
    try {
      const fixture = await createNativeJoinFixture(
        root,
        'x86_64-unknown-linux-gnu',
        jobs,
      )
      await verifyNative(fixture.args)
      const build = JSON.parse(
        await Deno.readTextFile(`${fixture.out}/build-receipt.json`),
      ) as Record<string, unknown>
      const split = build.split_build as Record<
        string,
        Record<string, Record<string, unknown>>
      >
      const baseline = split.baseline.receipt
      const modified = split.modified.receipt
      requireFixture(
        build.jobs === jobs && build.build_mode === 'native' &&
          JSON.stringify(build.build_host) ===
            JSON.stringify({ os: 'linux', arch: 'x64' }) &&
          baseline.jobs === jobs && modified.jobs === jobs &&
          (baseline.producer as Record<string, unknown>).job_id ===
            'source-linux-x64-baseline' &&
          (modified.producer as Record<string, unknown>).job_id ===
            'source-linux-x64-modified',
        `Linux split receipts did not retain native host, producer, and jobs ${jobs}`,
      )
      const sourceReceipt = JSON.parse(
        await Deno.readTextFile(fixture.sourceReceipt),
      ) as Record<string, unknown>
      const manifest = JSON.parse(
        await Deno.readTextFile(`${fixture.out}/transport/manifest.json`),
      ) as Record<string, Record<string, unknown>>
      const inputs = {
        assembly: sourceReceipt,
        assemblyReceiptSha256: await fixtureFileSha256(fixture.sourceReceipt),
        pinsSha256: await fixtureFileSha256(fixture.pins),
        noticeSha256: await fixtureFileSha256(fixture.notice),
        sourceAssets: (sourceReceipt.assets as Array<Record<string, unknown>>)
          .map(
            ({ name, sha256, size }) => ({ name, sha256, size }),
          ),
      }
      await verifySplitBuildEvidence(
        build.split_build,
        build,
        inputs as never,
        fixture.target,
        build.artifacts as never,
        manifest.entries as never,
      )
      const changedCombinedJobs = structuredClone(build)
      changedCombinedJobs.jobs = '4'
      await expectLayoutRejection(
        () =>
          verifySplitBuildEvidence(
            changedCombinedJobs.split_build,
            changedCombinedJobs,
            inputs as never,
            fixture.target,
            changedCombinedJobs.artifacts as never,
            manifest.entries as never,
          ),
        'producer jobs',
      )
    } finally {
      await Deno.remove(root, { recursive: true })
    }
  })
}

Deno.test('join-build rejects Linux x86_64 split receipts with changed jobs, producer, host, or mode', async () => {
  const root = await Deno.makeTempDir({
    prefix: 'slv-native-join-linux-negative-',
  })
  try {
    const caseFixture = async (
      name: string,
      mutate: (fixture: NativeJoinFixture) => Promise<void>,
    ) => {
      const fixture = await createNativeJoinFixture(
        `${root}/${name}`,
        'x86_64-unknown-linux-gnu',
      )
      await mutate(fixture)
      await expectJoinFixtureRejection(fixture)
    }
    await caseFixture(
      'changed-baseline-jobs',
      (fixture) =>
        rewriteFixtureRole(fixture, 'baseline', (receipt) => {
          receipt.jobs = '4'
        }),
    )
    await caseFixture(
      'mismatched-variant-jobs',
      (fixture) =>
        rewriteFixtureRole(fixture, 'modified', (receipt) => {
          receipt.jobs = '4'
        }),
    )
    for (const jobs of ['0', '3', '17', '32', '016', '16.0', 16, null]) {
      await caseFixture(
        `invalid-jobs-${JSON.stringify(jobs)}`,
        async (fixture) => {
          for (const variant of ['baseline', 'modified'] as const) {
            await rewriteFixtureRole(fixture, variant, (receipt) => {
              receipt.jobs = jobs
            })
          }
        },
      )
    }
    await caseFixture('wrong-producer-job', async (fixture) => {
      await rewriteFixtureRole(fixture, 'baseline', (receipt) => {
        ;(receipt.producer as Record<string, unknown>).job_id =
          'source-linux-x64-wrong'
      })
      const dependencies = JSON.parse(
        await Deno.readTextFile(fixture.dependenciesPath),
      ) as Record<string, Record<string, unknown>>
      dependencies.baseline.producer = (
        JSON.parse(await Deno.readTextFile(fixture.baselineReceipt)) as Record<
          string,
          unknown
        >
      ).producer
      await writeFixtureJson(fixture.dependenciesPath, dependencies)
    })
    await caseFixture(
      'wrong-build-host',
      (fixture) =>
        rewriteFixtureRole(fixture, 'modified', (receipt) => {
          receipt.build_host = { os: 'darwin', arch: 'x64' }
        }),
    )
    await caseFixture(
      'wrong-build-mode',
      (fixture) =>
        rewriteFixtureRole(fixture, 'modified', (receipt) => {
          receipt.build_mode = 'cross'
        }),
    )
  } finally {
    await Deno.remove(root, { recursive: true })
  }
})

async function rewriteFixtureRole(
  fixture: NativeJoinFixture,
  variant: 'baseline' | 'modified',
  mutate: (receipt: Record<string, unknown>) => void,
  syncDependency = true,
): Promise<void> {
  const receiptPath = variant === 'baseline'
    ? fixture.baselineReceipt
    : fixture.modifiedReceipt
  const receipt = JSON.parse(await Deno.readTextFile(receiptPath)) as Record<
    string,
    unknown
  >
  mutate(receipt)
  const digest = await writeFixtureJson(receiptPath, receipt)
  if (!syncDependency) return
  const dependencies = JSON.parse(
    await Deno.readTextFile(fixture.dependenciesPath),
  ) as Record<string, Record<string, unknown>>
  dependencies[variant].receipt_sha256 = digest
  await writeFixtureJson(fixture.dependenciesPath, dependencies)
}

async function expectJoinFixtureRejection(
  fixture: NativeJoinFixture,
): Promise<void> {
  let rejected = false
  try {
    await verifyNative(fixture.args)
  } catch {
    rejected = true
  }
  requireFixture(rejected, 'tampered join fixture was accepted')
  const receipt = await Deno.lstat(`${fixture.out}/build-receipt.json`).catch(
    () => undefined,
  )
  requireFixture(
    !receipt,
    'rejected join fixture emitted a final build receipt',
  )
}

Deno.test('join-build production entrypoint fails closed for split source, sidecar, and payload tampering', async () => {
  const root = await Deno.makeTempDir({ prefix: 'slv-native-join-negative-' })
  try {
    const caseFixture = async (
      name: string,
      mutate: (fixture: NativeJoinFixture) => Promise<void>,
    ) => {
      const fixture = await createNativeJoinFixture(`${root}/${name}`)
      await mutate(fixture)
      await expectJoinFixtureRejection(fixture)
    }
    await caseFixture('swapped-role', async (fixture) => {
      const dependencies = JSON.parse(
        await Deno.readTextFile(fixture.dependenciesPath),
      ) as Record<string, unknown>
      const baseline = dependencies.baseline
      dependencies.baseline = dependencies.modified
      dependencies.modified = baseline
      await writeFixtureJson(fixture.dependenciesPath, dependencies)
    })
    await caseFixture('two-baselines', async (fixture) => {
      const dependencies = JSON.parse(
        await Deno.readTextFile(fixture.dependenciesPath),
      ) as Record<string, Record<string, unknown>>
      dependencies.modified.producer = dependencies.baseline.producer
      await writeFixtureJson(fixture.dependenciesPath, dependencies)
    })
    await caseFixture('missing-producer', async (fixture) => {
      const dependencies = JSON.parse(
        await Deno.readTextFile(fixture.dependenciesPath),
      ) as Record<string, Record<string, unknown>>
      delete dependencies.modified.producer
      await writeFixtureJson(fixture.dependenciesPath, dependencies)
    })
    await caseFixture('duplicate-artifact', async (fixture) => {
      const dependencies = JSON.parse(
        await Deno.readTextFile(fixture.dependenciesPath),
      ) as Record<string, Record<string, unknown>>
      dependencies.modified.artifact_id = dependencies.baseline.artifact_id
      await writeFixtureJson(fixture.dependenciesPath, dependencies)
    })
    for (const field of ['repository', 'workflow', 'run_id'] as const) {
      await caseFixture(
        `producer-${field}`,
        (fixture) =>
          rewriteFixtureRole(fixture, 'baseline', (receipt) => {
            const producer = receipt.producer as Record<string, string>
            producer[field] = field === 'run_id' ? '43' : `wrong-${field}`
          }),
      )
    }
    await caseFixture('future-attempt', async (fixture) => {
      await rewriteFixtureRole(fixture, 'baseline', (receipt) => {
        ;(receipt.producer as Record<string, string>).run_attempt = '4'
      })
      const dependencies = JSON.parse(
        await Deno.readTextFile(fixture.dependenciesPath),
      ) as Record<string, Record<string, unknown>>
      const producer =
        (JSON.parse(await Deno.readTextFile(fixture.baselineReceipt)) as Record<
          string,
          unknown
        >).producer
      dependencies.baseline.producer = producer
      await writeFixtureJson(fixture.dependenciesPath, dependencies)
    })
    for (
      const [name, mutate] of [
        [
          'source',
          (receipt: Record<string, unknown>) =>
            receipt.source_commit = 'f'.repeat(40),
        ],
        [
          'target',
          (receipt: Record<string, unknown>) =>
            receipt.target = 'aarch64-unknown-linux-gnu',
        ],
        [
          'mode',
          (receipt: Record<string, unknown>) => receipt.build_mode = 'cross',
        ],
        ['jobs', (receipt: Record<string, unknown>) => receipt.jobs = '3'],
        [
          'notice',
          (receipt: Record<string, unknown>) =>
            receipt.notice_sha256 = fixtureSha256('wrong notice'),
        ],
        [
          'global-pins',
          (receipt: Record<string, unknown>) =>
            (receipt.toolchain as Record<string, unknown>).pins_sha256 =
              fixtureSha256('wrong global pins'),
        ],
        [
          'source-pin',
          (receipt: Record<string, unknown>) =>
            receipt.source_pin_sha256 = fixtureSha256('wrong source pins'),
        ],
        [
          'selected-lock',
          (receipt: Record<string, unknown>) =>
            receipt.source_selected_cargo_lock_sha256 = fixtureSha256(
              'wrong selected lock',
            ),
        ],
        [
          'recipe',
          (receipt: Record<string, unknown>) =>
            receipt.recipe_sha256 = fixtureSha256('wrong recipe'),
        ],
        [
          'patch',
          (receipt: Record<string, unknown>) =>
            receipt.patch_sha256 = fixtureSha256('wrong patch'),
        ],
        [
          'derived-lock',
          (receipt: Record<string, unknown>) =>
            receipt.derived_relink_cargo_lock_sha256 = fixtureSha256(
              'wrong derived lock',
            ),
        ],
        [
          'tool-pin',
          (receipt: Record<string, unknown>) =>
            receipt.tool_pin_sha256 = fixtureSha256('wrong descriptor'),
        ],
      ] as const
    ) {
      await caseFixture(
        name,
        (fixture) => rewriteFixtureRole(fixture, 'baseline', mutate),
      )
    }
    await caseFixture(
      'host',
      (fixture) =>
        rewriteFixtureRole(fixture, 'baseline', (receipt) => {
          receipt.build_host = { os: 'linux', arch: 'x64' }
        }),
    )
    await caseFixture(
      'source-assets',
      (fixture) =>
        rewriteFixtureRole(fixture, 'baseline', (receipt) => {
          const assets = receipt.source_assets as Array<Record<string, unknown>>
          assets[0].sha256 = fixtureSha256('wrong asset')
        }),
    )
    await caseFixture(
      'tool-identity',
      (fixture) =>
        rewriteFixtureRole(fixture, 'baseline', (receipt) => {
          const toolchain = receipt.toolchain as Record<
            string,
            Record<string, Record<string, string>>
          >
          toolchain.identities['fixture-tool'].sha256 = fixtureSha256(
            'wrong tool identity',
          )
        }),
    )
    await caseFixture(
      'tool-archive-members',
      (fixture) =>
        rewriteFixtureRole(fixture, 'modified', (receipt) => {
          const archives = receipt.tool_archives as Record<
            string,
            Record<string, unknown>
          >
          archives.fixture.included_members = ['wrong/member']
        }),
    )
    await caseFixture(
      'tool-identity-key',
      (fixture) =>
        rewriteFixtureRole(fixture, 'baseline', (receipt) => {
          const toolchain = receipt.toolchain as Record<
            string,
            Record<string, Record<string, string>>
          >
          toolchain.identities['unexpected-tool'] =
            toolchain.identities['fixture-tool']
          delete toolchain.identities['fixture-tool']
        }),
    )
    await caseFixture(
      'fingerprint',
      (fixture) =>
        rewriteFixtureRole(fixture, 'baseline', (receipt) => {
          const checks = receipt.checks as Record<
            string,
            Record<string, unknown>
          >
          const fingerprint = checks.baseline_build
            .cargo_fingerprints as Record<string, Array<Record<string, string>>>
          fingerprint.records[0].sha256 = fixtureSha256('wrong fingerprint')
        }),
    )
    await caseFixture(
      'baseline-build-missing',
      (fixture) =>
        rewriteFixtureRole(fixture, 'baseline', (receipt) => {
          delete (receipt.checks as Record<string, unknown>).baseline_build
        }),
    )
    await caseFixture(
      'modified-build-missing',
      (fixture) =>
        rewriteFixtureRole(fixture, 'modified', (receipt) => {
          delete (receipt.checks as Record<string, unknown>).modified_build
        }),
    )
    await caseFixture(
      'slv-compile-missing',
      (fixture) =>
        rewriteFixtureRole(fixture, 'baseline', (receipt) => {
          delete (receipt.checks as Record<string, unknown>).slv_compile
        }),
    )
    await caseFixture(
      'patch-missing',
      (fixture) =>
        rewriteFixtureRole(fixture, 'modified', (receipt) => {
          delete (receipt.checks as Record<string, unknown>).patch
        }),
    )
    await caseFixture(
      'baseline-build-failed',
      (fixture) =>
        rewriteFixtureRole(fixture, 'baseline', (receipt) => {
          const checks = receipt.checks as Record<
            string,
            Record<string, unknown>
          >
          checks.baseline_build.passed = false
        }),
    )
    await caseFixture(
      'modified-build-command-failed',
      (fixture) =>
        rewriteFixtureRole(fixture, 'modified', (receipt) => {
          const checks = receipt.checks as Record<
            string,
            Record<string, unknown>
          >
          const command = checks.modified_build.command as Record<
            string,
            unknown
          >
          command.exit_code = 1
        }),
    )
    await caseFixture(
      'slv-compile-failed',
      (fixture) =>
        rewriteFixtureRole(fixture, 'baseline', (receipt) => {
          const checks = receipt.checks as Record<
            string,
            Record<string, unknown>
          >
          checks.slv_compile.passed = false
        }),
    )
    await caseFixture(
      'patch-command-failed',
      (fixture) =>
        rewriteFixtureRole(fixture, 'modified', (receipt) => {
          const checks = receipt.checks as Record<
            string,
            Record<string, unknown>
          >
          const command = checks.patch.command as Record<string, unknown>
          command.exit_code = 1
        }),
    )
    await caseFixture('raw-receipt', (fixture) =>
      rewriteFixtureRole(
        fixture,
        'baseline',
        (receipt) =>
          receipt.notice_sha256 = fixtureSha256('raw receipt mismatch'),
        false,
      ))
    await caseFixture('descriptor-bytes', async (fixture) => {
      await Deno.writeTextFile(
        `${fixture.baselineMaterials}/tool-pin.json`,
        '{}\n',
      )
    })
    await caseFixture('global-pin-as-target-descriptor', async (fixture) => {
      await Deno.copyFile(
        fixture.pins,
        `${fixture.baselineMaterials}/tool-pin.json`,
      )
    })
    await caseFixture('tools-sidecar-bytes', async (fixture) => {
      await Deno.writeTextFile(
        `${fixture.baselineMaterials}/build-tools-receipt.json`,
        '{}\n',
      )
    })
    await caseFixture('extra-payload', async (fixture) => {
      await writeFixtureFile(
        `${fixture.baselineMaterials}/transport/unexpected`,
        'unexpected\n',
      )
    })
    await caseFixture('missing-payload', async (fixture) => {
      await Deno.remove(
        `${fixture.baselineMaterials}/transport/baseline-denort`,
      )
    })
    await caseFixture('symlink-payload', async (fixture) => {
      const payload = `${fixture.baselineMaterials}/transport/baseline-denort`
      await Deno.remove(payload)
      await Deno.symlink('../variant-receipt.json', payload)
    })
    await caseFixture(
      'traversal-payload',
      (fixture) =>
        rewriteFixtureRole(fixture, 'baseline', (receipt) => {
          const entries = receipt.entries as Record<
            string,
            Record<string, string>
          >
          entries['baseline-denort'].path = '../escaped'
        }),
    )
    await caseFixture('payload-bytes', async (fixture) => {
      await Deno.writeTextFile(
        `${fixture.baselineMaterials}/transport/baseline-denort`,
        'changed bytes\n',
      )
    })
    await caseFixture(
      'payload-size',
      (fixture) =>
        rewriteFixtureRole(fixture, 'baseline', (receipt) => {
          const entries = receipt.entries as Record<
            string,
            Record<string, number>
          >
          entries['baseline-denort'].size += 1
        }),
    )
    await caseFixture(
      'manifest-digest',
      (fixture) =>
        rewriteFixtureRole(fixture, 'baseline', (receipt) => {
          const transport = receipt.transport as Record<string, string>
          transport.manifest_sha256 = fixtureSha256('wrong manifest')
        }),
    )
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

async function fixtureElf(path: string, machine: number): Promise<void> {
  const header = new Uint8Array(64)
  header.set([0x7f, 0x45, 0x4c, 0x46, 2, 1], 0)
  header[18] = machine & 0xff
  header[19] = machine >> 8
  await Deno.mkdir(path.slice(0, path.lastIndexOf('/')), { recursive: true })
  await Deno.writeFile(path, header)
}

async function armObservationFixture(
  root: string,
  evidence: string,
): Promise<Awaited<ReturnType<typeof captureCargoFingerprintCollection>>> {
  const target = 'aarch64-unknown-linux-gnu'
  await Deno.mkdir(evidence, { recursive: true })
  const dep = (
    context: 'host' | 'target',
    crate: string,
    name: string,
    features: string,
  ) =>
    JSON.stringify({
      // Cargo fingerprints retain the feature list as a JSON-encoded string.
      features,
      deps: [[
        '18446744073709551615',
        'build_script_build',
        false,
        '18446744073709551614',
      ]],
      local: [{
        CheckDepInfo: {
          dep_info: context === 'host'
            ? `release/.fingerprint/${crate}/dep-${name}`
            : `${target}/release/.fingerprint/${crate}/dep-${name}`,
        },
      }],
    }) + '\n'
  const run = (context: 'host' | 'target', crate: string) =>
    JSON.stringify({
      // An empty string means this run record did not declare compiled features.
      features: '',
      deps: [[
        '18446744073709551615',
        'build_script_build',
        false,
        '18446744073709551613',
      ]],
      local: [
        { RerunIfEnvChanged: { var: 'GN_ARGS' } },
        {
          RerunIfChanged: {
            output: context === 'host'
              ? `release/build/${crate}/output`
              : `${target}/release/build/${crate}/output`,
          },
        },
        { RerunIfEnvChanged: { var: 'EXTRA_GN_ARGS' } },
      ],
    }) + '\n'
  const records = [
    [
      `${root}/target/release/.fingerprint/deno_snapshots-a781e5da6343f794`,
      'build-script-build-script-build.json',
      dep(
        'host',
        'deno_snapshots-a781e5da6343f794',
        'build-script-build-script-build',
        '[]',
      ),
    ],
    [
      `${root}/target/release/.fingerprint/v8-0af051d50882f6ed`,
      'build-script-build-script-build.json',
      dep(
        'host',
        'v8-0af051d50882f6ed',
        'build-script-build-script-build',
        '["simdutf", "use_custom_libcxx"]',
      ),
    ],
    [
      `${root}/target/release/.fingerprint/v8-4cccfc92ccfabbc6`,
      'run-build-script-build-script-build.json',
      run('host', 'v8-4cccfc92ccfabbc6'),
    ],
    [
      `${root}/target/release/.fingerprint/v8-b7691ad1244b4ffd`,
      'lib-v8.json',
      dep(
        'host',
        'v8-b7691ad1244b4ffd',
        'lib-v8',
        '["simdutf", "use_custom_libcxx"]',
      ),
    ],
    [
      `${root}/target/${target}/release/.fingerprint/deno_snapshots-183e082d99e5c29e`,
      'run-build-script-build-script-build.json',
      run('target', 'deno_snapshots-183e082d99e5c29e'),
    ],
    [
      `${root}/target/${target}/release/.fingerprint/deno_snapshots-5640c557e2fca22c`,
      'lib-deno_snapshots.json',
      dep(
        'target',
        'deno_snapshots-5640c557e2fca22c',
        'lib-deno_snapshots',
        '[]',
      ),
    ],
    [
      `${root}/target/${target}/release/.fingerprint/v8-e2e053d7e4c51008`,
      'run-build-script-build-script-build.json',
      run('target', 'v8-e2e053d7e4c51008'),
    ],
    [
      `${root}/target/${target}/release/.fingerprint/v8-7af81a1066660ee4`,
      'lib-v8.json',
      dep(
        'target',
        'v8-7af81a1066660ee4',
        'lib-v8',
        '["simdutf", "use_custom_libcxx"]',
      ),
    ],
  ] as const
  for (const [directory, name, bytes] of records) {
    await Deno.mkdir(directory, { recursive: true })
    await Deno.writeTextFile(`${directory}/${name}`, bytes)
  }
  const out =
    `${root}/target/${target}/release/build/deno_snapshots-183e082d99e5c29e/out`
  await Deno.mkdir(`${out}/residual_sources`, { recursive: true })
  const snapshot = new Uint8Array(20)
  snapshot.set([1, 2, 3, 4], 0)
  new DataView(snapshot.buffer).setBigUint64(12, 4n, true)
  await Deno.writeFile(`${out}/CLI_SNAPSHOT.bin`, snapshot)
  await Deno.writeTextFile(
    `${out}/EXTENSION_RESIDUAL_SOURCES.rs`,
    'include_bytes!("residual_sources/mod.js");\n',
  )
  await Deno.writeTextFile(`${out}/residual_sources/mod.js`, 'export {};\n')
  await fixtureElf(
    `${root}/target/release/build/deno_snapshots-a781e5da6343f794/build-script-build`,
    62,
  )
  await fixtureElf(`${root}/target/${target}/release/denort`, 183)
  const defines =
    '-DV8_TARGET_ARCH_ARM64 -DV8_COMPRESS_POINTERS -DV8_ENABLE_SANDBOX -DV8_STATIC_ROOTS -DV8_STATIC_ROOTS_GENERATION -DV8_ENABLE_EXTENSIBLE_RO_SNAPSHOT'
  for (
    const [context, cpu, simulator] of [['host', 'x64', ' -DUSE_SIMULATOR'], [
      'consumer',
      'arm64',
      '',
    ]] as const
  ) {
    await Deno.writeTextFile(
      `${evidence}/${context}-args.gn`,
      `target_cpu = "${cpu}"\nv8_target_cpu = "arm64"\nv8_target_is_simulator = ""\n`,
    )
    await Deno.writeTextFile(
      `${evidence}/${context}-rusty_v8.ninja`,
      `defines = ${defines}${simulator}\n`,
    )
  }
  return await captureCargoFingerprintCollection(root, {
    phase: 'baseline',
    target,
    runtime_sha256: 'a'.repeat(64),
    derived_relink_cargo_lock_sha256: 'b'.repeat(64),
  })
}

Deno.test('ARM observation validates full Cargo roles and ELF/Ninja semantics without GN listing queries', async () => {
  const root = await Deno.makeTempDir({ prefix: 'slv-arm-observation-' })
  try {
    const evidence = `${root}/evidence`
    await Deno.mkdir(evidence)
    const fingerprints = await armObservationFixture(root, evidence)
    const observed = await captureArmObservation(
      root,
      'aarch64-unknown-linux-gnu',
      evidence,
      fingerprints,
    )
    requireFixture(
      observed?.status === 'complete',
      `valid simulator observation was ${observed?.status}`,
    )
    requireFixture(
      (observed?.host.cargo_records as unknown[] | undefined)?.length === 4 &&
        (observed?.consumer.cargo_records as unknown[] | undefined)?.length ===
          4,
      'full compiled/run/library Cargo role collection was not retained',
    )
    const hostRecords = observed?.host.cargo_records as Array<
      Record<string, unknown>
    >
    const hostCompile = hostRecords.find((record) =>
      record.path === 'v8-0af051d50882f6ed/build-script-build-script-build.json'
    )
    const hostRun = hostRecords.find((record) =>
      record.path ===
        'v8-4cccfc92ccfabbc6/run-build-script-build-script-build.json'
    )
    requireFixture(
      (hostCompile?.features as Record<string, unknown> | undefined)?.raw ===
          '["simdutf", "use_custom_libcxx"]' &&
        JSON.stringify(
            (hostCompile?.features as Record<string, unknown>)?.normalized,
          ) ===
          '["simdutf","use_custom_libcxx"]' &&
        (hostRun?.features as Record<string, unknown> | undefined)?.state ===
          'unavailable-by-run',
      'raw Cargo feature encodings were not preserved distinctly from normalized state',
    )
    const absentMacros = await armObservationFixture(
      `${root}/absent-macros-stage`,
      `${root}/absent-macros-evidence`,
    )
    await Deno.writeTextFile(
      `${root}/absent-macros-evidence/host-rusty_v8.ninja`,
      'defines = -DV8_TARGET_ARCH_ARM64 -DV8_ENABLE_EXTENSIBLE_RO_SNAPSHOT -DUSE_SIMULATOR\n',
    )
    await Deno.writeTextFile(
      `${root}/absent-macros-evidence/consumer-rusty_v8.ninja`,
      'defines = -DV8_TARGET_ARCH_ARM64 -DV8_ENABLE_EXTENSIBLE_RO_SNAPSHOT\n',
    )
    const absentObserved = await captureArmObservation(
      `${root}/absent-macros-stage`,
      'aarch64-unknown-linux-gnu',
      `${root}/absent-macros-evidence`,
      absentMacros,
    )
    requireFixture(
      absentObserved?.status === 'complete' &&
        JSON.stringify(
            (absentObserved.host.effective_semantics as Record<string, unknown>)
              .compiled_settings,
          ) ===
          '{"V8_COMPRESS_POINTERS":{"enabled":false,"raw_token":null},"V8_ENABLE_SANDBOX":{"enabled":false,"raw_token":null},"V8_STATIC_ROOTS":{"enabled":false,"raw_token":null},"V8_STATIC_ROOTS_GENERATION":{"enabled":false,"raw_token":null},"V8_ENABLE_EXTENSIBLE_RO_SNAPSHOT":{"enabled":true,"raw_token":"1"}}',
      'complete Ninja assignment did not represent absent optional macros as false',
    )
    await Deno.writeTextFile(
      `${root}/absent-macros-evidence/consumer-rusty_v8.ninja`,
      'defines = -DV8_TARGET_ARCH_ARM64 -DV8_ENABLE_EXTENSIBLE_RO_SNAPSHOT -DV8_COMPRESS_POINTERS\n',
    )
    requireFixture(
      (await captureArmObservation(
        `${root}/absent-macros-stage`,
        'aarch64-unknown-linux-gnu',
        `${root}/absent-macros-evidence`,
        absentMacros,
      ))?.status === 'configuration-mismatch',
      'host and consumer optional macro disagreement was accepted',
    )
    requireFixture(
      !(await Deno.stat(`${evidence}/snapshot-bundle`).catch((error) =>
        error instanceof Deno.errors.NotFound
          ? undefined
          : Promise.reject(error)
      )),
      'observation retained a duplicate raw snapshot bundle',
    )
    requireFixture(
      (observed.snapshot_bundle.members as unknown[]).length === 3,
      'snapshot inventory did not retain exact bundle members',
    )
    const largeHost =
      `${root}/target/release/build/deno_snapshots-a781e5da6343f794/build-script-build`
    const largeHandle = await Deno.open(largeHost, { write: true })
    await largeHandle.truncate(33 * 1024 * 1024)
    largeHandle.close()
    requireFixture(
      (await captureArmObservation(
        root,
        'aarch64-unknown-linux-gnu',
        evidence,
        fingerprints,
      ))?.status === 'complete',
      'large executable identity was incorrectly limited as a snapshot member',
    )
    await Deno.writeTextFile(
      `${root}/target/aarch64-unknown-linux-gnu/release/build/deno_snapshots-183e082d99e5c29e/out/residual_sources/unreferenced.js`,
      'extra\n',
    )
    requireFixture(
      (await captureArmObservation(
        root,
        'aarch64-unknown-linux-gnu',
        evidence,
        fingerprints,
      ))?.status === 'incomplete',
      'unreferenced snapshot member was accepted',
    )
    const negative = `${root}/negative`
    await Deno.mkdir(negative)
    const negativeFingerprints = await armObservationFixture(
      `${root}/negative-stage`,
      negative,
    )
    await Deno.writeTextFile(
      `${negative}/host-rusty_v8.ninja`,
      `defines = -DV8_TARGET_ARCH_ARM64\n`,
    )
    const rejected = await captureArmObservation(
      `${root}/negative-stage`,
      'aarch64-unknown-linux-gnu',
      negative,
      negativeFingerprints,
    )
    requireFixture(
      rejected?.status === 'configuration-mismatch',
      'wrong actual simulator define was accepted from requested GN settings',
    )
    await Deno.writeTextFile(
      `${negative}/host-rusty_v8.ninja`,
      'defines = -DV8_TARGET_ARCH_ARM64 -DV8_COMPRESS_POINTERS -DV8_ENABLE_SANDBOX -DV8_STATIC_ROOTS -DV8_STATIC_ROOTS_GENERATION -DV8_ENABLE_EXTENSIBLE_RO_SNAPSHOT -DUSE_SIMULATOR\n',
    )
    await Deno.writeTextFile(
      `${negative}/consumer-rusty_v8.ninja`,
      'defines = -DV8_TARGET_ARCH_ARM64 $\n  -DUSE_SIMULATOR\n',
    )
    requireFixture(
      (await captureArmObservation(
        `${root}/negative-stage`,
        'aarch64-unknown-linux-gnu',
        negative,
        negativeFingerprints,
      ))?.status === 'incomplete',
      'continued Ninja defines assignment was treated as complete',
    )
    const competing = await armObservationFixture(
      `${root}/competing-stage`,
      `${root}/competing-evidence`,
    )
    competing.records.push({
      ...competing.records.find((record) =>
        record.context === 'target-release' && /lib-v8\.json$/.test(record.path)
      )!,
    })
    requireFixture(
      (await captureArmObservation(
        `${root}/competing-stage`,
        'aarch64-unknown-linux-gnu',
        `${root}/competing-evidence`,
        competing,
      ))?.status === 'incomplete',
      'competing V8 library role was accepted',
    )
  } finally {
    await Deno.remove(root, { recursive: true })
  }
})

Deno.test('ARM observation admits only the captured consumer duplicate literal use_sysroot declarations', async () => {
  const root = await Deno.makeTempDir({ prefix: 'slv-arm-captured-args-' })
  const capturedHostArgs = `is_debug = false
use_custom_libcxx = true
v8_enable_sandbox = false
v8_enable_pointer_compression = false
v8_enable_v8_checks = false
rusty_v8_enable_simdutf = true
clang_base_path = "/home/runner/work/_temp/source-tools/build/clang"
treat_warnings_as_errors = false
use_glib = false
use_sysroot = true
v8_target_cpu = "arm64"
v8_monolithic_for_shared_library = true
use_lld = true
`
  const capturedConsumerArgs = `is_debug = false
use_custom_libcxx = true
v8_enable_sandbox = false
v8_enable_pointer_compression = false
v8_enable_v8_checks = false
rusty_v8_enable_simdutf = true
clang_base_path = "/home/runner/work/_temp/source-tools/build/clang"
treat_warnings_as_errors = false
use_glib = false
use_sysroot = true
v8_target_cpu = "arm64"
v8_monolithic_for_shared_library = true
target_cpu = "arm64"
use_sysroot = true
use_lld = true
`
  try {
    requireFixture(
      fixtureSha256(capturedHostArgs) ===
          '0cb4671b306c481787792790e0765f9b75f3c9d849201b61ea03f486ce0c1467' &&
        fixtureSha256(capturedConsumerArgs) ===
          '2f552c228ed1d4d5a844cceb4183ea186007e4be33b76f2d986a46179fe46952',
      'captured ARM argument fixtures no longer match the original raw hashes',
    )
    const capture = async (
      name: string,
      hostArgs = capturedHostArgs,
      consumerArgs = capturedConsumerArgs,
    ) => {
      const stage = `${root}/${name}-stage`
      const evidence = `${root}/${name}-evidence`
      const fingerprints = await armObservationFixture(stage, evidence)
      await Deno.writeTextFile(`${evidence}/host-args.gn`, hostArgs)
      await Deno.writeTextFile(`${evidence}/consumer-args.gn`, consumerArgs)
      const before = await Promise.all([
        fixtureFileSha256(`${evidence}/host-args.gn`),
        fixtureFileSha256(`${evidence}/consumer-args.gn`),
      ])
      const observed = await captureArmObservation(
        stage,
        'aarch64-unknown-linux-gnu',
        evidence,
        fingerprints,
      )
      const after = await Promise.all([
        fixtureFileSha256(`${evidence}/host-args.gn`),
        fixtureFileSha256(`${evidence}/consumer-args.gn`),
      ])
      requireFixture(
        JSON.stringify(before) === JSON.stringify(after),
        `${name} observation changed captured raw arguments`,
      )
      return observed?.status
    }
    for (const variant of ['baseline', 'modified']) {
      requireFixture(
        await capture(variant) === 'complete',
        `${variant} captured consumer duplicate literal true was not accepted`,
      )
    }
    const uniqueConsumer = capturedConsumerArgs.replace(
      'target_cpu = "arm64"\nuse_sysroot = true\n',
      'target_cpu = "arm64"\n',
    )
    requireFixture(
      await capture('unique', capturedHostArgs, uniqueConsumer) === 'complete',
      'ordinary unique use_sysroot declaration was rejected',
    )
    const rejected = async (
      name: string,
      hostArgs = capturedHostArgs,
      consumerArgs = capturedConsumerArgs,
    ) => {
      requireFixture(
        await capture(name, hostArgs, consumerArgs) === 'incomplete',
        `${name} invalid declaration was accepted`,
      )
    }
    await rejected(
      'true-false',
      capturedHostArgs,
      capturedConsumerArgs.replace(
        'target_cpu = "arm64"\nuse_sysroot = true\n',
        'target_cpu = "arm64"\nuse_sysroot = false\n',
      ),
    )
    await rejected(
      'false-true',
      capturedHostArgs,
      capturedConsumerArgs.replace(
        'use_sysroot = true\nv8_target_cpu',
        'use_sysroot = false\nv8_target_cpu',
      ),
    )
    await rejected(
      'expression',
      capturedHostArgs,
      capturedConsumerArgs.replace(
        'target_cpu = "arm64"\nuse_sysroot = true\n',
        'target_cpu = "arm64"\nuse_sysroot = target_cpu == "arm64"\n',
      ),
    )
    await rejected(
      'extra-repeat',
      capturedHostArgs,
      `${capturedConsumerArgs}use_sysroot = true\n`,
    )
    await rejected(
      'other-key',
      capturedHostArgs,
      capturedConsumerArgs.replace(
        'use_lld = true\n',
        'use_lld = true\nuse_lld = true\n',
      ),
    )
    await rejected('host-context', `${capturedHostArgs}use_sysroot = true\n`)
  } finally {
    await Deno.remove(root, { recursive: true })
  }
})

Deno.test('ARM snapshot inventory uses one ASCII order across table, tree, and manifest', async () => {
  const root = await Deno.makeTempDir({ prefix: 'slv-arm-inventory-order-' })
  try {
    const target = 'aarch64-unknown-linux-gnu'
    const names = [
      'a.txt',
      'a/x.js',
      'ext_deno_node_http2_ts.js',
      'ext_deno_node_http_ts.js',
    ]
    const expected = [
      'CLI_SNAPSHOT.bin',
      'EXTENSION_RESIDUAL_SOURCES.rs',
      ...names.map((name) => `residual_sources/${name}`),
    ]
    const capture = async (label: string, insertion: string[]) => {
      const stage = `${root}/${label}-stage`
      const evidence = `${root}/${label}-evidence`
      const fingerprints = await armObservationFixture(stage, evidence)
      const out =
        `${stage}/target/${target}/release/build/deno_snapshots-183e082d99e5c29e/out`
      await Deno.remove(`${out}/residual_sources/mod.js`)
      for (const name of insertion) {
        const path = `${out}/residual_sources/${name}`
        await Deno.mkdir(path.slice(0, path.lastIndexOf('/')), {
          recursive: true,
        })
        await Deno.writeTextFile(path, `fixture:${name}\n`)
      }
      await Deno.writeTextFile(
        `${out}/EXTENSION_RESIDUAL_SOURCES.rs`,
        names.map((name) =>
          `include_str!(concat!(env!("OUT_DIR"), "/residual_sources/${name}"));`
        ).join('\n') + '\n',
      )
      const observed = await captureArmObservation(
        stage,
        target,
        evidence,
        fingerprints,
      )
      const manifest = await Deno.readFile(
        `${evidence}/snapshot-bundle-manifest.json`,
      )
      return { observed, manifest }
    }
    const forward = await capture('forward', names)
    const reverse = await capture('reverse', [...names].reverse())
    const forwardPaths = (forward.observed?.snapshot_bundle.members as Array<
      Record<string, unknown>
    >)
      .map((member) => member.path)
    requireFixture(
      forward.observed?.status === 'complete' &&
        JSON.stringify(forwardPaths) === JSON.stringify(expected) &&
        JSON.stringify(forward.manifest) === JSON.stringify(reverse.manifest),
      'table/tree/manifest inventory ordering is not stable ASCII full-path order',
    )
  } finally {
    await Deno.remove(root, { recursive: true })
  }
})

Deno.test('ARM observation rejects malformed raw Cargo feature encodings', async () => {
  const root = await Deno.makeTempDir({ prefix: 'slv-arm-feature-negative-' })
  try {
    const cases: Array<[string, unknown]> = [
      ['non-string', []],
      ['empty-compiled', ''],
      ['malformed-json', '["simdutf"'],
      ['duplicate-feature', '["simdutf","simdutf"]'],
      ['oversized-feature', JSON.stringify(['x'.repeat(257)])],
      ['missing-feature', undefined],
    ]
    for (const [name, rawFeature] of cases) {
      const stage = `${root}/${name}-stage`
      const evidence = `${root}/${name}-evidence`
      const fingerprints = await armObservationFixture(stage, evidence)
      const record = fingerprints.records.find((value) =>
        value.context === 'host-release' &&
        /v8-0af051d50882f6ed\/build-script-build-script-build\.json$/.test(
          value.path,
        )
      )!
      const data = JSON.parse(atob(record.content_base64))
      if (rawFeature === undefined) delete data.features
      else data.features = rawFeature
      record.content_base64 = btoa(JSON.stringify(data) + '\n')
      requireFixture(
        (await captureArmObservation(
          stage,
          'aarch64-unknown-linux-gnu',
          evidence,
          fingerprints,
        ))?.status === 'incomplete',
        `invalid ${name} Cargo feature value was accepted`,
      )
    }
  } finally {
    await Deno.remove(root, { recursive: true })
  }
})

Deno.test('ARM raw capture copies only generated files and never invokes GN', async () => {
  const root = await Deno.makeTempDir({ prefix: 'slv-arm-raw-capture-' })
  try {
    const evidence = `${root}/evidence`
    const host = `${root}/host`
    const consumer = `${root}/consumer`
    const marker = `${root}/unexpected-gn-query`
    for (const output of [host, consumer]) {
      await Deno.mkdir(`${output}/obj`, { recursive: true })
      await Deno.writeTextFile(`${output}/args.gn`, 'target_cpu = "arm64"\n')
      await Deno.writeTextFile(
        `${output}/obj/rusty_v8.ninja`,
        'defines = -DV8_TARGET_ARCH_ARM64\n',
      )
    }
    await Deno.mkdir(evidence)
    const fakeGn = `${root}/gn`
    await Deno.writeTextFile(
      fakeGn,
      `#!/usr/bin/env bash\ntouch ${marker}\nexit 99\n`,
    )
    await Deno.chmod(fakeGn, 0o755)
    const fragment = await recipeFragment(
      '# ARM_EVIDENCE_RAW_CAPTURE_BEGIN',
      '# ARM_EVIDENCE_RAW_CAPTURE_END',
    )
    const result = await new Deno.Command('/usr/bin/bash', {
      args: [
        '-euo',
        'pipefail',
        '-c',
        `${fragment}\ncapture_arm_raw_evidence "$1" "$2"`,
        '--',
        host,
        consumer,
      ],
      clearEnv: true,
      env: {
        BUILD_TARGET: 'aarch64-unknown-linux-gnu',
        GN: fakeGn,
        PYTHON: '/usr/bin/python3',
        evidence_out: evidence,
        PATH: '/usr/bin:/bin',
      },
      stdout: 'piped',
      stderr: 'piped',
    }).output()
    requireFixture(
      result.success &&
        JSON.parse(
            await Deno.readTextFile(evidence + '/raw-capture.json'),
          ).status === 'raw-capture-complete',
      'ARM raw capture did not retain valid generated-file evidence',
    )
    requireFixture(
      await Deno.stat(`${evidence}/host-args.gn`).then(() => true).catch(() =>
        false
      ) &&
        await Deno.stat(`${evidence}/consumer-rusty_v8.ninja`).then(() => true)
          .catch(() => false) &&
        !(await Deno.stat(marker).then(() => true).catch(() => false)) &&
        !(await Deno.stat(`${evidence}/host-gn-args-list.txt`).then(() => true)
          .catch(() => false)),
      'ARM raw capture queried GN or emitted a GN listing artifact',
    )
  } finally {
    await Deno.remove(root, { recursive: true })
  }
})

Deno.test('ARM state routine latches write failures and validates the full producer identity', async () => {
  const root = await Deno.makeTempDir({ prefix: 'slv-arm-state-lifetime-' })
  try {
    const fragment = await recipeFragment(
      '# ARM_OBSERVATION_STATE_BEGIN',
      '# ARM_OBSERVATION_STATE_END',
    )
    const valid = {
      source_commit: 'c'.repeat(40),
      source_receipt_sha256: 'd'.repeat(64),
      recipe_sha256: 'e'.repeat(64),
      target: 'aarch64-unknown-linux-gnu',
      build_host: { os: 'linux', arch: 'x64' },
      variant: 'baseline',
      producer_context: {
        schema_version: 1,
        kind: 'slv-native-producer-context',
        repository: 'ValidatorsDAO/slv',
        workflow:
          'ValidatorsDAO/slv/.github/workflows/slv-remote-build.yml@refs/heads/main',
        run_id: '1',
        run_attempt: '1',
        job_id: 'arm-baseline',
      },
    }
    const evidence = root + '/directory-state'
    await Deno.mkdir(evidence + '/compilation-state.json', { recursive: true })
    const guarded = await new Deno.Command('/usr/bin/bash', {
      args: [
        '-euo',
        'pipefail',
        '-c',
        fragment +
        '\nif ! arm_observation_state initial initial; then arm_observation_latch_error initial-state; fi\nif ! arm_observation_state phase guarded-cargo-start; then arm_observation_latch_error guarded-cargo-start; fi\nprintf entered > "$evidence_out/source-marker"',
      ],
      clearEnv: true,
      env: {
        BUILD_TARGET: 'aarch64-unknown-linux-gnu',
        PYTHON: '/usr/bin/python3',
        evidence_out: evidence,
        SLV_ARM_OBSERVATION_CONTEXT: JSON.stringify(valid),
        PATH: '/usr/bin:/bin',
      },
      stdout: 'piped',
      stderr: 'piped',
    }).output()
    requireFixture(
      guarded.success &&
        await Deno.stat(evidence + '/source-marker').then(() => true).catch(
          () => false,
        ) &&
        new TextDecoder().decode(guarded.stderr).includes(
          'SLV_ARM_OBSERVATION_CAPTURE_ERROR',
        ),
      'state write failure aborted the pre-guard source path',
    )

    const recovered = root + '/recovered-state'
    await Deno.mkdir(recovered + '/compilation-state.json', { recursive: true })
    const recoveredResult = await new Deno.Command('/usr/bin/bash', {
      args: [
        '-euo',
        'pipefail',
        '-c',
        fragment +
        '\nif ! arm_observation_state initial initial; then arm_observation_latch_error initial-state; fi\nrmdir "$evidence_out/compilation-state.json"\nif ! arm_observation_state phase guarded-cargo-start; then arm_observation_latch_error guarded-cargo-start; fi\nprintf entered > "$evidence_out/source-marker"\nif ! arm_observation_state raw raw-capture 37 raw-capture-incomplete; then arm_observation_latch_error raw-state; fi',
      ],
      clearEnv: true,
      env: {
        BUILD_TARGET: 'aarch64-unknown-linux-gnu',
        PYTHON: '/usr/bin/python3',
        evidence_out: recovered,
        SLV_ARM_OBSERVATION_CONTEXT: JSON.stringify(valid),
        PATH: '/usr/bin:/bin',
      },
      stdout: 'piped',
      stderr: 'piped',
    }).output()
    const recoveredState = JSON.parse(
      await Deno.readTextFile(recovered + '/compilation-state.json'),
    )
    requireFixture(
      recoveredResult.success &&
        await Deno.stat(recovered + '/source-marker').then(() => true).catch(
          () => false,
        ) &&
        recoveredState.status === 'incomplete' &&
        recoveredState.original_build_exit_code === 37 &&
        recoveredState.capture_errors.includes('initial-state') &&
        recoveredState.capture_errors.includes('guarded-cargo-start') &&
        recoveredState.capture_errors.includes('state-missing'),
      'recovered observation destination cleared an earlier pre-guard failure',
    )

    const accepted = root + '/accepted'
    await Deno.mkdir(accepted)
    const acceptedResult = await new Deno.Command('/usr/bin/bash', {
      args: [
        '-euo',
        'pipefail',
        '-c',
        fragment +
        '\narm_observation_state initial initial\narm_observation_state phase guarded-cargo-start\narm_observation_state raw raw-capture 37 raw-capture-complete',
      ],
      clearEnv: true,
      env: {
        BUILD_TARGET: 'aarch64-unknown-linux-gnu',
        PYTHON: '/usr/bin/python3',
        evidence_out: accepted,
        SLV_ARM_OBSERVATION_CONTEXT: JSON.stringify(valid),
        PATH: '/usr/bin:/bin',
      },
      stdout: 'piped',
      stderr: 'piped',
    }).output()
    const initial = JSON.parse(
      await Deno.readTextFile(accepted + '/compilation-state.json'),
    )
    requireFixture(
      acceptedResult.success &&
        initial.status === 'started' &&
        initial.phase === 'raw-capture' &&
        initial.last_observed_phase === 'raw-capture' &&
        initial.original_build_exit_code === 37 &&
        initial.raw_capture_status === 'raw-capture-complete' &&
        initial.binding.producer_context.job_id === 'arm-baseline',
      'valid full producer identity was not retained',
    )

    const nullProducer = root + '/null-producer'
    await Deno.mkdir(nullProducer)
    const nullProducerResult = await new Deno.Command('/usr/bin/bash', {
      args: [
        '-euo',
        'pipefail',
        '-c',
        fragment + '\narm_observation_state initial initial',
      ],
      clearEnv: true,
      env: {
        BUILD_TARGET: 'aarch64-unknown-linux-gnu',
        PYTHON: '/usr/bin/python3',
        evidence_out: nullProducer,
        SLV_ARM_OBSERVATION_CONTEXT: JSON.stringify({
          ...valid,
          producer_context: null,
        }),
        PATH: '/usr/bin:/bin',
      },
      stdout: 'piped',
      stderr: 'piped',
    }).output()
    const nullProducerState = JSON.parse(
      await Deno.readTextFile(nullProducer + '/compilation-state.json'),
    )
    requireFixture(
      nullProducerResult.success &&
        nullProducerState.status === 'started' &&
        nullProducerState.binding.producer_context === null,
      'null producer context was rejected',
    )

    const invalidProducerContexts: Array<Record<string, unknown>> = [
      {
        schema_version: 1,
        kind: 'slv-native-producer-context',
        repository: 'ValidatorsDAO/slv',
      },
      { ...valid.producer_context, extra: 'unexpected' },
      {
        ...valid.producer_context,
        workflow: 'Other/repository/.github/workflows/build.yml',
      },
      { ...valid.producer_context, job_id: 7 },
      { ...valid.producer_context, run_id: 7 },
      { ...valid.producer_context, run_attempt: false },
      { ...valid.producer_context, run_id: '01' },
    ]
    for (const [index, producer_context] of invalidProducerContexts.entries()) {
      const rejected = root + '/rejected-' + index
      await Deno.mkdir(rejected)
      const rejectedResult = await new Deno.Command('/usr/bin/bash', {
        args: [
          '-euo',
          'pipefail',
          '-c',
          fragment + '\narm_observation_state initial initial',
        ],
        clearEnv: true,
        env: {
          BUILD_TARGET: 'aarch64-unknown-linux-gnu',
          PYTHON: '/usr/bin/python3',
          evidence_out: rejected,
          SLV_ARM_OBSERVATION_CONTEXT: JSON.stringify({
            ...valid,
            producer_context,
          }),
          PATH: '/usr/bin:/bin',
        },
        stdout: 'piped',
        stderr: 'piped',
      }).output()
      const rejectedState = JSON.parse(
        await Deno.readTextFile(rejected + '/compilation-state.json'),
      )
      requireFixture(
        !rejectedResult.success &&
          rejectedState.status === 'incomplete' &&
          rejectedState.identity_status === 'unavailable',
        'invalid producer context ' + index + ' was accepted',
      )
    }
  } finally {
    await Deno.remove(root, { recursive: true })
  }
})

Deno.test('ARM state helpers validate persisted state before phase or raw mutation', async () => {
  const root = await Deno.makeTempDir({ prefix: 'slv-arm-prior-state-' })
  try {
    const fragment = await recipeFragment(
      '# ARM_OBSERVATION_STATE_BEGIN',
      '# ARM_OBSERVATION_STATE_END',
    )
    const binding = {
      source_commit: 'c'.repeat(40),
      source_receipt_sha256: 'd'.repeat(64),
      recipe_sha256: 'e'.repeat(64),
      target: 'aarch64-unknown-linux-gnu',
      build_host: { os: 'linux', arch: 'x64' },
      variant: 'baseline',
      producer_context: {
        schema_version: 1,
        kind: 'slv-native-producer-context',
        repository: 'ValidatorsDAO/slv',
        workflow:
          'ValidatorsDAO/slv/.github/workflows/slv-remote-build.yml@refs/heads/main',
        run_id: '1',
        run_attempt: '1',
        job_id: 'arm-baseline',
      },
    }
    const run = async (
      evidence: string,
      context: string,
      program: string,
    ) =>
      await new Deno.Command('/usr/bin/bash', {
        args: ['-euo', 'pipefail', '-c', fragment + '\n' + program],
        clearEnv: true,
        env: {
          BUILD_TARGET: 'aarch64-unknown-linux-gnu',
          PYTHON: '/usr/bin/python3',
          evidence_out: evidence,
          SLV_ARM_OBSERVATION_CONTEXT: context,
          PATH: '/usr/bin:/bin',
        },
        stdout: 'piped',
        stderr: 'piped',
      }).output()
    const validContext = JSON.stringify(binding)
    type InvalidState = {
      name: string
      mutate: (state: Record<string, unknown>) => void
      render?: (state: Record<string, unknown>) => string
    }
    const invalid: InvalidState[] = [
      {
        name: 'capture-errors-object',
        mutate: (state) => state.capture_errors = {},
      },
      {
        name: 'capture-errors-empty-string',
        mutate: (state) => state.capture_errors = '',
      },
      {
        name: 'capture-errors-null',
        mutate: (state) => state.capture_errors = null,
      },
      {
        name: 'capture-errors-item',
        mutate: (state) => state.capture_errors = [7],
      },
      {
        name: 'capture-errors-code',
        mutate: (state) => state.capture_errors = ['not a bounded code'],
      },
      {
        name: 'capture-errors-duplicate',
        mutate: (state) =>
          state.capture_errors = ['raw-capture', 'raw-capture'],
      },
      {
        name: 'capture-errors-overflow',
        mutate: (state) => {
          state.capture_errors = Array.from(
            { length: 17 },
            (_, index) => `error-${index}`,
          )
        },
      },
      {
        name: 'capture-error-object',
        mutate: (state) => state.capture_error = {},
      },
      {
        name: 'capture-error-code',
        mutate: (state) => state.capture_error = 'not a bounded code',
      },
      { name: 'status', mutate: (state) => state.status = 'unknown' },
      { name: 'status-object', mutate: (state) => state.status = {} },
      { name: 'phase', mutate: (state) => state.phase = 'unknown' },
      { name: 'phase-object', mutate: (state) => state.phase = {} },
      {
        name: 'last-phase',
        mutate: (state) => state.last_observed_phase = 'unknown',
      },
      {
        name: 'last-phase-object',
        mutate: (state) => state.last_observed_phase = {},
      },
      {
        name: 'schema-boolean',
        mutate: (state) => state.schema_version = true,
      },
      {
        name: 'monotonic-boolean',
        mutate: (state) => state.monotonic_started = true,
      },
      {
        name: 'monotonic-negative',
        mutate: (state) => state.monotonic_started = -1,
      },
      {
        name: 'monotonic-nonfinite',
        mutate: () => undefined,
        render: (state) =>
          JSON.stringify(state).replace(
            /"monotonic_started":[^,}]+/,
            '"monotonic_started":NaN',
          ),
      },
      {
        name: 'elapsed-boolean',
        mutate: (state) => state.monotonic_elapsed_seconds = true,
      },
      {
        name: 'elapsed-negative',
        mutate: (state) => state.monotonic_elapsed_seconds = -1,
      },
      {
        name: 'elapsed-nonfinite',
        mutate: (state) => state.monotonic_elapsed_seconds = 0,
        render: (state) =>
          JSON.stringify(state).replace(
            /"monotonic_elapsed_seconds":[^,}]+/,
            '"monotonic_elapsed_seconds":NaN',
          ),
      },
      {
        name: 'binding-array',
        mutate: (state) => state.binding = [],
      },
      {
        name: 'missing-binding-identity',
        mutate: (state) => {
          delete state.binding
          state.identity_status = 'started'
        },
      },
    ]
    for (const fixture of invalid) {
      const stage = `${root}/${fixture.name}/stage`
      const evidence = `${root}/${fixture.name}/evidence`
      const fingerprints = await armObservationFixture(stage, evidence)
      const capture = await captureArmObservation(
        stage,
        'aarch64-unknown-linux-gnu',
        evidence,
        fingerprints,
      )
      const initial = await run(
        evidence,
        validContext,
        'arm_observation_state initial initial',
      )
      requireFixture(initial.success, `${fixture.name} initial state failed`)
      const path = `${evidence}/compilation-state.json`
      const prior = JSON.parse(await Deno.readTextFile(path))
      fixture.mutate(prior)
      await Deno.writeTextFile(
        path,
        fixture.render?.(prior) ?? JSON.stringify(prior),
      )
      const operations = await run(
        evidence,
        validContext,
        'if ! arm_observation_state phase guarded-cargo-start; then arm_observation_latch_error guarded-cargo-start; fi\nif ! arm_observation_state raw raw-capture 0 raw-capture-complete; then arm_observation_latch_error raw-state; fi',
      )
      const diagnostics = new TextDecoder().decode(operations.stderr)
      requireFixture(
        operations.success &&
          (diagnostics.match(/"error"\s*:\s*"state-invalid"/g)?.length ?? 0) >=
            2,
        `${fixture.name} was normalized before phase/raw validation: ${diagnostics}`,
      )
      await internalWriteArmObservation(capture, {
        ...binding,
        original_build_exit_code: 0,
      }).then(
        () => {
          throw new Error(`${fixture.name} produced a complete observation`)
        },
        () => undefined,
      )
      const finalState = JSON.parse(await Deno.readTextFile(path))
      const metadata = JSON.parse(
        await Deno.readTextFile(`${evidence}/compilation-metadata.json`),
      )
      requireFixture(
        finalState.status === 'incomplete' &&
          metadata.status === 'incomplete' &&
          finalState.original_build_exit_code === 0 &&
          metadata.original_build_exit_code === 0 &&
          finalState.capture_errors.includes('state-invalid') &&
          metadata.capture_errors.includes('state-invalid'),
        `${fixture.name} did not persist incomplete source-zero evidence`,
      )
    }
    for (
      const mode of [
        'empty-errors',
        'missing-optional',
        'schema-decimal-one',
      ] as const
    ) {
      const stage = `${root}/${mode}/stage`
      const evidence = `${root}/${mode}/evidence`
      const fingerprints = await armObservationFixture(stage, evidence)
      const capture = await captureArmObservation(
        stage,
        'aarch64-unknown-linux-gnu',
        evidence,
        fingerprints,
      )
      requireFixture(
        (await run(
          evidence,
          validContext,
          'arm_observation_state initial initial',
        ))
          .success,
        `${mode} initial state failed`,
      )
      const path = `${evidence}/compilation-state.json`
      const state = JSON.parse(await Deno.readTextFile(path))
      let stateBytes: string
      if (mode === 'empty-errors') {
        state.capture_errors = []
        stateBytes = JSON.stringify(state)
      } else if (mode === 'missing-optional') {
        delete state.capture_errors
        delete state.last_observed_phase
        stateBytes = JSON.stringify(state)
      } else {
        stateBytes = JSON.stringify(state).replace(
          /"schema_version":1/,
          '"schema_version":1.0',
        )
      }
      await Deno.writeTextFile(path, stateBytes)
      const operations = await run(
        evidence,
        validContext,
        'arm_observation_state phase guarded-cargo-start\narm_observation_state raw raw-capture 0 raw-capture-complete',
      )
      requireFixture(operations.success, `${mode} valid state was rejected`)
      await internalWriteArmObservation(capture, {
        ...binding,
        original_build_exit_code: 0,
      })
      const metadata = JSON.parse(
        await Deno.readTextFile(`${evidence}/compilation-metadata.json`),
      )
      requireFixture(
        metadata.status === 'complete',
        `${mode} optional state history did not complete`,
      )
    }
    for (
      const [name, context, accepted] of [
        [
          'producer-boolean',
          validContext.replace('"schema_version":1', '"schema_version":true'),
          false,
        ],
        [
          'producer-decimal-one',
          validContext.replace('"schema_version":1', '"schema_version":1.0'),
          true,
        ],
      ] as const
    ) {
      const evidence = `${root}/${name}/evidence`
      await Deno.mkdir(evidence, { recursive: true })
      const result = await run(
        evidence,
        context,
        'arm_observation_state initial initial',
      )
      const state = JSON.parse(
        await Deno.readTextFile(`${evidence}/compilation-state.json`),
      )
      requireFixture(
        result.success === accepted &&
          (accepted
            ? state.status === 'started'
            : state.status === 'incomplete' &&
              state.identity_status === 'unavailable'),
        `${name} did not preserve TypeScript numeric schema semantics`,
      )
    }
  } finally {
    await Deno.remove(root, { recursive: true })
  }
})

Deno.test('ARM capture failures retain source status and independently attempt metadata and state', async () => {
  const root = await Deno.makeTempDir({ prefix: 'slv-arm-capture-failure-' })
  try {
    const evidence = root + '/evidence'
    const host = root + '/host'
    const consumer = root + '/consumer'
    for (const output of [host, consumer]) {
      await Deno.mkdir(output + '/obj', { recursive: true })
      await Deno.writeTextFile(output + '/args.gn', 'target_cpu = "arm64"\\n')
      await Deno.writeTextFile(
        output + '/obj/rusty_v8.ninja',
        'defines = -DV8_TARGET_ARCH_ARM64\\n',
      )
    }
    await Deno.mkdir(evidence)
    await Deno.mkdir(evidence + '/raw-capture.json')
    const fragment = await recipeFragment(
      '# ARM_EVIDENCE_RAW_CAPTURE_BEGIN',
      '# ARM_EVIDENCE_RAW_CAPTURE_END',
    )
    const result = await new Deno.Command('/usr/bin/bash', {
      args: [
        '-euo',
        'pipefail',
        '-c',
        fragment +
        '\nstatus=37\nif ! capture_arm_raw_evidence "$1" "$2"; then :; fi\ntest "$status" -eq 37',
        '--',
        host,
        consumer,
      ],
      clearEnv: true,
      env: {
        BUILD_TARGET: 'aarch64-unknown-linux-gnu',
        PYTHON: '/usr/bin/python3',
        evidence_out: evidence,
        PATH: '/usr/bin:/bin',
      },
      stdout: 'piped',
      stderr: 'piped',
    }).output()
    requireFixture(
      result.success &&
        new TextDecoder().decode(result.stderr).includes(
          'SLV_ARM_OBSERVATION_CAPTURE_ERROR',
        ),
      'raw-capture failure replaced the saved source status or hid its error',
    )

    const canonicalBinding = {
      source_commit: 'c'.repeat(40),
      source_receipt_sha256: 'd'.repeat(64),
      recipe_sha256: 'e'.repeat(64),
      target: 'aarch64-unknown-linux-gnu',
      build_host: { os: 'linux', arch: 'x64' },
      variant: 'baseline',
      producer_context: null,
    }
    const stage = root + '/stage'
    const completeEvidence = root + '/complete-evidence'
    const fingerprints = await armObservationFixture(stage, completeEvidence)
    const capture = await captureArmObservation(
      stage,
      'aarch64-unknown-linux-gnu',
      completeEvidence,
      fingerprints,
    )
    await Deno.writeTextFile(
      completeEvidence + '/compilation-state.json',
      JSON.stringify({
        schema_version: 1,
        kind: 'slv-arm-snapshot-build-observation-state',
        status: 'started',
        phase: 'raw-capture',
        last_observed_phase: 'raw-capture',
        monotonic_started: 1,
        binding: canonicalBinding,
      }),
    )
    await Deno.mkdir(completeEvidence + '/compilation-metadata.json')
    await internalWriteArmObservation(capture, {
      ...canonicalBinding,
      original_build_exit_code: 0,
    }).then(
      () => {
        throw new Error('metadata write failure was accepted as complete')
      },
      () => undefined,
    )
    const state = JSON.parse(
      await Deno.readTextFile(completeEvidence + '/compilation-state.json'),
    )
    requireFixture(
      state.status === 'incomplete' &&
        Array.isArray(state.capture_errors) &&
        state.capture_errors.includes('metadata-write'),
      'metadata failure prevented independent state retention: ' +
        JSON.stringify(state),
    )

    const canonicalEvidence = root + '/canonical-evidence'
    const canonicalStage = root + '/canonical-stage'
    const canonicalFingerprints = await armObservationFixture(
      canonicalStage,
      canonicalEvidence,
    )
    const canonicalCapture = await captureArmObservation(
      canonicalStage,
      'aarch64-unknown-linux-gnu',
      canonicalEvidence,
      canonicalFingerprints,
    )
    await Deno.writeTextFile(
      canonicalEvidence + '/compilation-state.json',
      JSON.stringify({
        schema_version: 1,
        kind: 'slv-arm-snapshot-build-observation-state',
        status: 'started',
        phase: 'raw-capture',
        last_observed_phase: 'raw-capture',
        monotonic_started: 1,
        binding: canonicalBinding,
      }),
    )
    await internalWriteArmObservation(canonicalCapture, {
      ...canonicalBinding,
      derived_relink_cargo_lock_sha256: 'f'.repeat(64),
      runtime_sha256: 'a'.repeat(64),
      requested: { gn_args: 'use_glib=false', extra_gn_args: 'use_lld=true' },
      timing: {
        started_at: '2026-10-15T00:00:00Z',
        finished_at: '2026-10-15T00:00:01Z',
        elapsed_seconds: 1,
      },
      original_build_exit_code: 0,
      configuration_check: 'passed',
    })
    const canonicalMetadata = JSON.parse(
      await Deno.readTextFile(canonicalEvidence + '/compilation-metadata.json'),
    )
    const canonicalState = JSON.parse(
      await Deno.readTextFile(canonicalEvidence + '/compilation-state.json'),
    )
    requireFixture(
      canonicalMetadata.status === 'complete' &&
        canonicalState.status === 'complete' &&
        canonicalState.last_observed_phase === 'raw-capture' &&
        Array.isArray(canonicalState.capture_errors) &&
        canonicalState.capture_errors.length === 0,
      'extended final observations conflicted with the canonical recipe binding',
    )

    const stateOnlyEvidence = root + '/state-only-evidence'
    const stateOnlyStage = root + '/state-only-stage'
    const stateOnlyFingerprints = await armObservationFixture(
      stateOnlyStage,
      stateOnlyEvidence,
    )
    const stateOnlyCapture = await captureArmObservation(
      stateOnlyStage,
      'aarch64-unknown-linux-gnu',
      stateOnlyEvidence,
      stateOnlyFingerprints,
    )
    const stateOnlyPath = stateOnlyEvidence + '/compilation-state.json'
    await Deno.writeTextFile(
      stateOnlyPath,
      JSON.stringify({
        schema_version: 1,
        kind: 'slv-arm-snapshot-build-observation-state',
        status: 'started',
        phase: 'raw-capture',
        last_observed_phase: 'raw-capture',
        monotonic_started: 1,
        binding: canonicalBinding,
      }),
    )
    await internalWriteArmObservation(
      stateOnlyCapture,
      {
        ...canonicalBinding,
        original_build_exit_code: 0,
      },
      async () => {
        await Deno.remove(stateOnlyPath)
        await Deno.mkdir(stateOnlyPath)
      },
    ).then(
      () => {
        throw new Error('state-only final write failure was accepted')
      },
      () => undefined,
    )
    const stateOnlyMetadata = JSON.parse(
      await Deno.readTextFile(stateOnlyEvidence + '/compilation-metadata.json'),
    )
    requireFixture(
      stateOnlyMetadata.status === 'incomplete' &&
        stateOnlyMetadata.original_build_exit_code === 0 &&
        stateOnlyMetadata.capture_errors.includes('state-write'),
      'successful metadata did not retain the later state-write failure: ' +
        JSON.stringify(stateOnlyMetadata),
    )

    const sourceZeroEvidence = root + '/source-zero-evidence'
    const sourceZeroStage = root + '/source-zero-stage'
    const sourceZeroFingerprints = await armObservationFixture(
      sourceZeroStage,
      sourceZeroEvidence,
    )
    await Deno.remove(sourceZeroEvidence + '/host-args.gn')
    const sourceZeroCapture = await captureArmObservation(
      sourceZeroStage,
      'aarch64-unknown-linux-gnu',
      sourceZeroEvidence,
      sourceZeroFingerprints,
    )
    await Deno.writeTextFile(
      sourceZeroEvidence + '/compilation-state.json',
      JSON.stringify({
        schema_version: 1,
        kind: 'slv-arm-snapshot-build-observation-state',
        status: 'started',
        phase: 'raw-capture',
        last_observed_phase: 'raw-capture',
        monotonic_started: 1,
        binding: canonicalBinding,
      }),
    )
    await internalWriteArmObservation(sourceZeroCapture, {
      ...canonicalBinding,
      original_build_exit_code: 0,
    }).then(
      () => {
        throw new Error('source-zero capture failure was accepted as complete')
      },
      () => undefined,
    )
    const sourceZeroState = JSON.parse(
      await Deno.readTextFile(sourceZeroEvidence + '/compilation-state.json'),
    )
    requireFixture(
      sourceZeroCapture?.status === 'incomplete' &&
        sourceZeroState.status === 'incomplete' &&
        sourceZeroState.original_build_exit_code === 0 &&
        sourceZeroState.capture_errors.includes('capture-incomplete'),
      'source-zero incomplete capture became complete: ' +
        JSON.stringify(sourceZeroState),
    )
  } finally {
    await Deno.remove(root, { recursive: true })
  }
})

Deno.test('ARM writer retains incomplete and rejects malformed prior state histories', async () => {
  const root = await Deno.makeTempDir({ prefix: 'slv-arm-state-history-' })
  try {
    const binding = {
      source_commit: 'c'.repeat(40),
      source_receipt_sha256: 'd'.repeat(64),
      recipe_sha256: 'e'.repeat(64),
      target: 'aarch64-unknown-linux-gnu',
      build_host: { os: 'linux', arch: 'x64' },
      variant: 'baseline',
      producer_context: null,
      original_build_exit_code: 0,
    }
    const cases: Array<{
      name: string
      state: Record<string, unknown>
      expected: string
    }> = [
      {
        name: 'plain-incomplete',
        state: { status: 'incomplete' },
        expected: 'state-incomplete',
      },
      {
        name: 'malformed-capture-error',
        state: { capture_error: { reason: 'not-a-code' } },
        expected: 'state-invalid',
      },
      {
        name: 'malformed-capture-errors',
        state: { capture_errors: ['raw-capture', 7] },
        expected: 'state-invalid',
      },
    ]
    for (const fixture of cases) {
      const evidence = root + '/' + fixture.name + '/evidence'
      const stage = root + '/' + fixture.name + '/stage'
      const fingerprints = await armObservationFixture(stage, evidence)
      const capture = await captureArmObservation(
        stage,
        'aarch64-unknown-linux-gnu',
        evidence,
        fingerprints,
      )
      await Deno.writeTextFile(
        evidence + '/compilation-state.json',
        JSON.stringify({
          schema_version: 1,
          kind: 'slv-arm-snapshot-build-observation-state',
          phase: 'raw-capture',
          last_observed_phase: 'raw-capture',
          monotonic_started: 1,
          binding,
          ...fixture.state,
        }),
      )
      await internalWriteArmObservation(capture, binding).then(
        () => {
          throw new Error(fixture.name + ' became a complete observation')
        },
        () => undefined,
      )
      const metadata = JSON.parse(
        await Deno.readTextFile(evidence + '/compilation-metadata.json'),
      )
      const state = JSON.parse(
        await Deno.readTextFile(evidence + '/compilation-state.json'),
      )
      requireFixture(
        metadata.status === 'incomplete' &&
          state.status === 'incomplete' &&
          metadata.capture_errors.includes(fixture.expected) &&
          state.capture_errors.includes(fixture.expected),
        fixture.name + ' was normalized into a clean completion',
      )
    }
  } finally {
    await Deno.remove(root, { recursive: true })
  }
})

async function cargoGuardFragment(): Promise<string> {
  return await recipeFragment(
    '# CARGO_BUILD_GUARD_BEGIN',
    '# CARGO_BUILD_GUARD_END',
  )
}

async function runCurrentCargoGuard(
  root: string,
  resume: boolean,
  generateStatus: number,
  assertionStatus: number,
  copyStatus: number,
  buildStatus: number,
): Promise<{ code: number; calls: string[] }> {
  const fragment = await cargoGuardFragment()
  const work = `${root}/work`
  const calls = `${root}/cargo-calls`
  const cargo = `${root}/fake-cargo.sh`
  await Deno.mkdir(`${work}/deno`, { recursive: true })
  await Deno.writeTextFile(`${work}/deno/Cargo.lock`, 'fixture lock\n')
  await Deno.writeTextFile(
    cargo,
    `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$CARGO_CALLS"
if [[ "$1" == generate-lockfile ]]; then exit "$GENERATE_STATUS"; fi
exit "$BUILD_STATUS"
`,
  )
  await Deno.chmod(cargo, 0o755)
  const copied = `${root}/derived-relink-Cargo.lock`
  // cp is an actual recipe command.  A directory at its expected destination
  // is the production seam for its distinct failure, without changing argv.
  if (copyStatus !== 0) await Deno.symlink('/dev/full', copied)
  const program = `
assert_only_local_v8_relink() { return "$ASSERTION_STATUS"; }
target_args=()
${fragment}
exit "$status"
`
  const result = await new Deno.Command('/usr/bin/bash', {
    args: ['-u', '-o', 'pipefail', '-c', program],
    clearEnv: true,
    env: {
      PATH: '/usr/bin:/bin',
      ASSERTION_STATUS: String(assertionStatus),
      BUILD_STATUS: String(buildStatus),
      CARGO_CALLS: calls,
      GENERATE_STATUS: String(generateStatus),
      cargo,
      jobs: '4',
      log: `${root}/cargo.log`,
      macos_bindgen_preflight_status: '0',
      output: root,
      resume: String(resume),
      source_lock: `${root}/source-Cargo.lock`,
      work,
    },
    stdout: 'piped',
    stderr: 'piped',
  }).output()
  const recorded = await Deno.readTextFile(calls).catch(() => '')
  return {
    code: result.code,
    calls: recorded === '' ? [] : recorded.trimEnd().split('\n'),
  }
}

async function lifecycleHelpers(): Promise<string> {
  return await recipeFragment(
    '# CARGO_BUILD_LIFECYCLE_HELPERS_BEGIN',
    '# CARGO_BUILD_LIFECYCLE_HELPERS_END',
  )
}

async function runCurrentSupervisor(
  root: string,
  workerBody: string,
  cancellation?: 'INT' | 'TERM' | 'HUP',
  completionFault = false,
  releaseFault = false,
  lateStop = false,
  psDelay?: number,
): Promise<{
  code: number
  elapsed: number
  child: number
  ps?: number
  stdout: string
}> {
  const helpers = await lifecycleHelpers()
  await Deno.mkdir(root, { recursive: true })
  const worker = `${root}/worker.sh`
  const childPath = `${root}/child.pid`
  const psPidPath = `${root}/ps.pid`
  await Deno.writeTextFile(worker, `#!/usr/bin/env bash\n${workerBody}\n`)
  await Deno.chmod(worker, 0o700)
  const signal = cancellation
    ? `
for _ in $(seq 1 100); do [[ -f "$child_path" ]] && break; sleep .01; done
kill -${cancellation} "$supervisor_pid"
`
    : ''
  const psShim = psDelay === undefined ? undefined : `${root}/ps-shim.sh`
  if (psShim) {
    await Deno.writeTextFile(
      psShim,
      `#!/usr/bin/env bash
printf '%s\\n' "$$" > "$PS_PID"
sleep "$PS_DELAY"
exec /bin/ps "$@"
`,
    )
    await Deno.chmod(psShim, 0o700)
  }
  const injector = completionFault || releaseFault || lateStop || psShim
    ? `"$PYTHON" - "$supervisor" <<'PYEOF'
import pathlib
import sys
path = pathlib.Path(sys.argv[1])
source = path.read_text()
${
      completionFault
        ? `needle = "os.write(completion_fd, (str(status) + '\\\\n').encode('ascii'))"
assert needle in source
source = source.replace(needle, 'raise OSError()', 1)`
        : ''
    }
${
      releaseFault
        ? `needle = "os.write(release_write, b'R')"
assert needle in source
source = source.replace(needle, 'raise OSError()', 1)`
        : ''
    }
${
      lateStop
        ? `needle = "cleanup_deadline = min(final_deadline, now() + BUILD_CLEANUP_SECONDS)"
assert needle in source
source = source.replace(needle, 'os.kill(os.getpid(), signal.SIGTERM)\\n    ' + needle, 1)`
        : ''
    }
${
      psShim
        ? `needle = "['/bin/ps', '-axo', 'pid=,pgid=']"
assert needle in source
source = source.replace(needle, "[os.environ['SLV_TEST_PS'], '-axo', 'pid=,pgid=']", 1)`
        : ''
    }
path.write_text(source)
PYEOF`
    : ''
  const script = `
${helpers}
assert_only_local_v8_relink() { return 0; }
output="$root"
PYTHON=/usr/bin/python3
supervisor="$(write_macos_build_supervisor)"
${injector}
set +e
CHILD_PID="$child_path" "$PYTHON" "$supervisor" "$worker" &
supervisor_pid=$!
${signal}
wait "$supervisor_pid"
status=$?
set -e
printf '%s\\n' "$status" > "$root/status"
`
  const started = performance.now()
  const result = await new Deno.Command('/usr/bin/bash', {
    args: ['-u', '-o', 'pipefail', '-c', script],
    clearEnv: true,
    env: {
      PATH: '/usr/bin:/bin',
      root,
      child_path: childPath,
      PS_DELAY: String(psDelay ?? 0),
      PS_PID: psPidPath,
      SLV_TEST_PS: psShim ?? '/bin/ps',
      worker,
    },
    stdout: 'piped',
    stderr: 'piped',
  }).output()
  const elapsed = performance.now() - started
  requireFixture(
    result.success,
    `current lifecycle helper shell failed: ${
      new TextDecoder().decode(result.stderr)
    }`,
  )
  const childText = await Deno.readTextFile(childPath).catch(() => '')
  requireFixture(
    childText !== '',
    `current supervisor did not launch worker: stdout=${
      new TextDecoder().decode(result.stdout)
    } stderr=${new TextDecoder().decode(result.stderr)}`,
  )
  return {
    code: Number((await Deno.readTextFile(`${root}/status`)).trim()),
    elapsed,
    child: Number(childText.trim()),
    ps: await Deno.readTextFile(psPidPath).then((value) => Number(value.trim()))
      .catch(() => undefined),
    stdout: new TextDecoder().decode(result.stdout),
  }
}

async function processIsGone(pid: number): Promise<boolean> {
  const result = await new Deno.Command('/bin/kill', {
    args: ['-0', String(pid)],
    stdout: 'null',
    stderr: 'null',
  }).output()
  return !result.success
}

Deno.test('current Cargo guard preserves first command status and blocks later fresh phases', async () => {
  const root = await Deno.makeTempDir({ prefix: 'slv-cargo-guard-status-' })
  try {
    const lockFailure = await runCurrentCargoGuard(
      root + '/lock',
      false,
      37,
      0,
      0,
      0,
    )
    requireFixture(
      lockFailure.code === 37 && lockFailure.calls.length === 1 &&
        lockFailure.calls[0] === 'generate-lockfile --offline',
      'generate-lockfile 37 did not stop validation, copy, and Cargo build',
    )
    const validationFailure = await runCurrentCargoGuard(
      root + '/validation',
      false,
      0,
      41,
      0,
      0,
    )
    requireFixture(
      validationFailure.code === 41 && validationFailure.calls.length === 1,
      'lock validation 41 did not stop copy and Cargo build',
    )
    const copyFailure = await runCurrentCargoGuard(
      root + '/copy',
      false,
      0,
      0,
      1,
      0,
    )
    requireFixture(
      copyFailure.code !== 0 && copyFailure.calls.length === 1,
      'failed derived-lock copy started Cargo build',
    )
    const freshBuild = await runCurrentCargoGuard(
      root + '/fresh-success',
      false,
      0,
      0,
      0,
      0,
    )
    requireFixture(
      freshBuild.code === 0 &&
        JSON.stringify(freshBuild.calls) ===
          JSON.stringify([
            'generate-lockfile --offline',
            'build --locked --offline --release -j 4 -p denort',
          ]),
      'fresh successful guard did not retain its Cargo status and argv',
    )

    const resumeBuild = await runCurrentCargoGuard(
      root + '/resume',
      true,
      0,
      0,
      0,
      37,
    )
    requireFixture(
      resumeBuild.code === 37 &&
        JSON.stringify(resumeBuild.calls) ===
          JSON.stringify(['build --locked --offline --release -j 4 -p denort']),
      'resume Cargo argv or build status changed',
    )
  } finally {
    await Deno.remove(root, { recursive: true })
  }
})

Deno.test('current macOS supervisor preserves worker status and reaps only its held group', async () => {
  const root = await Deno.makeTempDir({
    prefix: 'slv-macos-supervisor-status-',
  })
  const sibling = new Deno.Command('/bin/sleep', {
    args: ['30'],
    stdout: 'null',
    stderr: 'null',
  }).spawn()
  try {
    const zero = await runCurrentSupervisor(
      root + '/zero',
      'sleep 30 &\nprintf "%s\\n" "$!" > "$CHILD_PID"\nexit 0',
    )
    requireFixture(
      zero.code === 0 && await processIsGone(zero.child),
      'supervisor did not retain actual worker zero after a successful held-anchor census',
    )
    const result = await runCurrentSupervisor(
      root,
      'sleep 30 &\nprintf "%s\\n" "$!" > "$CHILD_PID"\nexit 37',
    )
    requireFixture(
      result.code === 37 && await processIsGone(result.child),
      'supervisor did not retain 37 while reaping its same-group child',
    )
    requireFixture(
      !(await processIsGone(sibling.pid)),
      'supervisor signaled an unrelated sibling outside its owned session',
    )
  } finally {
    try {
      sibling.kill('SIGKILL')
    } catch { /* already gone */ }
    await sibling.status.catch(() => undefined)
    await Deno.remove(root, { recursive: true })
  }
})

Deno.test('current macOS supervisor accepts a complete delayed census inside its unchanged cleanup cap', async () => {
  const root = await Deno.makeTempDir({
    prefix: 'slv-macos-supervisor-delayed-census-',
  })
  try {
    const result = await runCurrentSupervisor(
      root,
      'sleep 30 &\nprintf "%s\\n" "$!" > "$CHILD_PID"\nexit 0',
      undefined,
      false,
      false,
      false,
      0.3,
    )
    requireFixture(
      result.code === 0 && result.elapsed >= 300 && result.elapsed < 2000 &&
        result.ps !== undefined && await waitForProcessGone(result.child) &&
        await waitForProcessGone(result.ps),
      'complete delayed census was not accepted inside the unchanged two-second cleanup cap',
    )
  } finally {
    await Deno.remove(root, { recursive: true })
  }
})

Deno.test('current macOS supervisor kills a delayed-census TERM-resistant owned descendant before retaining zero', async () => {
  const root = await Deno.makeTempDir({
    prefix: 'slv-macos-supervisor-delayed-resistant-',
  })
  let child = 0
  try {
    const resistant = `${root}/resistant.py`
    await Deno.writeTextFile(
      resistant,
      `import os
import pathlib
import signal
import time
signal.signal(signal.SIGTERM, signal.SIG_IGN)
pathlib.Path(os.environ['CHILD_PID']).write_text(str(os.getpid()))
os.close(1)
os.close(2)
time.sleep(30)
`,
    )
    const result = await runCurrentSupervisor(
      root,
      `/usr/bin/python3 ${JSON.stringify(resistant)} &\nexit 0`,
      undefined,
      false,
      false,
      false,
      0.65,
    )
    child = result.child
    requireFixture(
      result.code === 0 && result.elapsed >= 650 && result.elapsed < 2000 &&
        result.ps !== undefined && await waitForProcessGone(result.child) &&
        await waitForProcessGone(result.ps),
      'TERM-resistant owned descendant was not observed gone before supervisor retained zero',
    )
  } finally {
    if (child > 0 && !(await processIsGone(child))) {
      try {
        Deno.kill(child, 'SIGKILL')
      } catch { /* fixture cleanup */ }
    }
    await Deno.remove(root, { recursive: true })
  }
})

Deno.test('current macOS supervisor rejects a hung census without accepting empty residue', async () => {
  const root = await Deno.makeTempDir({
    prefix: 'slv-macos-supervisor-hung-census-',
  })
  try {
    const result = await runCurrentSupervisor(
      root,
      'sleep 30 &\nprintf "%s\\n" "$!" > "$CHILD_PID"\nexit 0',
      undefined,
      false,
      false,
      false,
      3,
    )
    requireFixture(
      result.code === 125 && result.elapsed < 2300 &&
        result.ps !== undefined && await waitForProcessGone(result.child) &&
        await waitForProcessGone(result.ps),
      'hung census was treated as empty residue or exceeded the cleanup deadline',
    )
  } finally {
    await Deno.remove(root, { recursive: true })
  }
})

Deno.test('current macOS supervisor retains bounded same-session residue evidence in its build log', async () => {
  const root = await Deno.makeTempDir({
    prefix: 'slv-macos-supervisor-residue-',
  })
  let escapedChild = 0
  try {
    const escaped = `${root}/escaped-child.py`
    await Deno.writeTextFile(
      escaped,
      `import os, pathlib, time
os.setpgrp()
pathlib.Path(os.environ['CHILD_PID']).write_text(str(os.getpid()))
os.close(1)
os.close(2)
time.sleep(30)
`,
    )
    const result = await runCurrentSupervisor(
      root,
      `/usr/bin/python3 ${JSON.stringify(escaped)} &
printf "%s\n" "$!" > "$CHILD_PID"
exit 0`,
    )
    escapedChild = result.child
    const line = result.stdout.split('\n').find((value) =>
      value.startsWith('SLV_MACOS_CARGO_CLEANUP_INCOMPLETE ')
    )
    const diagnostic = line
      ? JSON.parse(
        line.slice('SLV_MACOS_CARGO_CLEANUP_INCOMPLETE '.length),
      ) as {
        status?: string
        reason?: string
        residue?: Array<{ pid?: number; pgid?: number; sid?: number }>
        residue_total?: number
        residue_truncated?: boolean
      }
      : undefined
    requireFixture(
      result.code === 125 && result.elapsed < 2300 &&
        !(await processIsGone(escapedChild)) &&
        diagnostic?.status === 'incomplete' &&
        diagnostic.reason === 'session-residue' &&
        diagnostic.residue_total === 2 &&
        diagnostic.residue_truncated === false &&
        diagnostic.residue?.some((row) =>
          row.pid === escapedChild &&
          row.pgid === escapedChild && typeof row.sid === 'number'
        ),
      'same-SID subgroup cleanup evidence was not retained through the existing build log',
    )
  } finally {
    if (escapedChild > 0 && !(await processIsGone(escapedChild))) {
      try {
        Deno.kill(escapedChild, 'SIGKILL')
      } catch { /* fixture cleanup */ }
    }
    await Deno.remove(root, { recursive: true })
  }
})

Deno.test('current macOS supervisor reserves final reap time after a release-write failure', async () => {
  const root = await Deno.makeTempDir({
    prefix: 'slv-macos-supervisor-release-fault-',
  })
  try {
    const result = await runCurrentSupervisor(
      root,
      'sleep 30 &\nprintf "%s\n" "$!" > "$CHILD_PID"\nexit 0',
      undefined,
      false,
      true,
    )
    requireFixture(
      result.code === 125 && result.elapsed < 2300 &&
        await processIsGone(result.child) &&
        result.stdout.includes('"reason":"release-write"'),
      'release-write fault exhausted build cleanup time before final reap',
    )
  } finally {
    await Deno.remove(root, { recursive: true })
  }
})

Deno.test('current macOS supervisor retains a late first cancellation over saved worker zero', async () => {
  const root = await Deno.makeTempDir({
    prefix: 'slv-macos-supervisor-late-stop-',
  })
  try {
    const result = await runCurrentSupervisor(
      root,
      'sleep 30 &\nprintf "%s\n" "$!" > "$CHILD_PID"\nexit 0',
      undefined,
      false,
      false,
      true,
    )
    const childGone = await processIsGone(result.child)
    requireFixture(
      result.code === 143 && result.elapsed < 2300 && childGone,
      `late cancellation was normalized into the saved worker result: code=${result.code} elapsed=${result.elapsed} childGone=${childGone} stdout=${result.stdout}`,
    )
  } finally {
    await Deno.remove(root, { recursive: true })
  }
})

Deno.test('current macOS supervisor makes cancellation bounded and signal-compatible', async () => {
  const root = await Deno.makeTempDir({
    prefix: 'slv-macos-supervisor-signal-',
  })
  try {
    for (
      const [signal, expected] of [['INT', 130], ['TERM', 143], [
        'HUP',
        129,
      ]] as const
    ) {
      const result = await runCurrentSupervisor(
        `${root}/${signal}`,
        'sleep 30 &\nprintf "%s\\n" "$!" > "$CHILD_PID"\nwait',
        signal,
      )
      requireFixture(
        result.code === expected && result.elapsed < 3300 &&
          await processIsGone(result.child),
        `${signal} did not finish boundedly with the child group reaped`,
      )
    }
  } finally {
    await Deno.remove(root, { recursive: true })
  }
})

async function observerPythonPrefix(): Promise<string> {
  const observer = await recipeFragment(
    '# MACOS_BUILD_OBSERVER_BEGIN',
    '# MACOS_BUILD_OBSERVER_END',
  )
  const begin = observer.indexOf("<<'PYEOF' &\n")
  const end = observer.indexOf("emit('build-child-start')", begin)
  requireFixture(begin >= 0 && end > begin, 'observer Python seam is missing')
  return observer.slice(begin + "<<'PYEOF' &\n".length, end)
}

async function currentObserverCensusMatrix(): Promise<{
  normal: { ok: boolean; exit_code?: number }
  variants: Array<{
    mode: string
    result: { ok: boolean; reason?: string }
    elapsed: number
    censusCodes: Array<number | null>
  }>
}> {
  const prefix = await observerPythonPrefix()
  const variants = [
    ['exit37-empty', 'import sys;sys.exit(37)'],
    ['exit0-empty', 'pass'],
    [
      'eof-before-exit',
      'import os,signal,time;os.close(1);signal.signal(signal.SIGTERM,signal.SIG_IGN);time.sleep(30)',
    ],
  ] as const
  const program = `
import json, subprocess, sys, time
sys.argv = ['observer', str(__import__('os').getpid()), '/tmp', '/tmp/baseline-denort.log', '45']
${prefix}
normal = run([sys.executable, '-c', 'pass'], time.monotonic() + 1)
original_popen = subprocess.Popen
variants = []
for mode, child_program in ${JSON.stringify(variants)}:
    census = []
    def popen(argv, *args, **kwargs):
        if argv == ['/bin/ps', '-axo', 'pid=,pgid=']:
            child = original_popen([sys.executable, '-c', child_program], *args, **kwargs)
            census.append(child)
            return child
        return original_popen(argv, *args, **kwargs)
    subprocess.Popen = popen
    started = time.monotonic()
    result = run([sys.executable, '-c', 'pass'], time.monotonic() + 1)
    elapsed = time.monotonic() - started
    subprocess.Popen = original_popen
    codes = [child.poll() for child in census]
    for child in census:
        if child.poll() is None:
            child.kill()
        while child.poll() is None:
            time.sleep(.005)
    variants.append({'mode': mode, 'result': result, 'elapsed': elapsed, 'censusCodes': codes})
print(json.dumps({'normal': normal, 'variants': variants}))
`
  const result = await new Deno.Command('/usr/bin/python3', {
    args: ['-c', program],
    clearEnv: true,
    env: { PATH: '/usr/bin:/bin' },
    stdout: 'piped',
    stderr: 'piped',
  }).output()
  requireFixture(
    result.success,
    `current observer census seam failed: ${
      new TextDecoder().decode(result.stderr)
    }`,
  )
  return JSON.parse(new TextDecoder().decode(result.stdout))
}

Deno.test('current observer requires a reaped census with its held anchor before accepting utility zero', async () => {
  const matrix = await currentObserverCensusMatrix()
  requireFixture(
    matrix.normal.ok && matrix.normal.exit_code === 0,
    'actual successful census did not retain utility zero',
  )
  requireFixture(
    matrix.variants.every((variant) =>
      !variant.result.ok && variant.result.reason === 'cleanup-incomplete' &&
      variant.censusCodes.every((code) => code !== null) && variant.elapsed < 1
    ),
    'failed, anchorless, or unreaped census was accepted as utility success',
  )
})

Deno.test('current observer closes each release endpoint after repeated timeout cleanup', async () => {
  const prefix = await observerPythonPrefix()
  const program = `
import json, os, signal, subprocess, sys, time
sys.argv = ['observer', str(os.getpid()), '/tmp', '/tmp/baseline-denort.log', '45']
${prefix}
original_launch = launch
handles, checks, results = [], [], []
def tracked_launch(*args, **kwargs):
    handle, failure = original_launch(*args, **kwargs)
    if handle is not None:
        handles.append((handle, handle['release_write']))
    return handle, failure
launch = tracked_launch
utility = 'import signal,time;signal.signal(signal.SIGTERM,signal.SIG_IGN);time.sleep(30)'
for _ in range(2):
    result = run([sys.executable, '-c', utility], time.monotonic() + .25)
    handle, release_fd = handles[-1]
    try:
        os.fstat(release_fd)
        closed = False
    except OSError:
        closed = True
    results.append(result)
    checks.append({'handle_release_is_none': handle['release_write'] is None, 'fd_closed': closed})
print(json.dumps({'results': results, 'checks': checks, 'active': len(active)}))
`
  const result = await new Deno.Command('/usr/bin/python3', {
    args: ['-c', program],
    clearEnv: true,
    env: { PATH: '/usr/bin:/bin' },
    stdout: 'piped',
    stderr: 'piped',
  }).output()
  requireFixture(
    result.success,
    `current observer timeout seam failed: ${
      new TextDecoder().decode(result.stderr)
    }`,
  )
  const outcome = JSON.parse(new TextDecoder().decode(result.stdout)) as {
    results: Array<{ ok: boolean; reason?: string }>
    checks: Array<{ handle_release_is_none: boolean; fd_closed: boolean }>
    active: number
  }
  requireFixture(
    outcome.results.every((entry) => !entry.ok && entry.reason === 'timeout') &&
      outcome.checks.every((entry) =>
        entry.handle_release_is_none && entry.fd_closed
      ) && outcome.active === 0,
    'timeout cleanup retained an observer release endpoint or active ownership',
  )
})

async function waitForProcessGone(pid: number): Promise<boolean> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (await processIsGone(pid)) return true
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  return false
}

Deno.test('current observer cleans a closed-pipe same-group descendant before accepting utility zero', async () => {
  const root = await Deno.makeTempDir({ prefix: 'slv-observer-closed-pipe-' })
  let child = 0
  try {
    const prefix = await observerPythonPrefix()
    const tool = `${root}/closed-pipe-tool.py`
    const childPath = `${root}/child.pid`
    const childCode =
      `import os,time,pathlib;pathlib.Path(os.environ['DESC']).write_text(str(os.getpid()));os.close(1);os.close(2);time.sleep(30)`
    await Deno.writeTextFile(
      tool,
      `import os,subprocess,sys\nsubprocess.Popen([sys.executable,'-c',${
        JSON.stringify(childCode)
      }])\nos.close(1);os.close(2);sys.exit(0)\n`,
    )
    await Deno.chmod(tool, 0o700)
    const program = `
import json, os, pathlib, sys, time
sys.argv = ['observer', str(os.getpid()), ${JSON.stringify(root)}, ${
      JSON.stringify(`${root}/baseline-denort.log`)
    }, '45']
${prefix}
os.environ['DESC'] = ${JSON.stringify(childPath)}
started = time.monotonic()
result = run([sys.executable, ${JSON.stringify(tool)}], time.monotonic() + 3)
print(json.dumps({'result': result, 'elapsed': time.monotonic() - started}))
`
    const result = await new Deno.Command('/usr/bin/python3', {
      args: ['-c', program],
      clearEnv: true,
      env: { PATH: '/usr/bin:/bin' },
      stdout: 'piped',
      stderr: 'piped',
    }).output()
    child = Number((await Deno.readTextFile(childPath)).trim())
    const outcome = JSON.parse(new TextDecoder().decode(result.stdout)) as {
      result: { ok: boolean; exit_code?: number }
      elapsed: number
    }
    requireFixture(
      result.success && outcome.result.ok && outcome.result.exit_code === 0 &&
        outcome.elapsed < 3 && await waitForProcessGone(child),
      'closed-pipe descendant was accepted without bounded original-group cleanup',
    )
  } finally {
    if (child > 0 && !(await processIsGone(child))) {
      try {
        Deno.kill(child, 'SIGKILL')
      } catch { /* fixture cleanup */ }
    }
    await Deno.remove(root, { recursive: true })
  }
})

Deno.test('current observer anchor cleans its utility group after supervisor loss', async () => {
  const root = await Deno.makeTempDir({ prefix: 'slv-observer-parent-loss-' })
  let child = 0
  let parent: Deno.ChildProcess | undefined
  try {
    const prefix = await observerPythonPrefix()
    const tool = `${root}/sleep-tool.py`
    const childPath = `${root}/child.pid`
    await Deno.writeTextFile(
      tool,
      `import os,pathlib,time\npathlib.Path(os.environ['PID_FILE']).write_text(str(os.getpid()))\ntime.sleep(30)\n`,
    )
    await Deno.chmod(tool, 0o700)
    const program = `
import os, pathlib, sys, time
sys.argv = ['observer', str(os.getpid()), ${JSON.stringify(root)}, ${
      JSON.stringify(`${root}/baseline-denort.log`)
    }, '45']
${prefix}
os.environ['PID_FILE'] = ${JSON.stringify(childPath)}
run([sys.executable, ${JSON.stringify(tool)}], time.monotonic() + 20)
`
    parent = new Deno.Command('/usr/bin/python3', {
      args: ['-c', program],
      clearEnv: true,
      env: { PATH: '/usr/bin:/bin' },
      stdout: 'null',
      stderr: 'null',
    }).spawn()
    await waitForFixture(childPath)
    child = Number((await Deno.readTextFile(childPath)).trim())
    parent.kill('SIGKILL')
    await parent.status
    requireFixture(
      await waitForProcessGone(child),
      'anchor did not clean its owned utility group after parent-loss release EOF',
    )
  } finally {
    if (parent) {
      try {
        parent.kill('SIGKILL')
      } catch { /* already exited */ }
      await parent.status.catch(() => undefined)
    }
    if (child > 0 && !(await processIsGone(child))) {
      try {
        Deno.kill(child, 'SIGKILL')
      } catch { /* fixture cleanup */ }
    }
    await Deno.remove(root, { recursive: true })
  }
})

Deno.test('current build supervisor treats completion EOF as incomplete and reaps its held group', async () => {
  const root = await Deno.makeTempDir({
    prefix: 'slv-supervisor-completion-eof-',
  })
  try {
    const result = await runCurrentSupervisor(
      root,
      'sleep 30 &\nprintf "%s\\n" "$!" > "$CHILD_PID"\nexit 0',
      undefined,
      true,
    )
    const childGone = await waitForProcessGone(result.child)
    requireFixture(
      result.code === 125 && result.elapsed < 3300 && childGone,
      `completion EOF waited on a held anchor or accepted source success: code=${result.code} elapsed=${result.elapsed} childGone=${childGone} stdout=${result.stdout}`,
    )
  } finally {
    await Deno.remove(root, { recursive: true })
  }
})

Deno.test('macOS observer fragment emits bounded live PID/comm-only records before its child exits', async () => {
  const root = await Deno.makeTempDir({ prefix: 'slv-macos-observer-' })
  try {
    const fragment = await recipeFragment(
      '# MACOS_BUILD_OBSERVER_BEGIN',
      '# MACOS_BUILD_OBSERVER_END',
    )
    const program = `${fragment}
sleep 3 & child=$!\n: > "$output/baseline-denort.log"\nstart_macos_build_observer "$child" "$output/baseline-denort.log" 1\nsleep 2\nstop_macos_build_observer "$macos_observer_pid"\nwait "$child"\n`
    const result = await new Deno.Command('/usr/bin/bash', {
      args: ['-euo', 'pipefail', '-c', program],
      clearEnv: true,
      env: {
        PATH: '/usr/bin:/bin',
        PYTHON: '/usr/bin/python3',
        output: root,
        SECRET_CANARY: 'must-not-appear',
      },
      stdout: 'piped',
      stderr: 'piped',
    }).output()
    const output = new TextDecoder().decode(result.stdout)
    const lines = output.split('\n').filter((line) =>
      line.startsWith('SLV_MAC_BUILD_OBSERVATION ')
    )
    requireFixture(
      result.success && lines.length >= 2,
      'observer did not emit initial and periodic live records',
    )
    requireFixture(
      lines.some((line) => line.includes('build-child-start')) &&
        lines.some((line) => line.includes('running')),
      'observer phases were not retained before child completion',
    )
    const terminal = JSON.parse(
      lines.at(-1)!.slice('SLV_MAC_BUILD_OBSERVATION '.length),
    ) as Record<string, unknown>
    requireFixture(
      lines.every((line) => line.length <= 4096) &&
        !output.includes('must-not-appear') &&
        terminal.phase === 'observer-stop' && terminal.cached === true,
      'observer leaked argv/environment data, exceeded its line bound, or sampled after stop',
    )
  } finally {
    await Deno.remove(root, { recursive: true })
  }
})

async function runCurrentMacWorker(
  root: string,
  resume: boolean,
  generateStatus: number,
  assertionStatus: number,
  buildStatus: number,
  markerSinkFailure: false | 'full' | 'closed' = false,
): Promise<{ code: number; markers: string[]; calls: string[] }> {
  const helpers = await lifecycleHelpers()
  const work = `${root}/work`
  const cargo = `${root}/fake-cargo.sh`
  const calls = `${root}/cargo-calls`
  await Deno.mkdir(`${work}/deno`, { recursive: true })
  await Deno.writeTextFile(`${work}/deno/Cargo.lock`, 'fixture lock\n')
  await Deno.writeTextFile(
    cargo,
    `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$CARGO_CALLS"
if [[ "$1" == generate-lockfile ]]; then exit "$GENERATE_STATUS"; fi
exit "$BUILD_STATUS"
`,
  )
  await Deno.chmod(cargo, 0o755)
  const setup = await new Deno.Command('/usr/bin/bash', {
    args: [
      '-u',
      '-o',
      'pipefail',
      '-c',
      `
assert_only_local_v8_relink() { return "$ASSERTION_STATUS"; }
output=${JSON.stringify(root)}
${helpers}
write_macos_cargo_worker
`,
    ],
    clearEnv: true,
    env: {
      PATH: '/usr/bin:/bin',
      ASSERTION_STATUS: String(assertionStatus),
      output: root,
    },
    stdout: 'piped',
    stderr: 'piped',
  }).output()
  requireFixture(
    setup.success,
    `current macOS worker generator failed: ${
      new TextDecoder().decode(setup.stderr)
    }`,
  )
  const worker = new TextDecoder().decode(setup.stdout).trim()
  const workerArgs = [
    `${root}/source-Cargo.lock`,
    work,
    root,
    cargo,
    '4',
    String(resume),
  ]
  const result = markerSinkFailure === 'full'
    ? await new Deno.Command('/usr/bin/bash', {
      args: [
        '-c',
        '"$1" "$2" "$3" "$4" "$5" "$6" "$7" > /dev/full',
        'bash',
        worker,
        ...workerArgs,
      ],
      clearEnv: true,
      env: {
        PATH: '/usr/bin:/bin',
        ASSERTION_STATUS: String(assertionStatus),
        BUILD_STATUS: String(buildStatus),
        CARGO_CALLS: calls,
        GENERATE_STATUS: String(generateStatus),
      },
      stdout: 'piped',
      stderr: 'piped',
    }).output()
    : markerSinkFailure === 'closed'
    ? await new Deno.Command('/usr/bin/python3', {
      args: [
        '-c',
        'import subprocess,sys; child=subprocess.Popen(sys.argv[1:],stdout=subprocess.PIPE,stderr=subprocess.PIPE); child.stdout.readline(); child.stdout.close(); child.wait(timeout=2); print(child.returncode)',
        worker,
        ...workerArgs,
      ],
      clearEnv: true,
      env: {
        PATH: '/usr/bin:/bin',
        ASSERTION_STATUS: String(assertionStatus),
        BUILD_STATUS: String(buildStatus),
        CARGO_CALLS: calls,
        GENERATE_STATUS: String(generateStatus),
      },
      stdout: 'piped',
      stderr: 'piped',
    }).output()
    : await new Deno.Command(worker, {
      args: workerArgs,
      clearEnv: true,
      env: {
        PATH: '/usr/bin:/bin',
        ASSERTION_STATUS: String(assertionStatus),
        BUILD_STATUS: String(buildStatus),
        CARGO_CALLS: calls,
        GENERATE_STATUS: String(generateStatus),
      },
      stdout: 'piped',
      stderr: 'piped',
    }).output()
  const output = new TextDecoder().decode(result.stdout)
  const recorded = await Deno.readTextFile(calls).catch(() => '')
  return {
    code: markerSinkFailure === 'closed' ? Number(output.trim()) : result.code,
    markers: output.split('\n').filter((line) =>
      line.startsWith('SLV_MAC_BUILD_PHASE ')
    ),
    calls: recorded === '' ? [] : recorded.trimEnd().split('\n'),
  }
}

Deno.test('current macOS fixed worker records sparse real command boundaries without replacing source status', async () => {
  const root = await Deno.makeTempDir({ prefix: 'slv-macos-worker-phases-' })
  try {
    const fresh = await runCurrentMacWorker(root + '/fresh', false, 0, 0, 0)
    const lockFailure = await runCurrentMacWorker(
      root + '/lock',
      false,
      37,
      0,
      0,
    )
    const validationFailure = await runCurrentMacWorker(
      root + '/validation',
      false,
      0,
      41,
      0,
    )
    const resume = await runCurrentMacWorker(root + '/resume', true, 0, 0, 37)
    const brokenMarkerSink = await runCurrentMacWorker(
      root + '/broken-marker-sink',
      false,
      37,
      0,
      0,
      'full',
    )
    const closedMarkerReader = await runCurrentMacWorker(
      root + '/closed-marker-reader',
      true,
      0,
      0,
      37,
      'closed',
    )
    requireFixture(
      fresh.code === 0 &&
        JSON.stringify(fresh.markers) ===
          JSON.stringify([
            'SLV_MAC_BUILD_PHASE lock-generate-start',
            'SLV_MAC_BUILD_PHASE lock-generate-finished',
            'SLV_MAC_BUILD_PHASE lock-validation-start',
            'SLV_MAC_BUILD_PHASE lock-validation-finished',
            'SLV_MAC_BUILD_PHASE cargo-build-start',
            'SLV_MAC_BUILD_PHASE cargo-build-finished',
          ]) &&
        fresh.calls.length === 2,
      'fresh worker did not retain the real lock/Cargo marker order',
    )
    requireFixture(
      lockFailure.code === 37 &&
        JSON.stringify(lockFailure.markers) ===
          JSON.stringify([
            'SLV_MAC_BUILD_PHASE lock-generate-start',
            'SLV_MAC_BUILD_PHASE lock-generate-finished',
          ]) &&
        lockFailure.calls.length === 1,
      'lock failure marker replaced status or started a later phase',
    )
    requireFixture(
      validationFailure.code === 41 &&
        JSON.stringify(validationFailure.markers) ===
          JSON.stringify([
            'SLV_MAC_BUILD_PHASE lock-generate-start',
            'SLV_MAC_BUILD_PHASE lock-generate-finished',
            'SLV_MAC_BUILD_PHASE lock-validation-start',
            'SLV_MAC_BUILD_PHASE lock-validation-finished',
          ]) &&
        validationFailure.calls.length === 1,
      'validation failure marker replaced status or started Cargo',
    )
    requireFixture(
      brokenMarkerSink.code === 37 && brokenMarkerSink.calls.length === 1 &&
        closedMarkerReader.code === 37 && closedMarkerReader.calls.length === 1,
      'failed marker output replaced the saved lock source status',
    )
    requireFixture(
      resume.code === 37 &&
        JSON.stringify(resume.markers) ===
          JSON.stringify([
            'SLV_MAC_BUILD_PHASE cargo-build-start',
            'SLV_MAC_BUILD_PHASE cargo-build-finished',
          ]) &&
        resume.calls.length === 1,
      'resume worker emitted fresh-only markers or changed its Cargo status',
    )
  } finally {
    await Deno.remove(root, { recursive: true })
  }
})

Deno.test('current observer retains newest bounded Ninja completion, sparse log phase, subtree scope, and raw host units', async () => {
  const root = await Deno.makeTempDir({ prefix: 'slv-macos-observer-b2-' })
  try {
    const prefix = await observerPythonPrefix()
    const ninja = `${root}/target/release/gn_out/.ninja_log`
    const log = `${root}/baseline-denort.log`
    await Deno.mkdir(`${root}/target/release/gn_out`, { recursive: true })
    await Deno.writeFile(
      ninja,
      new TextEncoder().encode(
        `${
          'x'.repeat(4097)
        }\n0\t10\t100\told/object.o\thash\n11\t20\t101\tnew/object.o\thash\npartial`,
      ),
    )
    await Deno.writeTextFile(
      log,
      'Cargo output\nSLV_MAC_BUILD_PHASE lock-generate-start\nSLV_MAC_BUILD_PHASE cargo-build-start\n',
    )
    const program = `
import json, os, sys, time
sys.argv = ['observer', '900', ${JSON.stringify(root)}, ${
      JSON.stringify(log)
    }, '45']
${prefix}
observer = os.getpid()
def source_run(argv, deadline, out_limit=8192, err_limit=1024):
    if argv[0] == '/bin/ps':
        rows = '\\n'.join([
            '900 1 1.0 10 supervisor',
            '901 900 2.0 20 cargo',
            str(observer)+' 900 99.0 99 observer-canary',
            '902 '+str(observer)+' 88.0 88 utility-canary',
            '990 1 77.0 77 foreign-sibling',
        ])
        return {'ok': True, 'stdout': rows}
    if argv[0] == '/usr/bin/vm_stat':
        return {'ok': True, 'stdout': 'Mach Virtual Memory Statistics: (page size of 4096 bytes)\\nPages free: 12.\\nPages active: 34.\\nPageins: 5.\\nSwapouts: 6.\\n'}
    if argv[-1] == 'hw.memsize': return {'ok': True, 'stdout': '8192\\n'}
    if argv[-1] == 'vm.swapusage': return {'ok': True, 'stdout': 'total = 2.00G  used = 1.00G  free = 1.00G'}
    raise AssertionError(argv)
run = source_run
print(json.dumps({'phase': phase_marker(), 'tree': process_tree(time.monotonic()+1), 'memory': memory(time.monotonic()+1), 'progress': progress()}, sort_keys=True))
`
    const result = await new Deno.Command('/usr/bin/python3', {
      args: ['-c', program],
      clearEnv: true,
      env: { PATH: '/usr/bin:/bin' },
      stdout: 'piped',
      stderr: 'piped',
    }).output()
    requireFixture(
      result.success,
      `current B2 observer seam failed: ${
        new TextDecoder().decode(result.stderr)
      }`,
    )
    const value = JSON.parse(new TextDecoder().decode(result.stdout)) as {
      phase: { available?: boolean; last_observed?: string }
      tree: {
        selected_count?: number
        parsed_count?: number
        rejected_count?: number
        cpu_percent_ps_sum?: number
        rss_sum_bytes?: number
        processes?: Array<{ basename?: string }>
      }
      memory: {
        vm_stat?: {
          page_size_bytes?: number
          counters?: Record<string, number>
        }
        swap?: {
          quality?: string
          fields?: Record<string, { unit?: string; bytes?: number }>
        }
      }
      progress: {
        available?: boolean
        quality?: string
        latest_complete?: { output_basename?: string; end_time_ms?: number }
      }
    }
    requireFixture(
      value.phase.available &&
        value.phase.last_observed === 'cargo-build-start' &&
        value.progress.available && value.progress.quality === 'partial' &&
        value.progress.latest_complete?.output_basename === 'object.o' &&
        value.progress.latest_complete.end_time_ms === 20,
      'bounded Ninja/log tail lost the newest complete row or inferred an execution state',
    )
    requireFixture(
      value.tree.selected_count === 2 && value.tree.parsed_count === 5 &&
        value.tree.rejected_count === 0 &&
        value.tree.cpu_percent_ps_sum === 3 &&
        value.tree.rss_sum_bytes === 30 * 1024 &&
        value.tree.processes?.every((row) =>
          row.basename !== 'observer-canary' &&
          row.basename !== 'utility-canary' &&
          row.basename !== 'foreign-sibling'
        ),
      'supplied supervisor subtree did not exclude the observer utility branch or aggregate all selected rows',
    )
    requireFixture(
      value.memory.vm_stat?.page_size_bytes === 4096 &&
        value.memory.vm_stat.counters?.pageins === 5 &&
        value.memory.vm_stat.counters?.swapouts === 6 &&
        value.memory.swap?.quality === 'complete' &&
        value.memory.swap.fields?.total?.unit === 'G' &&
        value.memory.swap.fields.total.bytes === 2 * 1024 * 1024 * 1024,
      'raw vm_stat/swap parser lost units or invented a counter interpretation',
    )
  } finally {
    await Deno.remove(root, { recursive: true })
  }
})

Deno.test('current observer leaves out-of-window Ninja history unavailable and retains partial swap facts', async () => {
  const root = await Deno.makeTempDir({ prefix: 'slv-macos-observer-window-' })
  try {
    const prefix = await observerPythonPrefix()
    const ninja = `${root}/target/release/gn_out/.ninja_log`
    await Deno.mkdir(`${root}/target/release/gn_out`, { recursive: true })
    await Deno.writeFile(
      ninja,
      new TextEncoder().encode(
        '0\\t10\\t100\\toutside.o\\thash\\n' + 'x'.repeat(5000),
      ),
    )
    const program = `
import json, sys, time
sys.argv = ['observer', '900', ${JSON.stringify(root)}, ${
      JSON.stringify(`${root}/log`)
    }, '45']
${prefix}
def source_run(argv, deadline, out_limit=8192, err_limit=1024):
    if argv[0] == '/usr/bin/vm_stat': return {'ok': True, 'stdout': 'Mach Virtual Memory Statistics: (page size of 4096 bytes)\\n'}
    if argv[-1] == 'hw.memsize': return {'ok': False, 'reason': 'missing-memsize'}
    if argv[-1] == 'vm.swapusage': return {'ok': True, 'stdout': 'total = 2.00G  used = 1.00G'}
    raise AssertionError(argv)
run = source_run
print(json.dumps({'phase': phase_marker(), 'progress': progress(), 'memory': memory(time.monotonic()+1)}, sort_keys=True))
`
    const result = await new Deno.Command('/usr/bin/python3', {
      args: ['-c', program],
      clearEnv: true,
      env: { PATH: '/usr/bin:/bin' },
      stdout: 'piped',
      stderr: 'piped',
    }).output()
    requireFixture(
      result.success,
      `current bounded window seam failed: ${
        new TextDecoder().decode(result.stderr)
      }`,
    )
    const value = JSON.parse(new TextDecoder().decode(result.stdout)) as {
      phase: { available?: boolean; quality?: string; reason?: string }
      progress: { available?: boolean; quality?: string; size_bytes?: number }
      memory: {
        vm_stat?: {
          available?: boolean
          quality?: string
          page_size_bytes?: number
        }
        physical_memory_bytes?: number | null
        physical_memory_reason?: string
        swap?: {
          available?: boolean
          quality?: string
          fields?: Record<string, unknown>
        }
      }
    }
    requireFixture(
      value.progress.available === false &&
        value.progress.quality === 'partial' &&
        typeof value.progress.size_bytes === 'number',
      'observer scanned outside its bounded Ninja tail or hid available stat facts',
    )
    requireFixture(
      value.memory.vm_stat?.available &&
        value.memory.vm_stat.quality === 'partial' &&
        value.memory.vm_stat.page_size_bytes === 4096 &&
        value.memory.physical_memory_bytes === null &&
        value.memory.physical_memory_reason === 'missing-memsize' &&
        value.memory.swap?.available &&
        value.memory.swap.quality === 'partial' &&
        Object.keys(value.memory.swap.fields ?? {}).length === 3 &&
        (value.memory.swap.fields?.total as { available?: boolean } | undefined)
            ?.available === true &&
        (value.memory.swap.fields?.used as { available?: boolean } | undefined)
            ?.available === true &&
        (value.memory.swap.fields?.free as { available?: boolean } | undefined)
            ?.available === false,
      'partial host observations discarded known page/swap facts or defaulted absence to zero',
    )
  } finally {
    await Deno.remove(root, { recursive: true })
  }
})

Deno.test('current observer trims oversized detail without losing coordinates or suppressing the next sample', async () => {
  const prefix = await observerPythonPrefix()
  const program = `
import io, json, os, sys
sys.argv = ['observer', '900', '/tmp', '/tmp/missing-log', '45']
${prefix}
def phase_marker(): return {'available': True, 'quality': 'complete', 'last_observed': 'cargo-build-start'}
def process_tree(deadline): return {'available': True, 'scope': 'supplied-supervisor-and-observable-descendants', 'scope_quality': 'complete', 'parse_quality': 'complete', 'selected_count': 64, 'parsed_count': 64, 'rejected_count': 0, 'cpu_percent_ps_sum': 64.0, 'rss_sum_bytes': 65536, 'processes': [{'pid': i, 'basename': 'x'*400, 'rss_bytes': i, 'cpu_percent_ps': 1.0} for i in range(64)]}
def memory(deadline): return {'units': {'pages':'reported-pages','memory':'bytes'}, 'vm_stat': {'available': True, 'quality': 'complete', 'page_size_bytes': 4096, 'page_counts': {'active': 1}, 'counters': {}}, 'physical_memory_bytes': 8192, 'swap': {'available': True, 'quality': 'complete', 'fields': {'total': {'value': 1, 'unit':'G', 'bytes': 1073741824}}}}
def progress(): return {'available': True, 'exists': True, 'size_bytes': 1, 'mtime_epoch_seconds': 1, 'quality': 'complete', 'latest_complete': {'start_time_ms': 0, 'end_time_ms': 1, 'restat_mtime': 1, 'output_basename': 'y'*10000}}
emit('running')
emit('running')
`
  const result = await new Deno.Command('/usr/bin/python3', {
    args: ['-c', program],
    clearEnv: true,
    env: { PATH: '/usr/bin:/bin' },
    stdout: 'piped',
    stderr: 'piped',
  }).output()
  requireFixture(
    result.success,
    `current trim seam failed: ${new TextDecoder().decode(result.stderr)}`,
  )
  const lines = new TextDecoder().decode(result.stdout).trimEnd().split('\n')
  const records = lines.map((line) => {
    requireFixture(
      line.startsWith('SLV_MAC_BUILD_OBSERVATION '),
      'trim seam emitted a non-observation line',
    )
    requireFixture(
      new TextEncoder().encode(line).length <= 4096,
      'trim seam exceeded UTF-8 record budget',
    )
    return JSON.parse(
      line.slice('SLV_MAC_BUILD_OBSERVATION '.length),
    ) as Record<string, unknown>
  })
  requireFixture(
    records.length === 2 &&
      records.every((record) =>
        record.trimmed === true && record.root_pid === 900 &&
        typeof record.utc === 'string' &&
        typeof record.elapsed_seconds_monotonic === 'number' &&
        record.phase === 'running'
      ),
    'oversized detail replaced primary coordinates or suppressed the next sample',
  )
})

Deno.test('current observer rejects partial markers and malformed parser rows without replacing valid observations', async () => {
  const root = await Deno.makeTempDir({
    prefix: 'slv-macos-observer-validity-',
  })
  try {
    const prefix = await observerPythonPrefix()
    const ninja = `${root}/target/release/gn_out/.ninja_log`
    const log = `${root}/baseline-denort.log`
    await Deno.mkdir(`${root}/target/release/gn_out`, { recursive: true })
    await Deno.writeTextFile(
      ninja,
      '1\t2\t3\tvalid.o\thash\n30\t40\t5\tmissing-hash.o\n',
    )
    await Deno.writeTextFile(
      log,
      'SLV_MAC_BUILD_PHASE cargo-build-start\nSLV_MAC_BUILD_PHASE cargo-build-finished',
    )
    const program = `
import json, os, sys, time
sys.argv = ['observer', '100', ${JSON.stringify(root)}, ${
      JSON.stringify(log)
    }, '45']
${prefix}
def ps(rows):
    return lambda argv, *args, **kwargs: {'ok': True, 'stdout': rows} if argv[0] == '/bin/ps' else {'ok': True, 'stdout': 'page size of 4096 bytes\\nPages free: 2.\\n' if argv[0].endswith('vm_stat') else ('1234' if argv[-1] == 'hw.memsize' else 'total = 2..0M used = 1.0M free = 1.0M')}
rows = '100 1 1.0 10 supervisor\\n101 100 2.0 20 anchor\\n102 101 3.0 30 worker\\n103 102 NaN 40 malformed'
run = ps(rows)
phase = phase_marker()
missing_hash = progress()
with open(${
      JSON.stringify(ninja)
    }, 'wb') as source: source.write(b'1\\t2\\t3\\tvalid.o\\thash\\n90\\t80\\t5\\treverse.o\\thash\\n')
reverse_time = progress()
print(json.dumps({'phase': phase, 'missing_hash': missing_hash, 'reverse_time': reverse_time, 'tree': process_tree(time.monotonic()+1), 'memory': memory(time.monotonic()+1)}, sort_keys=True, allow_nan=False))
`
    const result = await new Deno.Command('/usr/bin/python3', {
      args: ['-c', program],
      clearEnv: true,
      env: { PATH: '/usr/bin:/bin' },
      stdout: 'piped',
      stderr: 'piped',
    }).output()
    requireFixture(
      result.success,
      `current parser validity seam failed: ${
        new TextDecoder().decode(result.stderr)
      }`,
    )
    const value = JSON.parse(new TextDecoder().decode(result.stdout)) as {
      phase: { quality?: string; last_observed?: string; reason?: string }
      missing_hash: {
        quality?: string
        latest_complete?: { output_basename?: string }
      }
      reverse_time: {
        quality?: string
        latest_complete?: { output_basename?: string }
      }
      tree: {
        parse_quality?: string
        selected_count?: number
        rejected_count?: number
        cpu_percent_ps_sum?: number
      }
      memory: {
        swap?: {
          quality?: string
          fields?: Record<string, { available?: boolean; reason?: string }>
        }
      }
    }
    requireFixture(
      value.phase.quality === 'partial' &&
        value.phase.last_observed === 'cargo-build-start' &&
        value.phase.reason === 'log-tail-partial',
      'unterminated marker advanced a completed command boundary',
    )
    requireFixture(
      value.missing_hash.quality === 'partial' &&
        value.missing_hash.latest_complete?.output_basename === 'valid.o' &&
        value.reverse_time.quality === 'partial' &&
        value.reverse_time.latest_complete?.output_basename === 'valid.o',
      'invalid Ninja completion row displaced the latest complete bounded row',
    )
    requireFixture(
      value.tree.parse_quality === 'partial' &&
        value.tree.selected_count === 3 && value.tree.rejected_count === 1 &&
        value.tree.cpu_percent_ps_sum === 6,
      'nonfinite CPU row was not rejected while retaining valid subtree totals',
    )
    requireFixture(
      value.memory.swap?.quality === 'partial' &&
        value.memory.swap.fields?.total?.available === false &&
        value.memory.swap.fields?.total?.reason === 'value-parse' &&
        value.memory.swap.fields?.used?.available === true &&
        value.memory.swap.fields?.free?.available === true,
      'malformed swap field aborted observation or discarded valid fields',
    )
  } finally {
    await Deno.remove(root, { recursive: true })
  }
})
