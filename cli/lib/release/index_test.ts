import {
  assertEquals,
  assertRejects,
  assertStringIncludes,
  assertThrows,
} from '@std/assert'
import {
  compareCalVer,
  releaseEngineText,
  runReleaseEngine,
} from '/lib/release/index.ts'

const decoder = new TextDecoder()

async function runBridgeSmokeFixture(
  name: string,
  mutate: (source: string) => string,
  tmpdir?: string,
): Promise<{ result: Deno.CommandOutput; output: string }> {
  const root = await Deno.makeTempDir({
    prefix: `slv-release-bridge-${name}-`,
  })
  try {
    const source = mutate(
      await Deno.readTextFile(
        new URL('./compiled_bridge_smoke.ts', import.meta.url),
      ),
    ).replace(
      "from '/lib/release/index.ts'",
      `from ${JSON.stringify(new URL('./index.ts', import.meta.url).href)}`,
    )
    const probe = `${root}/compiled_bridge_smoke.ts`
    await Deno.writeTextFile(probe, source)
    const result = await new Deno.Command(Deno.execPath(), {
      args: [
        'run',
        '--quiet',
        '--frozen',
        '--config',
        new URL('../../deno.json', import.meta.url).pathname,
        '--allow-read',
        '--allow-write',
        '--allow-run',
        '--allow-env',
        probe,
      ],
      cwd: Deno.cwd(),
      ...(tmpdir === undefined ? {} : { env: { TMPDIR: tmpdir } }),
      stdout: 'piped',
      stderr: 'piped',
    }).output()
    return {
      result,
      output: decoder.decode(result.stdout) + decoder.decode(result.stderr),
    }
  } finally {
    await Deno.remove(root, { recursive: true })
  }
}

Deno.test('release engine is an embedded, runnable Python asset', async () => {
  const engine = await releaseEngineText()
  assertStringIncludes(engine, 'Verified immutable SLV release consumer')
  assertStringIncludes(engine, "parser.add_argument('--bootstrap-version')")
  const child = new Deno.Command('python3', {
    args: ['-I', '-', '--help'],
    stdin: 'piped',
    stdout: 'piped',
    stderr: 'piped',
  }).spawn()
  const writer = child.stdin.getWriter()
  await writer.write(new TextEncoder().encode(engine))
  await writer.close()
  const result = await child.output()
  assertEquals(result.code, 0)
  assertStringIncludes(
    new TextDecoder().decode(result.stdout),
    'immutable-release consumer',
  )
})

Deno.test('CalVer comparison rejects noncanonical or impossible UTC timestamps', () => {
  assertEquals(compareCalVer('2026.6.7.0001', '2026.6.7.0002'), -1)
  assertThrows(() => compareCalVer('2026.06.7.0001', '2026.6.7.0002'))
  assertThrows(() => compareCalVer('2026.2.29.0001', '2026.3.1.0001'))
})

Deno.test('Deno release bridge isolates Python from a caller cwd shadow', async () => {
  const original = Deno.cwd()
  const attacker = await Deno.makeTempDir()
  try {
    await Deno.writeTextFile(
      `${attacker}/argparse.py`,
      "from pathlib import Path\nPath('shadow-ran').write_text('bad')\nraise RuntimeError('shadow')\n",
    )
    Deno.chdir(attacker)
    assertStringIncludes(
      await runReleaseEngine(['--help']),
      'immutable-release consumer',
    )
    await assertRejects(
      () => Deno.stat(`${attacker}/shadow-ran`),
      Deno.errors.NotFound,
    )
  } finally {
    Deno.chdir(original)
    await Deno.remove(attacker, { recursive: true })
  }
})

Deno.test('compiled bridge smoke keeps only declared and shell-created environment keys', async () => {
  const source = await runBridgeSmokeFixture('sh', (value) => value)
  const bash = await runBridgeSmokeFixture(
    'bash',
    (value) => value.replace("'#!/bin/sh'", "'#!/bin/bash'"),
  )
  for (const [name, probe] of Object.entries({ source, bash })) {
    if (!probe.result.success) {
      throw new Error(`${name} bridge smoke failed: ${probe.output}`)
    }
    assertStringIncludes(probe.output, 'release bridge smoke passed (source)')
  }

  const tempParent = await Deno.makeTempDir({
    prefix: 'slv-release-bridge-symlink-parent-',
  })
  const linkedParent = `${tempParent}/linked`
  await Deno.symlink(tempParent, linkedParent)
  try {
    const linkedSource = await runBridgeSmokeFixture(
      'sh-symlinked-tmpdir',
      (value) => value,
      linkedParent,
    )
    const linkedBash = await runBridgeSmokeFixture(
      'bash-symlinked-tmpdir',
      (value) => value.replace("'#!/bin/sh'", "'#!/bin/bash'"),
      linkedParent,
    )
    for (const [name, probe] of Object.entries({ linkedSource, linkedBash })) {
      if (!probe.result.success) {
        throw new Error(`${name} bridge smoke failed: ${probe.output}`)
      }
      assertStringIncludes(probe.output, 'release bridge smoke passed (source)')
    }
  } finally {
    await Deno.remove(tempParent, { recursive: true })
  }

  const callerValue = 'caller-value-must-not-appear'
  const callerCanary = await runBridgeSmokeFixture(
    'caller-canary',
    (value) =>
      value.replace(
        "    'set -eu',",
        `    'set -eu',\n    'export SLV_RELEASE_BRIDGE_CANARY=${callerValue}',`,
      ),
  )
  if (callerCanary.result.success) {
    throw new Error('caller canary unexpectedly passed bridge isolation')
  }
  assertStringIncludes(
    callerCanary.output,
    'release bridge leaked caller environment: SLV_RELEASE_BRIDGE_CANARY',
  )
  if (callerCanary.output.includes(callerValue)) {
    throw new Error('caller canary value leaked through bridge diagnostics')
  }

  const invalidValue = 'invalid-shlvl-must-not-appear'
  const invalidShellValue = await runBridgeSmokeFixture(
    'invalid-shlvl',
    (value) =>
      value.replace(
        "    'set -eu',",
        `    'set -eu',\n    'export SHLVL=${invalidValue}',`,
      ),
  )
  if (invalidShellValue.result.success) {
    throw new Error('invalid shell-created value unexpectedly passed')
  }
  assertStringIncludes(
    invalidShellValue.output,
    'release bridge changed shell-created environment: SHLVL',
  )
  if (invalidShellValue.output.includes(invalidValue)) {
    throw new Error('shell-created value leaked through bridge diagnostics')
  }
})
