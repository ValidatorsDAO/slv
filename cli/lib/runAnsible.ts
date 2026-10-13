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

const spawnAnsible: AnsibleSpawn = (args) =>
  new Deno.Command('ansible-playbook', {
    args,
    stdout: 'piped',
    stderr: 'piped',
  }).output()

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
    if (stdout) {
      console.log(stdout)
    }
    if (stderr) {
      console.error(stderr)
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
