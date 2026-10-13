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
