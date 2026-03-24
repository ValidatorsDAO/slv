import { resolveHome } from '/lib/getApiKeyFromYml.ts'
import { Confirm } from '@cliffy/prompt'
import { colors } from '@cliffy/colors'
import Anthropic from '@anthropic-ai/sdk'
import OpenAI from 'openai'
import { readAiConfig, DEFAULT_MAX_TOKENS } from '@/ai/config.ts'

export type ToolDefinition = {
  name: string
  description: string
  parameters: Record<string, unknown>
}

const AGENT_SKILL_MAP: Record<string, string> = {
  'Cecil': 'slv-validator',
  'Tina': 'slv-rpc',
  'Cloud': 'slv-grpc-geyser',
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
  {
    name: 'write_file',
    description:
      'Write content to a file. Use this to update MEMORY.md or create configuration files. Only writes to ~/.slv/ are allowed.',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Absolute path to the file to write',
        },
        content: {
          type: 'string',
          description: 'Content to write to the file',
        },
      },
      required: ['path', 'content'],
    },
  },
  {
    name: 'delegate_to_agent',
    description:
      'Delegate a task to a specialist sub-agent. Use Cecil for validator tasks, Tina for RPC tasks, Cloud for gRPC Geyser tasks.',
    parameters: {
      type: 'object',
      properties: {
        agent: {
          type: 'string',
          description: 'Sub-agent name: Cecil, Tina, or Cloud',
        },
        task: {
          type: 'string',
          description: 'Task description for the sub-agent',
        },
      },
      required: ['agent', 'task'],
    },
  },
]

// Tools available to sub-agents (no delegate_to_agent to prevent recursion)
export const SUB_AGENT_TOOL_DEFINITIONS: ToolDefinition[] =
  TOOL_DEFINITIONS.filter((t) => t.name !== 'delegate_to_agent')

export async function executeTool(
  name: string,
  args: Record<string, unknown>,
): Promise<string> {
  switch (name) {
    case 'run_command':
      return await executeRunCommand(String(args.command || ''))
    case 'read_file':
      return await executeReadFile(String(args.path || ''))
    case 'list_files':
      return await executeListFiles(String(args.path || ''))
    case 'write_file':
      return await executeWriteFile(String(args.path || ''), String(args.content || ''))
    case 'delegate_to_agent':
      return await executeDelegateToAgent(String(args.agent || ''), String(args.task || ''))
    default:
      return `Unknown tool: ${name}`
  }
}

