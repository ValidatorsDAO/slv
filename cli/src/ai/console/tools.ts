import { Confirm } from '@cliffy/prompt'
import { colors } from '@cliffy/colors'

export type ToolDefinition = {
  name: string
  description: string
  parameters: Record<string, unknown>
}

export const TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    name: 'run_command',
    description:
      'Execute a shell command on the system. Use this to run slv commands, check system status, manage services, etc. The user will be asked to confirm before execution.',
    parameters: {
      type: 'object',
      properties: {
        command: {
          type: 'string',
          description: 'The shell command to execute',
        },
      },
      required: ['command'],
    },
  },
  {
    name: 'read_file',
    description:
      'Read the contents of a file. Use this to inspect configuration files, logs, keys, etc.',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Absolute path to the file to read',
        },
      },
      required: ['path'],
    },
  },
  {
    name: 'list_files',
    description:
      'List files and directories at a given path. Use this to explore directory structures.',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Absolute path to the directory to list',
        },
      },
      required: ['path'],
    },
  },
]

export async function executeTool(
  name: string,
  args: Record<string, string>,
): Promise<string> {
  switch (name) {
    case 'run_command':
      return await executeRunCommand(args.command)
    case 'read_file':
      return await executeReadFile(args.path)
    case 'list_files':
      return await executeListFiles(args.path)
    default:
      return `Unknown tool: ${name}`
  }
}

async function executeRunCommand(command: string): Promise<string> {
  console.log(
    '\n' + colors.yellow('  Tool: run_command'),
  )
  console.log(
    colors.white(`  $ ${colors.bold(command)}`),
  )

  const confirmed = await Confirm.prompt({
    message: 'Execute this command?',
    default: true,
  })

  if (!confirmed) {
    return 'User declined to execute the command.'
  }

  try {
    const process = new Deno.Command('bash', {
      args: ['-c', command],
      stdout: 'piped',
      stderr: 'piped',
    })
    const output = await process.output()
    const stdout = new TextDecoder().decode(output.stdout)
    const stderr = new TextDecoder().decode(output.stderr)

    if (!output.success) {
      return `Command failed (exit code ${output.code}):\nstdout:\n${stdout}\nstderr:\n${stderr}`
    }
    return stdout || '(no output)'
  } catch (error) {
    return `Error executing command: ${(error as Error).message}`
  }
}

async function executeReadFile(path: string): Promise<string> {
  console.log(
    '\n' + colors.yellow('  Tool: read_file'),
  )
  console.log(colors.white(`  Path: ${path}`))

  try {
    const content = await Deno.readTextFile(path)
    const lines = content.split('\n')
    if (lines.length > 200) {
      return lines.slice(0, 200).join('\n') +
        `\n\n... (truncated, ${lines.length} total lines)`
    }
    return content
  } catch (error) {
    return `Error reading file: ${(error as Error).message}`
  }
}

async function executeListFiles(path: string): Promise<string> {
  console.log(
    '\n' + colors.yellow('  Tool: list_files'),
  )
  console.log(colors.white(`  Path: ${path}`))

  try {
    const entries: string[] = []
    for await (const entry of Deno.readDir(path)) {
      const prefix = entry.isDirectory ? '[dir]  ' : '[file] '
      entries.push(prefix + entry.name)
    }
    entries.sort()
    return entries.join('\n') || '(empty directory)'
  } catch (error) {
    return `Error listing directory: ${(error as Error).message}`
  }
}
