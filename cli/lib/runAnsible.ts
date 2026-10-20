import type { InventoryType } from '@cmn/types/config.ts'
import { getInventoryPath } from '@cmn/constants/path.ts'
import {
  enforceAllHostsGuard,
  type ExtraVars,
  type GuardDeps,
} from '/lib/targetGuard.ts'

type RunAnsibleResult = {
  success: boolean
  code: number
  stdout: string
  stderr: string
  output: string
  /** Set when the run was stopped before ansible started. */
  refused?: 'non-interactive' | 'declined' | 'unresolved'
}

type AnsibleSpawnResult = {
  success: boolean
  code: number
  stdout: Uint8Array
  stderr: Uint8Array
  /** The real runner already forwarded these bytes to the operator. */
  streamed?: boolean
}

type AnsibleSpawn = (args: string[]) => Promise<AnsibleSpawnResult>

type RunAnsibleOptions = {
  /** The caller already listed every host of the group and got an explicit yes. */
  allHostsConfirmed?: boolean
  /** Replaces the terminal, environment and prompt the all-hosts guard uses. */
  guard?: Partial<GuardDeps>
  /** Replaces the ansible-playbook process. */
  spawn?: AnsibleSpawn
}

type OutputSink = (chunk: Uint8Array) => Promise<void>

const writeAll = async (
  writer: { write: (bytes: Uint8Array) => Promise<number> },
  chunk: Uint8Array,
): Promise<void> => {
  let offset = 0
  while (offset < chunk.length) {
    const written = await writer.write(chunk.subarray(offset))
    if (written <= 0) throw new Error('Output stream closed')
    offset += written
  }
}

/** Forward both streams concurrently, retaining the complete result for callers. */
export const streamProcess = async (
  command: string,
  args: string[],
  stdoutSink: OutputSink = (chunk) => writeAll(Deno.stdout, chunk),
  stderrSink: OutputSink = (chunk) => writeAll(Deno.stderr, chunk),
): Promise<AnsibleSpawnResult> => {
  const child = new Deno.Command(command, {
    args,
    // Preserve the prior runner's closed stdin. SSH agent approval still uses
    // the operator's terminal, and no new password prompt is introduced here.
    stdin: 'null',
    stdout: 'piped',
    stderr: 'piped',
    env: { PYTHONUNBUFFERED: '1' },
  }).spawn()
  const pump = async (stream: ReadableStream<Uint8Array>, sink: OutputSink) => {
    const chunks: Uint8Array[] = []
    let size = 0
    let forward = true
    for await (const chunk of stream) {
      chunks.push(chunk)
      size += chunk.length
      if (forward) {
        try {
          await sink(chunk)
        } catch {
          // A closed UI/pipe must not abort a remote operation or leave the
          // other pipe undrained. Its result remains available to the caller.
          forward = false
        }
      }
    }
    const all = new Uint8Array(size)
    let offset = 0
    for (const chunk of chunks) {
      all.set(chunk, offset)
      offset += chunk.length
    }
    return all
  }
  const [status, stdout, stderr] = await Promise.all([
    child.status,
    pump(child.stdout, stdoutSink),
    pump(child.stderr, stderrSink),
  ])
  return {
    success: status.success,
    code: status.code,
    stdout,
    stderr,
    streamed: true,
  }
}

const spawnAnsible: AnsibleSpawn = (args) =>
  streamProcess('ansible-playbook', args)

const shellQuote = (value: string) => {
  if (/^[A-Za-z0-9_./:-]+$/.test(value)) {
    return value
  }
  return JSON.stringify(value)
}

const buildAnsibleArgs = (
  filePath: string,
  inventoryType: InventoryType,
  limit?: string,
  extraVars?: ExtraVars,
) => {
  const args = [
    '-i',
    getInventoryPath(inventoryType),
    filePath,
    '--limit',
    limit || inventoryType,
  ]
  if (extraVars && Object.keys(extraVars).length > 0) {
    args.push('--extra-vars', JSON.stringify(extraVars))
  }
  return args
}

const runAnsibleCapture = async (
  filePath: string,
  inventoryType: InventoryType,
  limit?: string, // Identity account
  extraVars?: ExtraVars,
  options: RunAnsibleOptions = {},
): Promise<RunAnsibleResult> => {
  const verdict = await enforceAllHostsGuard({
    playbook: filePath,
    inventoryType,
    limit,
    extraVars,
    allHostsConfirmed: options.allHostsConfirmed,
  }, options.guard)
  if (!verdict.proceed) {
    const message = `Not run: ${verdict.reason}`
    return {
      success: false,
      code: 1,
      stdout: '',
      stderr: message,
      output: message,
      refused: verdict.reason,
    }
  }

  const args = buildAnsibleArgs(filePath, inventoryType, limit, extraVars)
  console.log(
    `🚀 Running ansible: ansible-playbook ${args.map(shellQuote).join(' ')}`,
  )

  try {
    const result = await (options.spawn ?? spawnAnsible)(args)

    const stdout = new TextDecoder().decode(result.stdout)
    const stderr = new TextDecoder().decode(result.stderr)
    if (!result.streamed) {
      if (stdout) console.log(stdout)
      if (stderr) console.error(stderr)
    }

    return {
      success: result.success,
      code: result.code,
      stdout,
      stderr,
      output: `${stdout}\n${stderr}`.trim(),
    }
  } catch (error) {
    console.error(
      `❌ Failed to run ansible-playbook: ${
        error instanceof Error ? error.message : String(error)
      }`,
    )
    return {
      success: false,
      code: 1,
      stdout: '',
      stderr: String(error),
      output: String(error),
    }
  }
}

const runAnsilbe = async (
  filePath: string,
  inventoryType: InventoryType,
  limit?: string, // Identity account
  extraVars?: ExtraVars,
  options: RunAnsibleOptions = {},
) => {
  const result = await runAnsibleCapture(
    filePath,
    inventoryType,
    limit,
    extraVars,
    options,
  )
  if (result.refused) {
    return false
  }
  if (!result.success) {
    console.error(
      '❌ Failed to run ansible. Please check the logs.',
    )
    return false
  }
  console.log('✔︎ Success')
  return true
}

export { runAnsibleCapture, runAnsilbe }
export type { ExtraVars, RunAnsibleOptions, RunAnsibleResult }
