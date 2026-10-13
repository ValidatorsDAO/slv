/**
 * Runs as both a Deno source program and a compiled executable. The local
 * python3 shim records the bridge process contract before forwarding its
 * embedded engine source to the real isolated interpreter.
 */
import { releaseEngineText, runReleaseEngine } from '/lib/release/index.ts'

const shellQuote = (value: string): string =>
  `'${value.replaceAll("'", "'\\\"'\\\"'")}'`
const decoder = new TextDecoder()
const root = await Deno.makeTempDir({ prefix: 'slv-compiled-release-bridge-' })
const originalPath = Deno.env.get('PATH')
if (!originalPath) throw new Error('PATH is required for compiled bridge smoke')
const realPython = await new Deno.Command('sh', {
  args: ['-c', 'command -v python3'],
  stdout: 'piped',
}).output()
if (!realPython.success) {
  throw new Error('python3 is required for compiled bridge smoke')
}

const bin = `${root}/bin`
const argsPath = `${root}/args`
const envPath = `${root}/env`
const stdinPath = `${root}/engine.py`
try {
  await Deno.mkdir(bin)
  const python = `${bin}/python3`
  const shim = [
    '#!/bin/sh',
    'set -eu',
    `printf '%s\\n' \"$@\" > ${shellQuote(argsPath)}`,
    `env > ${shellQuote(envPath)}`,
    `cat > ${shellQuote(stdinPath)}`,
    `exec ${shellQuote(decoder.decode(realPython.stdout).trim())} \"$@\" < ${
      shellQuote(stdinPath)
    }`,
  ].join('\n') + '\n'
  await Deno.writeTextFile(python, shim, { mode: 0o755 })
  await Deno.chmod(python, 0o755)
  Deno.env.set('PATH', `${bin}:${originalPath}`)
  Deno.env.set('SLV_RELEASE_BRIDGE_CALLER_SENTINEL', 'must-not-reach-python')

  const expectedEngine = await releaseEngineText()
  const output = await runReleaseEngine(['--help'])
  if (!output.includes('immutable-release consumer')) {
    throw new Error('release bridge did not execute its embedded engine')
  }
  if (await Deno.readTextFile(stdinPath) !== expectedEngine) {
    throw new Error('compiled bridge did not supply the embedded engine bytes')
  }
  const capturedArgs = await Deno.readTextFile(argsPath)
  if (capturedArgs !== '-I\n-\n--help\n') {
    throw new Error(
      `release bridge did not invoke python3 -I - with the requested args: ${
        JSON.stringify(capturedArgs)
      }`,
    )
  }
  // POSIX sh supplies PWD itself; every other caller value must remain absent.
  const allowedEnv = new Set(['HOME', 'PATH', 'PWD', 'TMPDIR'])
  const inherited = decoder.decode(await Deno.readFile(envPath)).split('\n')
    .filter(Boolean).map((entry) => entry.slice(0, entry.indexOf('=')))
  if (inherited.some((name) => !allowedEnv.has(name))) {
    throw new Error(
      `release bridge leaked caller environment: ${inherited.join(', ')}`,
    )
  }
  console.log(
    `release bridge smoke passed (${
      Deno.build.standalone ? 'compiled' : 'source'
    })`,
  )
} finally {
  Deno.env.set('PATH', originalPath)
  Deno.env.delete('SLV_RELEASE_BRIDGE_CALLER_SENTINEL')
  await Deno.remove(root, { recursive: true })
}
