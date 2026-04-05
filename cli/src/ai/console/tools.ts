import { resolveHome } from '/lib/getApiKeyFromYml.ts'
import { Confirm } from '@cliffy/prompt'
import Anthropic from '@anthropic-ai/sdk'
import OpenAI from 'openai'
import { readAiConfig, DEFAULT_MAX_TOKENS } from '@/ai/config.ts'
import { parse } from '@std/yaml'
import type { TUI } from '@mariozechner/pi-tui'
import { loadContextModules, isModuleLoaded } from '@/ai/console/systemPrompt.ts'

// TUI instance for suspend/resume during confirm prompts
let tuiInstance: TUI | null = null
let autoExecuteCommands = true  // Default: auto-execute without confirmation

export function setTuiInstance(tui: TUI | null) {
  tuiInstance = tui
}

export function setAutoExecute(auto: boolean) {
  autoExecuteCommands = auto
}

// Callback for streaming command output to TUI
let onCommandOutput: ((line: string) => void) | null = null
let activeChildProcess: Deno.ChildProcess | null = null
let onCommandComplete: (() => void) | null = null
let onAnsibleTaskUpdate: ((taskName: string) => void) | null = null

export function setCommandOutputCallback(
  cb: ((line: string) => void) | null,
  completeCb?: (() => void) | null,
  ansibleTaskCb?: ((taskName: string) => void) | null,
) {
  onCommandOutput = cb
  onCommandComplete = completeCb ?? null
  onAnsibleTaskUpdate = ansibleTaskCb ?? null
}

export function killActiveProcess() {
  if (activeChildProcess) {
    try { activeChildProcess.kill('SIGTERM') } catch { /* ignore */ }
    activeChildProcess = null
  }
}

export type ToolDefinition = {
  name: string
  description: string
  parameters: Record<string, unknown>
}

const AGENT_SKILL_MAP: Record<string, string> = {
  'Cecil': 'slv-validator',
  'Tina': 'slv-rpc',
  'Cloud': 'slv-grpc-geyser',
  'Cid': 'slv-benchmark',
  'Setzer': 'slv-app',
  'Figaro': 'slv-server-procurement',
}

// Core tools — always sent to the API (minimal token footprint)
export const CORE_TOOLS: ToolDefinition[] = [
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
    name: 'enable_tools',
    description:
      'Enable additional tools when needed. Available extended tools: write_file, list_files, call_mcp, send_notification, delegate_to_agent. Call this to activate them before use.',
    parameters: {
      type: 'object',
      properties: {
        tools: {
          type: 'array',
          items: {
            type: 'string',
            enum: ['write_file', 'list_files', 'call_mcp', 'send_notification', 'delegate_to_agent'],
          },
          description: 'Tool names to enable',
        },
      },
      required: ['tools'],
    },
  },
  {
    name: 'load_context',
    description:
      'Load additional context modules into your knowledge. Available: ssh_check, delegation, deploy, validator, cli_reference, mcp_reference. Call this BEFORE performing tasks that need specialized knowledge.',
    parameters: {
      type: 'object',
      properties: {
        modules: {
          type: 'array',
          items: {
            type: 'string',
            enum: ['ssh_check', 'delegation', 'deploy', 'validator', 'cli_reference', 'mcp_reference'],
          },
          description: 'Context module names to load',
        },
      },
      required: ['modules'],
    },
  },
]