// Execute tool for sub-agents (no delegation)
export async function executeSubAgentTool(
  name: string,
  args: Record<string, unknown>,
): Promise<string> {
  if (name === 'delegate_to_agent') {
    return 'Error: Sub-agents cannot delegate to other agents.'
  }
  return await executeTool(name, args)
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

async function executeWriteFile(path: string, content: string): Promise<string> {
  console.log(
    '\n' + colors.yellow('  Tool: write_file'),
  )
  console.log(colors.white(`  Path: ${path}`))

  const home = resolveHome()
  const slvDir = `${home}/.slv/`
  if (!path.startsWith(slvDir)) {
    return `Error: write_file only allows writing to ~/.slv/ directory. Requested path: ${path}`
  }

  try {
    // Ensure parent directory exists
    const parentDir = path.substring(0, path.lastIndexOf('/'))
    if (parentDir) {
      await Deno.mkdir(parentDir, { recursive: true })
    }
    await Deno.writeTextFile(path, content)
    console.log(colors.green(`  ✓ Written to ${path}`))
    return `Successfully wrote to ${path}`
  } catch (error) {
    return `Error writing file: ${(error as Error).message}`
  }
}

async function executeDelegateToAgent(agentName: string, task: string): Promise<string> {
  const skillName = AGENT_SKILL_MAP[agentName]
  if (!skillName) {
    return `Unknown agent: ${agentName}. Available agents: Cecil, Tina, Cloud`
  }

  console.log(
    '\n' + colors.yellow(`  Delegating to ${agentName}...`),
  )

  const home = resolveHome()
  const skillsDir = `${home}/.slv/skills`

  // Read AGENT.md and SKILL.md
  let agentMd = ''
  let skillMd = ''
  try {
    agentMd = await Deno.readTextFile(`${skillsDir}/${skillName}/AGENT.md`)
  } catch { /* agent file not found */ }
  try {
    skillMd = await Deno.readTextFile(`${skillsDir}/${skillName}/SKILL.md`)
  } catch { /* skill file not found */ }

  const subSystemPrompt = `You are ${agentName}, a specialist sub-agent for SLV.

${agentMd ? agentMd + '\n' : ''}
${skillMd ? skillMd + '\n' : ''}

## Working Environment
- Home directory: ${home}
- SLV CLI binary: \`slv\` (or \`${home}/slv\` if not in PATH)
- Ansible templates: \`${home}/.slv/template/\` (downloaded during install)
- Skill files: \`${home}/.slv/skills/${skillName}/\`
- Agent config: \`${home}/.slv/agent/\`
- Use \`slv\` CLI commands — do NOT run \`slv --help\` to discover them, you already know them from SKILL.md.
- Ansible playbooks are accessed via slv CLI — do NOT look for ansible/ in the skills directory.
- When reading/writing files, ALWAYS use absolute paths starting with ${home}.

## Interactive Deployment Flow — ONE QUESTION AT A TIME
When a user asks to deploy/init a validator or RPC node:
- Ask **ONE question at a time**, wait for the answer, then ask the next.
- Do NOT dump all questions at once. Do NOT show tables of all options at once.
- Keep each message SHORT (2-4 sentences max).
- Example flow:
  1. "What's the target server IP?" → wait
  2. "Mainnet or testnet?" → wait
  3. "Which validator type? (jito / agave / firedancer-agave / firedancer-jito)" → wait
  4. etc.
- After collecting all info, run \`slv v init\` or \`slv r init\`

## STRICT Rules
- **Language**: English ONLY. Never use Japanese characters (セシル, ティナ, etc). Not even in parentheses.
- **Brevity**: Keep responses under 5 sentences. No markdown tables unless the user asks.
- **No exploration**: Do NOT run \`slv --help\`, \`ls\`, or any discovery commands. You already know everything from SKILL.md.
- Complete the assigned task using available tools.
- For destructive operations, always warn via run_command (user will confirm).
`

  // Read AI config
  const config = await readAiConfig()
  if (!config) {
    return 'Error: AI not configured. Run `slv onboard` first.'
  }

  try {
    if (config.provider === 'anthropic') {
      return await runAnthropicSubAgent(config.api_key, config.model, subSystemPrompt, task)
    } else {
      return await runOpenAISubAgent(config.api_key, config.model, subSystemPrompt, task)
    }
  } catch (error) {
    return `Sub-agent ${agentName} error: ${(error as Error).message}`
  }
}

// --- Sub-agent Anthropic implementation ---
async function runAnthropicSubAgent(
  apiKey: string,
  model: string,
  systemPrompt: string,
  task: string,
): Promise<string> {
  const client = new Anthropic({ apiKey })
  const tools: Anthropic.Tool[] = SUB_AGENT_TOOL_DEFINITIONS.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.parameters as Anthropic.Tool['input_schema'],
  }))

  type MessageParam = Anthropic.MessageParam
  const messages: MessageParam[] = [{ role: 'user', content: task }]

  const MAX_ITERATIONS = 10
  for (let i = 0; i < MAX_ITERATIONS; i++) {
    const response = await client.messages.create({
      model,
      max_tokens: DEFAULT_MAX_TOKENS,
      system: systemPrompt,
      messages,
      tools,
    })

    // Collect text and tool_use blocks
    let textContent = ''
    const toolUseBlocks: { id: string; name: string; input: Record<string, unknown> }[] = []
    for (const block of response.content) {
      if (block.type === 'text') {
        textContent += block.text
      } else if (block.type === 'tool_use') {
        toolUseBlocks.push({
          id: block.id,
          name: block.name,
          input: block.input as Record<string, unknown>,
        })
      }
    }

    messages.push({ role: 'assistant', content: response.content })

    if (toolUseBlocks.length === 0 || response.stop_reason === 'end_turn') {
      if (textContent) {
        console.log(colors.rgb24(`\n  [${toolUseBlocks.length === 0 ? 'Sub-agent' : 'Sub-agent final'}]: `, 0x888888) + colors.white(textContent))
      }
      return textContent || '(no response from sub-agent)'
    }

    // Execute tools
    const toolResults: Anthropic.ToolResultBlockParam[] = []
    for (const tb of toolUseBlocks) {
      const result = await executeSubAgentTool(tb.name, tb.input)
      toolResults.push({
        type: 'tool_result',
        tool_use_id: tb.id,
        content: result,
      })
    }
    messages.push({ role: 'user', content: toolResults })
  }

  return '(sub-agent reached maximum iteration limit)'
}

// --- Sub-agent OpenAI implementation ---
async function runOpenAISubAgent(
  apiKey: string,
  model: string,
  systemPrompt: string,
  task: string,
): Promise<string> {
  const client = new OpenAI({ apiKey })
  const tools: OpenAI.ChatCompletionTool[] = SUB_AGENT_TOOL_DEFINITIONS.map((t) => ({
    type: 'function' as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    },
  }))

  type Message = OpenAI.ChatCompletionMessageParam
  const messages: Message[] = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: task },
  ]

  const MAX_ITERATIONS = 10
  for (let i = 0; i < MAX_ITERATIONS; i++) {
    const response = await client.chat.completions.create({
      model,
      messages,
      tools,
    })

    const choice = response.choices[0]
    if (!choice) return '(no response from sub-agent)'

    const assistantMessage = choice.message
    messages.push(assistantMessage as Message)

    if (!assistantMessage.tool_calls || assistantMessage.tool_calls.length === 0) {
      const text = assistantMessage.content || ''
      if (text) {
        console.log(colors.rgb24('\n  [Sub-agent]: ', 0x888888) + colors.white(text))
      }
      return text || '(no response from sub-agent)'
    }

    // Execute tools
    for (const tc of assistantMessage.tool_calls) {
      let args: Record<string, unknown>
      try {
        args = JSON.parse(tc.function.arguments)
      } catch (e) {
        messages.push({
          role: 'tool',
          tool_call_id: tc.id,
          content: `Failed to parse arguments: ${(e as Error).message}`,
        })
        continue
      }
      const result = await executeSubAgentTool(tc.function.name, args)
      messages.push({
        role: 'tool',
        tool_call_id: tc.id,
        content: result,
      })
    }
  }

  return '(sub-agent reached maximum iteration limit)'
}
