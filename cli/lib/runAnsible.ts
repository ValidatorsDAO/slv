import type { InventoryType } from '@cmn/types/config.ts'
import { getInventoryPath } from '@cmn/constants/path.ts'

type RunAnsibleResult = {
  success: boolean
  code: number
  stdout: string
  stderr: string
  output: string
}

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
  extraVars?: Record<string, string>,
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
  extraVars?: Record<string, string>,
): Promise<RunAnsibleResult> => {
  const args = buildAnsibleArgs(filePath, inventoryType, limit, extraVars)
  console.log(
    `🚀 Running ansible: ansible-playbook ${args.map(shellQuote).join(' ')}`,
  )

  try {
    const result = await new Deno.Command('ansible-playbook', {
      args,
      stdout: 'piped',
      stderr: 'piped',
    }).output()

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
  extraVars?: Record<string, string>,
) => {
  const result = await runAnsibleCapture(
    filePath,
    inventoryType,
    limit,
    extraVars,
  )
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