// Extended tools — loaded on demand via enable_tools
export const EXTENDED_TOOLS: ToolDefinition[] = [
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
    name: 'call_mcp',
    description:
      'Call the SLV Cloud MCP API. Use this to check user subscriptions, list products, generate payment links, manage servers, etc. The API key from ~/.slv/api.yml is used automatically.',
    parameters: {
      type: 'object',
      properties: {
        tool_name: {
          type: 'string',
          description:
            'MCP tool name (e.g. get_user_get, get_baremetal_list_public_node_type, post_billing_generate_payment_link)',
        },
        arguments: {
          type: 'object',
          description: 'Arguments to pass to the MCP tool',
        },
      },
      required: ['tool_name'],
    },
  },
  {
    name: 'send_notification',
    description:
      'Send a notification to the user via Discord webhook (if configured in ~/.slv/agent/config.yml). Use after completing long-running tasks like deployments.',
    parameters: {
      type: 'object',
      properties: {
        message: {
          type: 'string',
          description: 'Notification message to send',
        },
      },
      required: ['message'],
    },
  },
  {
    name: 'delegate_to_agent',
    description:
      'Delegate a task to a specialist sub-agent. Use Cecil for validator tasks, Tina for ALL RPC tasks (Index RPC, gRPC Geyser, combo), Cid for benchmark/connectivity testing (geyserbench for Geyser gRPC benchmarking, grpc_test, shreds_test), Setzer for app/bot tasks, Figaro for server procurement.',
    parameters: {
      type: 'object',
      properties: {
        agent: {
          type: 'string',
          description: 'Sub-agent name: Cecil, Tina, Cid, Setzer, or Figaro',
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

// Mutable set of currently active extended tools
let activeExtendedTools: Set<string> = new Set()

// Get the current active tool set (core + enabled extended tools)
export function getActiveTools(): ToolDefinition[] {
  const extended = EXTENDED_TOOLS.filter((t) => activeExtendedTools.has(t.name))
  return [...CORE_TOOLS, ...extended]
}

// Reset active extended tools (call at session start)
export function resetActiveTools(): void {
  activeExtendedTools = new Set()
}

// Legacy export for backward compatibility (all tools)
export const TOOL_DEFINITIONS: ToolDefinition[] = [...CORE_TOOLS, ...EXTENDED_TOOLS]

// Tools available to sub-agents (no delegation or lazy-enable meta-tool needed)
export const SUB_AGENT_TOOL_DEFINITIONS: ToolDefinition[] =
  TOOL_DEFINITIONS.filter((t) =>
    t.name !== 'delegate_to_agent' && t.name !== 'enable_tools'
  )

export async function executeTool(
  name: string,
  args: Record<string, unknown>,
): Promise<string> {
  switch (name) {
    case 'run_command':
      return await executeRunCommand(String(args.command || ''))
    case 'read_file':
      return await executeReadFile(String(args.path || ''))
    case 'enable_tools': {
      const requested = (args.tools as string[]) || []
      const validNames = new Set(EXTENDED_TOOLS.map((t) => t.name))
      const enabled: string[] = []
      const invalid: string[] = []
      for (const toolName of requested) {
        if (validNames.has(toolName)) {
          activeExtendedTools.add(toolName)
          enabled.push(toolName)
        } else {
          invalid.push(toolName)
        }
      }
      let msg = `Enabled tools: ${enabled.join(', ') || '(none)'}.`
      if (invalid.length > 0) {
        msg += ` Unknown tools ignored: ${invalid.join(', ')}.`
      }
      msg += ` You can now use them in this session.`
      return msg
    }
    case 'load_context': {
      const modules = (args.modules as string[]) || []
      return loadContextModules(modules)
    }
    case 'list_files':
      return await executeListFiles(String(args.path || ''))
    case 'write_file':
      return await executeWriteFile(String(args.path || ''), String(args.content || ''))
    case 'call_mcp': {
      // Auto-load MCP reference context if not loaded
      if (!isModuleLoaded('mcp_reference')) {
        loadContextModules(['mcp_reference'])
      }
      return await executeCallMcp(
        String(args.tool_name || ''),
        (args.arguments as Record<string, unknown>) || {},
      )
    }
    case 'send_notification':
      return await executeSendNotification(String(args.message || ''))
    case 'delegate_to_agent': {
      // Auto-load delegation context if not loaded
      if (!isModuleLoaded('delegation')) {
        loadContextModules(['delegation'])
      }
      return await executeDelegateToAgent(String(args.agent || ''), String(args.task || ''))
    }
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
  let confirmed = true

  if (autoExecuteCommands) {
    // Auto-execute: just show what's running
    if (tuiInstance) {
      // TUI mode — show via callback (handled by caller)
    } else {
      console.log(`  ▸ ${command}`)
    }
  } else {
    // Manual confirm mode
    if (tuiInstance) {
      tuiInstance.stop()
      console.log(`\n  Tool: run_command`)
      console.log(`  $ ${command}`)
      confirmed = await Confirm.prompt({
        message: 'Execute this command?',
        default: true,
      })
      tuiInstance.start()
      tuiInstance.requestRender(true)
    }
  }

  if (!confirmed) {
    return 'User declined to execute the command.'
  }

  try {
    // Inject SSH options to prevent host key prompts that hang
    const env: Record<string, string> = {
      ...Object.fromEntries(Object.entries(Deno.env.toObject())),
      ANSIBLE_HOST_KEY_CHECKING: 'False',
      ANSIBLE_SSH_ARGS: '-o StrictHostKeyChecking=accept-new -o UserKnownHostsFile=/dev/null -o PasswordAuthentication=no',
      ANSIBLE_STDOUT_CALLBACK: 'default',
      ANSIBLE_DISPLAY_ARGS_TO_STDOUT: 'False',
      PYTHONUNBUFFERED: '1',
    }
    const proc = new Deno.Command('bash', {
      args: ['-c', command],
      stdin: 'null',
      stdout: 'piped',
      stderr: 'piped',
      env,
    })
    const child = proc.spawn()
    // Store child process so it can be killed on Ctrl+C
    activeChildProcess = child

    // Detect ansible commands to use task-title spinner mode
    const isAnsibleCommand = command.includes('ansible-playbook') || command.includes('ansible ')

    // Stream stdout lines to TUI in real-time
    const stdoutChunks: string[] = []
    const stderrChunks: string[] = []

    const readStream = async (stream: ReadableStream<Uint8Array>, chunks: string[], isStdout: boolean) => {
      const reader = stream.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        const text = decoder.decode(value, { stream: true })
        buffer += text
        chunks.push(text)

        if (isStdout) {
          const lines = buffer.split('\n')
          buffer = lines.pop() || ''
          for (const line of lines) {
            const trimmed = line.trim()
            if (!trimmed) continue

            if (isAnsibleCommand && onAnsibleTaskUpdate) {
              // In ansible mode: only extract TASK titles for spinner
              const taskMatch = trimmed.match(/^TASK \[(.+?)\]/)
              if (taskMatch) {
                onAnsibleTaskUpdate(taskMatch[1])
              }
              if (trimmed.startsWith('PLAY RECAP')) {
                onAnsibleTaskUpdate('Finishing up...')
              }
              // Don't stream raw ansible output to TUI
            } else if (onCommandOutput) {
              // Normal mode: stream all output
              onCommandOutput(trimmed)
            }
          }
        }
      }
      // Flush remaining buffer
      if (isStdout && !isAnsibleCommand && onCommandOutput && buffer.trim()) {
        onCommandOutput(buffer.trim())
      }
    }

    // Race between command completion and timeout (60 minutes — builds and snapshots can take a while)
    const COMMAND_TIMEOUT_MS = 3_600_000
    const timeoutPromise = new Promise<'timeout'>((resolve) =>
      setTimeout(() => resolve('timeout'), COMMAND_TIMEOUT_MS),
    )

    const commandPromise = (async () => {
      await Promise.all([
        readStream(child.stdout, stdoutChunks, true),
        readStream(child.stderr, stderrChunks, false),
      ])
      return await child.status
    })()

    const result = await Promise.race([commandPromise, timeoutPromise])

    if (result === 'timeout') {
      try { child.kill('SIGTERM') } catch { /* ignore */ }
      if (onCommandComplete) onCommandComplete()
      const stdout = stdoutChunks.join('')
      return `Command timed out after 60 minutes.\nPartial output:\n${stdout.slice(-2000)}`
    }

    const status = result
    const stdout = stdoutChunks.join('')
    const stderr = stderrChunks.join('')

    // Save full ansible output to log file for debugging
    if (isAnsibleCommand) {
      try {
        const logDir = `${Deno.env.get('HOME') || '/tmp'}/.slv/logs`
        await Deno.mkdir(logDir, { recursive: true })
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
        const logPath = `${logDir}/ansible-${timestamp}.log`
        const logContent = `Command: ${command}\nExit code: ${status.code}\nTimestamp: ${new Date().toISOString()}\n\n--- STDOUT ---\n${stdout}\n\n--- STDERR ---\n${stderr}`
        await Deno.writeTextFile(logPath, logContent)
        // Rotate: keep only the last 10 log files
        const entries: string[] = []
        for await (const entry of Deno.readDir(logDir)) {
          if (entry.isFile && entry.name.startsWith('ansible-') && entry.name.endsWith('.log')) {
            entries.push(entry.name)
          }
        }
        entries.sort()
        while (entries.length > 10) {
          const oldest = entries.shift()!
          await Deno.remove(`${logDir}/${oldest}`).catch(() => {})
        }
      } catch { /* non-fatal: log saving should never break the flow */ }
    }

    if (!status.success) {
      if (isAnsibleCommand) {
        // For ansible failures: return only the last portion of output + full stderr
        // to keep token usage reasonable while preserving error context
        const logHint = `\nFull log saved to ~/.slv/logs/ for detailed debugging.`
        const lastStdout = stdout.slice(-3000)
        const lastStderr = stderr.slice(-2000)
        return `Command failed (exit code ${status.code}):\nstdout (last 3000 chars):\n${lastStdout}\nstderr (last 2000 chars):\n${lastStderr}${logHint}`
      }
      return `Command failed (exit code ${status.code}):\nstdout:\n${stdout}\nstderr:\n${stderr}`
    }
    activeChildProcess = null
    if (onCommandComplete) onCommandComplete()

    if (isAnsibleCommand) {
      // For successful ansible runs: return a compact summary instead of full output
      // to avoid sending thousands of lines (tens of thousands of tokens) to the AI
      const lines = stdout.split('\n')
      const taskLines = lines.filter((l: string) => {
        const t = l.trim()
        return t.startsWith('TASK [') ||
          t.startsWith('PLAY [') ||
          t.startsWith('PLAY RECAP') ||
          t.startsWith('ok=') ||
          t.includes('changed=') ||
          t.includes('failed=') ||
          t.includes('unreachable=') ||
          t.startsWith('fatal:') ||
          t.startsWith('ERROR') ||
          t.startsWith('FAILED') ||
          t.includes('...ignoring')
      })
      // Also include the PLAY RECAP summary lines (host status lines)
      const recapIdx = lines.findIndex((l: string) => l.trim().startsWith('PLAY RECAP'))
      const recapLines = recapIdx >= 0 ? lines.slice(recapIdx, recapIdx + 20).filter((l: string) => l.trim()) : []
      const summary = [...new Set([...taskLines, ...recapLines])].join('\n')
      const logNote = '\nFull log saved to ~/.slv/logs/ for detailed debugging.'
      return (summary || 'Ansible playbook completed successfully.') + logNote
    }

    // Cap non-ansible output to avoid excessive token usage on unexpectedly large outputs
    if (stdout.length > 10000) {
      return stdout.slice(-10000) + '\n... (output truncated to last 10000 chars)'
    }
    return stdout || '(no output)'
  } catch (error) {
    activeChildProcess = null
    if (onCommandComplete) onCommandComplete()
    return `Error executing command: ${(error as Error).message}`
  }
}

async function executeReadFile(path: string): Promise<string> {
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
    return `Successfully wrote to ${path}`
  } catch (error) {
    return `Error writing file: ${(error as Error).message}`
  }
}

const MCP_MAX_RESPONSE_CHARS = 5000

async function executeCallMcp(
  toolName: string,
  args: Record<string, unknown>,
): Promise<string> {
  const home = resolveHome()
  // Read SLV API key from api.yml
  let apiKey = ''
  try {
    const raw = await Deno.readTextFile(`${home}/.slv/api.yml`)
    const yml = parse(raw) as Record<string, any>
    apiKey = yml?.slv?.api_key || ''
  } catch {
    return 'Error: Cannot read ~/.slv/api.yml'
  }

  if (!apiKey) return 'Error: No SLV API key found. Run `slv login` first.'

  try {
    const response = await fetch('https://mcp-slv-cloud.erpc.global/mcp', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: Date.now(),
        method: 'tools/call',
        params: {
          name: toolName,
          arguments: args || {},
        },
      }),
    })

    const data = await response.json()
    if (data.error) return `MCP Error: ${JSON.stringify(data.error)}`

    const content =
      data.result?.content?.[0]?.text || JSON.stringify(data.result)
    if (content.length > MCP_MAX_RESPONSE_CHARS) {
      return content.slice(0, MCP_MAX_RESPONSE_CHARS) + '\n... (truncated)'
    }
    return content
  } catch (error) {
    return `MCP request failed: ${(error as Error).message}`
  }
}

