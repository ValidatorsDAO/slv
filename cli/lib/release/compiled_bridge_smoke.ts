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
const originalCwd = Deno.cwd()
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
    `/usr/bin/env > ${shellQuote(envPath)}`,
    `cat > ${shellQuote(stdinPath)}`,
    `exec ${shellQuote(decoder.decode(realPython.stdout).trim())} \"$@\" < ${
      shellQuote(stdinPath)
    }`,
  ].join('\n') + '\n'
  await Deno.writeTextFile(python, shim, { mode: 0o755 })
  await Deno.chmod(python, 0o755)
  Deno.chdir(root)
  const childCwd = Deno.cwd()
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
  const captured = new Map(
    decoder.decode(await Deno.readFile(envPath)).split('\n').filter(Boolean)
      .map((entry) => {
        const separator = entry.indexOf('=')
        return [entry.slice(0, separator), entry.slice(separator + 1)]
      }),
  )
  const declared = new Map<string, string | undefined>()
  declared.set('HOME', Deno.env.get('HOME'))
  declared.set('PATH', Deno.env.get('PATH'))
  const temp = Deno.env.get('TMPDIR')
  if (temp !== undefined) declared.set('TMPDIR', temp)
  if (captured.has('SLV_RELEASE_BRIDGE_CALLER_SENTINEL')) {
    throw new Error('release bridge leaked caller sentinel')
  }
  for (const [name, value] of captured) {
    if (declared.has(name)) {
      if (value !== declared.get(name)) {
        throw new Error(`release bridge changed declared environment: ${name}`)
      }
      continue
    }
    if (name === 'PWD') {
      if (value !== childCwd) {
        throw new Error('release bridge changed shell-created environment: PWD')
      }
      continue
    }
    if (name === 'SHLVL') {
      if (value !== '1') {
        throw new Error(
          'release bridge changed shell-created environment: SHLVL',
        )
      }
      continue
    }
    if (name === '_') {
      if (value !== '/usr/bin/env') {
        throw new Error('release bridge changed shell-created environment: _')
      }
      continue
    }
    throw new Error(`release bridge leaked caller environment: ${name}`)
  }
  console.log(
    `release bridge smoke passed (${
      Deno.build.standalone ? 'compiled' : 'source'
    })`,
  )
} finally {
  Deno.chdir(originalCwd)
  Deno.env.set('PATH', originalPath)
  Deno.env.delete('SLV_RELEASE_BRIDGE_CALLER_SENTINEL')
  await Deno.remove(root, { recursive: true })
}