async function executeSendNotification(message: string): Promise<string> {
  const home = resolveHome()
  try {
    const raw = await Deno.readTextFile(`${home}/.slv/agent/config.yml`)
    const config = parse(raw) as Record<string, unknown>
    const notifications = config.notifications as Record<string, string> | undefined
    const webhook = notifications?.discord_webhook

    if (!webhook) {
      return 'No Discord webhook configured. Notification skipped. (Set it up with `slv onboard`)'
    }

    const res = await fetch(webhook, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content: `🤖 **SLV AI Console**\n${message}`,
      }),
    })

    if (res.ok || res.status === 204) {
      return 'Notification sent to Discord successfully.'
    }
    return `Discord webhook returned status ${res.status}`
  } catch (error) {
    return `Failed to send notification: ${(error as Error).message}`
  }
}

async function executeDelegateToAgent(agentName: string, task: string): Promise<string> {
  // Cloud is now handled by Tina (RPC specialist covers all RPC types including gRPC)
  const effectiveName = agentName === 'Cloud' ? 'Tina' : agentName
  const skillName = AGENT_SKILL_MAP[effectiveName]
  if (!skillName) {
    return `Unknown agent: ${agentName}. Available agents: Cecil, Tina, Cid, Setzer, Figaro`
  }

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

  // Tina and Cid also read gRPC Geyser skill for comprehensive RPC/stream testing knowledge
  if (effectiveName === 'Tina' || effectiveName === 'Cid') {
    try {
      const grpcSkill = await Deno.readTextFile(`${skillsDir}/slv-grpc-geyser/SKILL.md`)
      skillMd += `\n\n## Additional Skill: gRPC Geyser\n${grpcSkill}`
    } catch { /* gRPC skill not installed */ }
  }

  // Read deployment mode from config.yml
  let deployMode = 'remote'
  try {
    const configRaw = await Deno.readTextFile(`${home}/.slv/agent/config.yml`)
    const configData = parse(configRaw) as Record<string, unknown>
    deployMode = (configData.mode as string) || 'remote'
  } catch { /* default to remote */ }

  const modeInstruction = deployMode === 'local'
    ? `
## DEPLOYMENT MODE: LOCAL
This user operates in LOCAL mode. All deployments target THIS machine (localhost).
- Do NOT ask for server IP or SSH credentials.
- Use \`--localhost\` flag for ALL init/deploy commands.
- Examples: \`slv v init --localhost\`, \`slv v deploy --localhost\`, \`slv r init --localhost\`, \`slv r deploy --localhost\`
- Ansible runs locally with \`ansible_connection: local\`.
- Skip SSH connectivity checks entirely.
`
    : ''

  const subSystemPrompt = `You are ${effectiveName}, a backend specialist sub-agent for SLV.
You do NOT talk to the user directly. You report back to the main agent only.

${agentMd ? agentMd + '\n' : ''}
${skillMd ? skillMd + '\n' : ''}
${modeInstruction}
## Working Environment
- Home directory: ${home}
- SLV CLI binary: \`slv\` (or \`${home}/slv\` if not in PATH)
- Ansible templates: \`${home}/.slv/template/{version}/ansible/\` — templates are versioned!
  - To find the latest version: \`ls -d ${home}/.slv/template/*/ | sort -V | tail -1\`
  - Example: \`${home}/.slv/template/0.12.1/ansible/cmn/add_solv.yml\`
- When reading/writing files, ALWAYS use absolute paths starting with ${home}.

## How you work
- You receive a task from the main agent.
- You analyze it using your SKILL.md knowledge.
- If you need information from the user, tell the main agent WHAT to ask (do NOT ask the user directly).
- If you can execute commands, do so and report results.
- Keep responses concise and structured for the main agent to relay to the user.
- Do NOT run discovery commands (\`slv --help\`, \`ls\`, etc). You already know everything from SKILL.md.
- Do NOT ask for expected_shred_version — it has sensible defaults.
- Do NOT use markdown tables. Use plain text or bullet lists.
- Do NOT offer dry-runs or --check — just deploy when the user says go.
- English only.

## Benchmark flow (CRITICAL for Cid)
- When the user says they want to benchmark, first determine WHICH benchmark type they want:
  1. shredstream
  2. grpc
  3. rpc
- If the benchmark type is not explicitly given, ask the main agent to ask exactly one question:
  - "Which benchmark do you want to run: shredstream, grpc, or rpc?"
- After the type is known, ask for the endpoint(s) next. Do not ask for whitelist IP, region, or server details before benchmark type and endpoint are confirmed.
- Preferred question order for benchmark tasks:
  1. benchmark type (shredstream / grpc / rpc)
  2. region to measure with \`--region\`
  3. endpoint or endpoints to test
- For shredstream or grpc benchmarks, prefer using the local \`geyserbench\` binary — it is the PRIMARY tool for Geyser gRPC benchmarking (throughput, latency, slot delivery).
- geyserbench binary location: \`${home}/.slv/bin/geyserbench\` (kept up-to-date by \`slv upgrade\`).
- If \`geyserbench\` is available, run it and return the benchmark output directly so the main agent can show the user the result with minimal rewriting.
- If \`geyserbench\` is not available, clearly report that and suggest the next best local SLV check command.
- For benchmark tasks, optimize for fast execution and direct result display, not long advisory explanations.

## CRITICAL: Deployment Flow

### Pre-requisites
1. Read \`${home}/.slv/versions.yml\` FIRST to get default versions for the selected network/type.
   - For jito on testnet: use \`testnet_validators.version_jito\` (e.g. "4.0.0-beta.2-jito")
   - For agave on mainnet: use \`mainnet_validators.version_agave\`
   - etc.
2. Check if \`solana-keygen\` (or \`agave-keygen\`) exists. If not, install:
   \`\`\`
   sh -c "$(curl -sSfL https://release.anza.xyz/v<agave_version>/install)"
   export PATH="${home}/.local/share/solana/install/active_release/bin:$PATH"
   \`\`\`
   Use the agave version from versions.yml.

### Asking the user — minimum questions only (in this order)
For validator deploy, ask the main agent to collect ONLY:
1. Server IP
2. SSH login user (e.g. ubuntu, root, solv — default: solv)
3. Network: mainnet / testnet
4. Region: amsterdam / frankfurt / tokyo / ny
5. Validator type: jito / agave / firedancer-agave / firedancer-jito (NO jito-bam)
6. Identity: existing pubkey or "generate"
7. Vote account: existing pubkey or "generate"

Do NOT ask for version — read from versions.yml and show as default.
Do NOT ask for snapshot URL, commission, port range — use defaults.

### Step 1: Generate keys (if "generate")
\`\`\`
mkdir -p ${home}/.slv/keys
solana-keygen new --no-passphrase -o ${home}/.slv/keys/<name>-identity.json
solana-keygen pubkey ${home}/.slv/keys/<name>-identity.json
solana-keygen new --no-passphrase -o ${home}/.slv/keys/<name>-vote.json
solana-keygen pubkey ${home}/.slv/keys/<name>-vote.json
solana-keygen new --no-passphrase -o ${home}/.slv/keys/<name>-authority.json
solana-keygen pubkey ${home}/.slv/keys/<name>-authority.json
\`\`\`

### Step 2: Write inventory YAML
Use write_file to create \`${home}/.slv/inventory.<network>.validators.yml\`:

\`\`\`yaml
<network>_validators:
  hosts:
    <identity_pubkey>:
      name: <identity_pubkey>
      ansible_host: <server_ip>
      ansible_user: solv
      ansible_ssh_private_key_file: ~/.ssh/id_rsa
      identity_account: <identity_pubkey>
      vote_account: <vote_pubkey>
      authority_account: <authority_pubkey>
      validator_type: <type>
      region: <region>
      snapshot_url: ""  # Auto-detected from nearest region
      commission_bps: 0
      dynamic_port_range: "8900-8925"
      port_rpc: 7211
\`\`\`

### Snapshot URL — Auto-detect nearest region (MAINNET ONLY)
**CRITICAL: For testnet deploys, SKIP snapshot auto-detection entirely.**
- Testnet validators do NOT use ERPC snapshot URLs (those are mainnet only).
- For testnet, leave \`snapshot_url: ""\` in the inventory. The testnet init playbook handles snapshot acquisition internally.
- Only run the snapshot region ping test for MAINNET deploys.

For MAINNET deploys, after writing the inventory (Step 2), but BEFORE deploying (Step 3):

1. Run this command to find the nearest snapshot region from the target server:
\`\`\`
ssh -o StrictHostKeyChecking=accept-new -o PasswordAuthentication=no solv@<server_ip> 'for region in ams fra lon ny tokyo sgp chi; do (echo -n "$region: "; ping -c 3 -W 2 -q solana-snapshot-$region.erpc.global 2>/dev/null | grep "rtt min" | awk -F"/" "{print \\$5 \\" ms\\"}" || echo "unreachable") & done; wait'
\`\`\`

2. Pick the region with the lowest latency.
3. Set snapshot_url in the inventory YAML to the nearest region URL:
   - amsterdam → https://solana-snapshot-ams.erpc.global
   - frankfurt → https://solana-snapshot-fra.erpc.global
   - london → https://solana-snapshot-lon.erpc.global
   - ny → https://solana-snapshot-ny.erpc.global
   - tokyo → https://solana-snapshot-tokyo.erpc.global
   - singapore → https://solana-snapshot-sgp.erpc.global
   - chicago → https://solana-snapshot-chi.erpc.global

4. Tell the user which region was selected and the latency:
   "📍 Nearest snapshot: Frankfurt (2.1 ms) — https://solana-snapshot-fra.erpc.global"

If ALL regions are unreachable (ping blocked), the server is not on the ERPC network. Leave snapshot_url as empty string so standard snapshot sources are used.

## Pre-deploy note
The main agent has ALREADY verified SSH connectivity and created the solv user.
The inventory uses \`ansible_user: solv\`. You can proceed directly with key generation, inventory, and deploy.
If any ansible command fails with SSH errors, report it to the main agent immediately.

### Step 3: Deploy
Do NOT use \`slv v deploy\` — it has an interactive confirm prompt that hangs.
Instead, run ansible-playbook directly:
\`\`\`
TEMPLATE_DIR=$(ls -d ${home}/.slv/template/*/ | sort -V | tail -1)
ansible-playbook -i ${home}/.slv/inventory.<network>.validators.yml \${TEMPLATE_DIR}ansible/<network>-validator/init.yml --limit <identity_pubkey>
\`\`\`
Example for testnet:
\`\`\`
TEMPLATE_DIR=$(ls -d ${home}/.slv/template/*/ | sort -V | tail -1) && ansible-playbook -i ${home}/.slv/inventory.testnet.validators.yml \${TEMPLATE_DIR}ansible/testnet-validator/init.yml --limit <identity_pubkey>
\`\`\`

### Identity Key Structure (CRITICAL — get this right in completion messages)
The deploy playbook creates this key layout on the target node:

**Testnet:**
- \`/home/solv/testnet-validator-keypair.json\` — the validator's staked identity key (copied from ~/.slv/keys/)
- \`/home/solv/unstaked-identity.json\` — auto-generated throwaway key for safe startup
- \`/home/solv/identity.json\` — **symlink**, defaults to \`unstaked-identity.json\` to prevent double-voting
- To activate staked identity: \`ln -sf /home/solv/testnet-validator-keypair.json /home/solv/identity.json\`

**Mainnet:**
- \`/home/solv/<identity-pubkey>.json\` — the validator's staked identity key
- \`/home/solv/unstaked-identity.json\` — auto-generated throwaway key for safe startup
- \`/home/solv/identity.json\` — **symlink**, defaults to \`unstaked-identity.json\`
- To activate: \`ln -sf /home/solv/<identity-pubkey>.json /home/solv/identity.json\` or use \`slv v set:identity\`

**Why unstaked by default:** Prevents double-voting if the same identity runs on two nodes simultaneously (e.g. during migration). The validator starts with the unstaked key and catches up with the cluster safely. The user switches to staked identity only when ready.

In your completion message, say:
- "The validator is running with the unstaked identity by default (to prevent double-voting)."
- For testnet: "Your staked identity is at /home/solv/testnet-validator-keypair.json. Switch with: \`ln -sf /home/solv/testnet-validator-keypair.json /home/solv/identity.json && sudo systemctl restart solv\`"
- For mainnet: "Your staked identity is ready. Switch with \`slv v set:identity\` when you're ready."
- Do NOT say "staked-identity.json" — that file does not exist.

### Validator types (for user selection — NO jito-bam)
- jito — Jito MEV client
- agave — Standard Agave validator
- firedancer-agave — Firedancer with Agave consensus
- firedancer-jito — Firedancer with Jito consensus

### Ansible/SSH execution
When running ansible-playbook or slv commands that connect to servers:
- ALWAYS add SSH options to avoid host key prompts that hang:
  - For ansible-playbook: add \`-e 'ansible_ssh_common_args="-o StrictHostKeyChecking=accept-new"'\`
  - For raw ssh/scp: add \`-o StrictHostKeyChecking=accept-new\`
  - For slv v deploy: set env \`ANSIBLE_SSH_ARGS="-o StrictHostKeyChecking=accept-new"\` before the command
- Example: \`ANSIBLE_SSH_ARGS="-o StrictHostKeyChecking=accept-new" slv v deploy -n testnet -p <identity>\`
- The user will see command output in real-time. Long-running commands are expected.
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

  const MAX_ITERATIONS = 20
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

  const MAX_ITERATIONS = 20
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
      return assistantMessage.content || '(no response from sub-agent)'
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
