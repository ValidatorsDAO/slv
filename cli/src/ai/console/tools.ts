import {
  COMMAND_REFERENCE,
  VALIDATOR_GUIDANCE,
} from '@/ai/console/operationalGuidance.ts'
import { resolveHome, resolveUserApiAuth } from '/lib/getApiKeyFromYml.ts'
import { Confirm } from '@cliffy/prompt'
import {
  DEFAULT_AI_CONFIG,
  DEFAULT_MAX_TOKENS,
  readAiConfig,
  readLang,
} from '@/ai/config.ts'
import { parse } from '@std/yaml'
import { normalize } from '@std/path'
import type { TUI } from '@mariozechner/pi-tui'
import {
  isModuleLoaded,
  loadContextModules,
} from '@/ai/console/systemPrompt.ts'
import {
  classifyCommand,
  decideCommandGate,
  describeRefusal,
} from '@/ai/console/commandGate.ts'
import {
  buildCommandEnv,
  buildShellInvocation,
  decideWriteFile,
  describeWrite,
  describeWriteRefusal,
  fileToolRefusal,
  findExecutable,
  isAgentMemoryFile,
  redactSecretKeys,
} from '@/ai/console/toolSafety.ts'
import { AUTO_EXECUTE_NOTE } from '@/ai/console/keyMaterial.ts'
import { isReadOnlyLine } from '@/ai/console/readOnly.ts'
import { DISCORD_LINK } from '@cmn/constants/url.ts'
import { callReadTool, isReadToolFailure } from '/lib/userApi/readTools.ts'
import { type UserApiAuth, userApiAuthHeader } from '/lib/userApi/auth.ts'
import { readUserApiError } from '/lib/userApi/httpError.ts'
import type { ThinkingEffort } from '@/ai/console/turnPolicy.ts'
import { getCommandHelp, HELP_COMMANDS } from '@/ai/console/commandHelp.ts'
import { loadAgentContext } from '@/ai/agentConfig/loader.ts'
import { ALL_AGENT_IDS, isKnownAgentId } from '@/ai/agentConfig/registry.ts'
import {
  resolveAgentMdPath,
  resolveSkillMdPath,
} from '@/ai/agentConfig/paths.ts'

// TUI instance for suspend/resume during confirm prompts
let tuiInstance: TUI | null = null
let autoExecuteCommands = false // The console sets it from the agent config

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
// Generic progress-hint callback. Fires whenever a streamed stdout/stderr
// line matches a recognized "current step" pattern (cargo "Compiling X",
// pip "Collecting foo", npm "added N packages", homebrew "==> pouring",
// etc.). The TUI surfaces the latest hint on the spinner label so a
// minute-plus cargo build doesn't look frozen.
let onProgressHint: ((hint: string) => void) | null = null

// Progress-hint extraction patterns. Order matters only for specificity —
// the first match wins per line. Each capture group yields the hint shown
// to the user. Keep patterns cheap (anchored, bounded lengths) since this
// runs on every streamed line during a potentially 10k-lines-per-second
// cargo build.
// Pattern order matters: the more specific multi-word pip patterns must
// come BEFORE the generic single-verb list, otherwise "Building wheel
// for pandas" only yields "Building wheel" because `Building` alone
// wins.
const PROGRESS_PATTERNS: RegExp[] = [
  // pip / uv (multi-word forms first)
  /^\s*(Building wheel for|Preparing metadata for|Successfully installed|Requirement already satisfied)\s+([\w\-./@]+)/,
  // pip / uv (single-word)
  /^\s*(Collecting|Obtaining)\s+([\w\-./@]+)/,
  // Cargo + generic verbs: "   Compiling solana-program v1.18.0"
  /^\s*(Compiling|Checking|Finished|Building|Fresh|Running|Installing|Updating|Downloading|Fetching|Verifying|Compressing|Linking|Documenting)\s+([\w\-./@:]+)/,
  // Homebrew: "==> Downloading https://..."
  /^==>\s+(.{1,60})/,
  // npm / pnpm / yarn
  /^\s*(added|removed|changed)\s+\d+\s+packages?/,
  /^\s*➜\s+(.{1,60})/,
  // Docker: "Step 3/12 : COPY . /app"
  /^Step\s+\d+\/\d+\s*:/,
  // Make-style: "[ 45%] Building CXX object ..."
  /^\[\s*\d+%\]\s+.{1,60}/,
]

const MAX_HINT_LEN = 60

const extractProgressHint = (line: string): string | null => {
  for (const re of PROGRESS_PATTERNS) {
    const m = re.exec(line)
    if (m) {
      const hint = m[0].trim()
      return hint.length > MAX_HINT_LEN
        ? hint.slice(0, MAX_HINT_LEN - 1) + '…'
        : hint
    }
  }
  return null
}

// Abort infrastructure. Ctrl+C aborts the AbortController, which:
//   (a) cancels any in-flight LLM streaming HTTP request (provider.chat
//       passes `signal` to fetch), so a stalled SLV AI
//       stream unblocks immediately instead of waiting for timeout;
//   (b) fires SIGTERM at the active child process;
//   (c) flips `signal.aborted` so the provider tool-use loop (via
//       shouldAbortAfterTools) breaks instead of requesting another
//       turn.
// AbortController is single-shot — clearAbort() creates a fresh one at
// the start of each new user turn.
let abortController = new AbortController()

export function setCommandOutputCallback(
  cb: ((line: string) => void) | null,
  completeCb?: (() => void) | null,
  ansibleTaskCb?: ((taskName: string) => void) | null,
  progressHintCb?: ((hint: string) => void) | null,
) {
  onCommandOutput = cb
  onCommandComplete = completeCb ?? null
  onAnsibleTaskUpdate = ansibleTaskCb ?? null
  onProgressHint = progressHintCb ?? null
}

export function killActiveProcess() {
  abortController.abort()
  if (activeChildProcess) {
    try {
      activeChildProcess.kill('SIGTERM')
    } catch { /* ignore */ }
    activeChildProcess = null
  }
}

export function isAborted(): boolean {
  return abortController.signal.aborted
}

/**
 * AbortSignal to pass into SLV AI requests. Aborting this signal cancels the
 * in-flight HTTP stream so Ctrl+C is immediate even while the model is
 * still generating its first token.
 */
export function getAbortSignal(): AbortSignal {
  return abortController.signal
}

export function clearAbort() {
  abortController = new AbortController()
}

/**
 * Provider-loop helper. Call after pushing tool_results and before
 * requesting another LLM turn. If the user aborted (Ctrl+C), fires the
 * onComplete callback so the UI finalizes and returns true so the caller
 * can `break` out of its tool-use loop. Every provider uses the same
 * shape, so we keep the test + callback invocation in one place.
 */
export function shouldAbortAfterTools(
  onComplete: () => void,
): boolean {
  if (!abortController.signal.aborted) return false
  onComplete()
  return true
}

export type ToolDefinition = {
  name: string
  description: string
  parameters: Record<string, unknown>
}

// Core tools — safe orchestration helpers available after bootstrap
export const CORE_TOOLS: ToolDefinition[] = [
  {
    name: 'get_command_help',
    description:
      'Read the installed SLV subcommand help to verify its actual flags. This never executes the operation and needs no credentials.',
    parameters: {
      type: 'object',
      properties: { command: { type: 'string', enum: [...HELP_COMMANDS] } },
      required: ['command'],
    },
  },
  {
    name: 'enable_tools',
    description:
      'Enable additional tools when needed. Available extended tools: run_command, read_file, write_file, list_files, call_mcp, send_notification, delegate_to_agent. Call this to activate them before use.',
    parameters: {
      type: 'object',
      properties: {
        tools: {
          type: 'array',
          items: {
            type: 'string',
            enum: [
              'run_command',
              'read_file',
              'write_file',
              'list_files',
              'call_mcp',
              'send_notification',
              'delegate_to_agent',
            ],
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
      'Load additional context modules into your knowledge. Available: ssh_check, delegation, deploy, validator, cli_reference, mcp_reference, firewall, wireguard, backup. Call this BEFORE performing tasks that need specialized knowledge.',
    parameters: {
      type: 'object',
      properties: {
        modules: {
          type: 'array',
          items: {
            type: 'string',
            enum: [
              'ssh_check',
              'delegation',
              'deploy',
              'validator',
              'cli_reference',
              'mcp_reference',
              'firewall',
              'wireguard',
              'backup',
            ],
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
    name: 'run_command',
    description:
      'Execute a shell command on the system. Use this to run slv commands, check system status, manage services, etc. The user will be asked to confirm before execution. Only read-only commands can run without the user: a line of programs such as ls, cat, head, tail, grep, ps, df, free, journalctl, systemctl status, ss, ip addr and solana epoch-info, with no output redirection except to /dev/null, no assignment, no substitution, no parameter expansion with an operator such as ${X:-default}, no background job and no program named by a path. Every other command needs the user to confirm in a terminal, and is refused when none is attached; that includes sudo, shells and interpreters, curl, git, tar, awk, sed and find. Commands that change nodes or keys, touch credentials or run other commands are put to the user even in a line that looks read-only: ansible-playbook, ssh, scp, rsync, solana-keygen, op, rm -r/-f, the slv deploy, start, stop, restart, switch, set:identity and init verbs, agave-validator, solana-validator and fdctl (but for their version and monitor forms), systemctl and service verbs that change a unit, solana subcommands that sign, interpreters such as python, perl or node, programs that run their arguments, a command substitution, any path to a key, a wallet or a credential, and a recursive grep, rg or diff of a directory that may hold them: a home directory or one above it, anything under .slv or .ssh, /proc, a directory above or inside a key or wallet location (such as /etc, /etc/ssl, /dev, ~/.config and ~/slv), a relative path, a path with a glob or an expansion, or no path at all (rg searches its input instead when it follows a pipe or reads a file), and a ps that prints the environment of processes: the e option, in BSD syntax or in a word that ps reads again as BSD options, or an output format named environ. ' +
      AUTO_EXECUTE_NOTE,
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
      'Read the contents of a file. Use this to inspect configuration files, logs, etc. Keys, wallets and credentials are not readable. ' +
      AUTO_EXECUTE_NOTE +
      ' Prefer focused reads for large files by using offset/limit.',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Absolute path to the file to read',
        },
        offset: {
          type: 'number',
          description:
            'Optional 1-based starting line number for a focused read',
        },
        limit: {
          type: 'number',
          description: 'Optional maximum number of lines to return',
        },
        refresh: {
          type: 'boolean',
          description:
            'Optional bypass for the session cache. Set true to force a fresh read.',
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
      'Write content to a file under ~/.slv/. ~/.slv/agent/MEMORY.md is written without asking. Any other file needs the user to confirm the write in a terminal (the user sees the path, the size and the first 20 lines), and is not written in a session without a terminal: give the user the content and the path, and ask them to write the file themselves. Not written at all: keys, credentials, ~/.slv/api.yml, the agent config ~/.slv/agent/config.yml, ~/.slv/template, ~/.slv/bin and ~/.slv/known_hosts.',
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
      'Call one of a fixed set of read-only SLV Cloud endpoints (all GET) — check user info, subscriptions, server/VPS inventory, usage, and status. There is no purchase, payment-link, or IP-registration tool here; send the user to https://dashboard.erpc.global for those. The ERPC login from ~/.slv/api.yml (`slv login`) is used automatically.',
    parameters: {
      type: 'object',
      properties: {
        tool_name: {
          type: 'string',
          description:
            'MCP tool name (e.g. get_user_get, get_baremetal_list_public_node_type, get_grpc_status)',
        },
        arguments: {
          type: 'object',
          description: 'Arguments to pass to the MCP tool',
        },
        refresh: {
          type: 'boolean',
          description:
            'Optional bypass for the session cache on cacheable read-only MCP calls.',
        },
      },
      required: ['tool_name'],
    },
  },
  {
    name: 'send_notification',
    description:
      'Send a notification to the user via Discord webhook (configured under `notifications.discord_webhook` in ~/.slv/api.yml via `slv onboard`). Use after completing long-running tasks like deployments, and whenever the user asks you to push content — payment links, benchmark summaries, deploy results — to Discord.',
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

// Session cache for demand-driven reads/API calls
let readFileCache: Map<string, string> = new Map()
let mcpResponseCache: Map<string, string> = new Map()

function invalidateReadFileCache(): void {
  readFileCache = new Map()
}

function invalidateMcpCache(): void {
  mcpResponseCache = new Map()
}

function isCacheableMcpTool(toolName: string): boolean {
  return toolName.startsWith('get_')
}

function buildReadFileCacheKey(
  path: string,
  offset?: number,
  limit?: number,
): string {
  return JSON.stringify({ path, offset: offset ?? null, limit: limit ?? null })
}

async function buildMcpCacheKey(
  toolName: string,
  args: Record<string, unknown>,
  auth: UserApiAuth,
): Promise<string> {
  // A login/refresh in another terminal must not reuse the previous login's
  // account data. Keep only a digest in the cache key, never the credential.
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(await userApiAuthHeader(auth)),
  )
  const authScope = [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0')).join('')
  return JSON.stringify({ toolName, args, authScope })
}

// Get the current active tool set (core + enabled extended tools)
export function getActiveTools(): ToolDefinition[] {
  const extended = EXTENDED_TOOLS.filter((t) => activeExtendedTools.has(t.name))
  return [...CORE_TOOLS, ...extended]
}

// Reset active extended tools (call at session start)
export function resetActiveTools(): void {
  activeExtendedTools = new Set()
}

export function activateExtendedTools(tools: string[]): string[] {
  const validNames = new Set(EXTENDED_TOOLS.map((t) => t.name))
  const enabled: string[] = []
  for (const toolName of tools) {
    if (!validNames.has(toolName) || activeExtendedTools.has(toolName)) continue
    activeExtendedTools.add(toolName)
    enabled.push(toolName)
  }
  return enabled
}

export function resetSessionCaches(): void {
  invalidateReadFileCache()
  invalidateMcpCache()
}

// Legacy export for backward compatibility (all tools)
export const TOOL_DEFINITIONS: ToolDefinition[] = [
  ...CORE_TOOLS,
  ...EXTENDED_TOOLS,
]

// Tools available to sub-agents (no delegation or lazy-enable meta-tool needed)
export const SUB_AGENT_TOOL_DEFINITIONS: ToolDefinition[] = TOOL_DEFINITIONS
  .filter((t) => t.name !== 'delegate_to_agent' && t.name !== 'enable_tools')

export async function executeTool(
  name: string,
  args: Record<string, unknown>,
): Promise<string> {
  switch (name) {
    case 'get_command_help':
      return await getCommandHelp(String(args.command ?? ''))
    case 'run_command':
      return await redactSecretKeys(
        await executeRunCommand(String(args.command || '')),
      )
    case 'read_file':
      return await redactSecretKeys(
        await executeReadFile(
          String(args.path || ''),
          Number.isFinite(Number(args.offset))
            ? Number(args.offset)
            : undefined,
          Number.isFinite(Number(args.limit)) ? Number(args.limit) : undefined,
          args.refresh === true,
        ),
      )
    case 'enable_tools': {
      const requested = (args.tools as string[]) || []
      const validNames = new Set(EXTENDED_TOOLS.map((t) => t.name))
      const enabled = activateExtendedTools(requested)
      const invalid = requested.filter((toolName) => !validNames.has(toolName))
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
      return await executeWriteFile(
        String(args.path || ''),
        String(args.content || ''),
      )
    case 'call_mcp': {
      // Auto-load MCP reference context if not loaded
      if (!isModuleLoaded('mcp_reference')) {
        loadContextModules(['mcp_reference'])
      }
      return await executeCallMcp(
        String(args.tool_name || ''),
        (args.arguments as Record<string, unknown>) || {},
        args.refresh === true,
      )
    }
    case 'send_notification':
      return await executeSendNotification(String(args.message || ''))
    case 'delegate_to_agent': {
      // Auto-load delegation context if not loaded
      if (!isModuleLoaded('delegation')) {
        loadContextModules(['delegation'])
      }
      // The specialist loads its own skill docs; do not duplicate them in the main prompt.
      const agentName = String(args.agent || '')
      return await executeDelegateToAgent(agentName, String(args.task || ''))
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

// Hard guard against destructive operations on wallet.json, ~/.slv, and
// ~/slv/<bot> project directories. This runs before any confirmation or spawn,
// so it cannot be bypassed by auto-execute mode or by the agent rephrasing a
// confirm dialog. Returns a reason string if the command must be blocked, or
// null if it is allowed through.
function checkWalletGuard(command: string): string | null {
  const home = '(~|\\$HOME|/Users/[^/\\s\'"]+|/home/[^/\\s\'"]+)'
  const rmFlags = '\\s+-[a-zA-Z]*[rRfF][a-zA-Z]*'
  const patterns: { re: RegExp; reason: string }[] = [
    {
      re: /\brm\b[^\n]*\bwallet\.json\b/,
      reason:
        'refusing to delete wallet.json (contains the trading wallet private key)',
    },
    {
      re: />\s*wallet\.json\b/,
      reason:
        'refusing to truncate or overwrite wallet.json via shell redirect',
    },
    {
      re: new RegExp(`\\brm${rmFlags}\\s+[^\\n]*${home}/\\.slv(/|\\s|$|['"])`),
      reason:
        'refusing rm -rf on ~/.slv (holds api.yml, agent config, and credentials)',
    },
    {
      re: new RegExp(
        `\\brm${rmFlags}\\s+[^\\n]*${home}/slv(/[^\\s'"]+)?(\\s|$|['"])`,
      ),
      reason:
        'refusing rm -rf on ~/slv or a ~/slv/<bot> directory (bot projects contain wallet.json). Delegate bot cleanup to Setzer, or use `slv bot init` which has a built-in wallet rescue layer.',
    },
  ]
  for (const { re, reason } of patterns) {
    if (re.test(command)) return reason
  }
  return null
}

async function executeRunCommand(command: string): Promise<string> {
  const guardReason = checkWalletGuard(command)
  if (guardReason !== null) {
    const msg = `Command blocked by wallet safety guard: ${guardReason}\n\n` +
      `Command: ${command}\n\n` +
      `This is a hard guard that runs before confirmation to protect wallet.json and ~/.slv from accidental deletion. Do not retry with a rephrased command — either delegate to the Setzer sub-agent (agent='Setzer') for bot/app work, or ask the user to run the command manually if they truly intend it.`
    if (!tuiInstance) {
      console.log(`  ✗ ${msg}`)
    }
    return msg
  }

  const tui = tuiInstance
  const classification = classifyCommand(command)
  const readOnly = isReadOnlyLine(command)
  const decision = decideCommandGate({
    gated: classification.gated,
    autoExecute: autoExecuteCommands,
    hasTerminal: tui !== null,
    readOnly: readOnly.readOnly,
    forbidden: classification.forbidden.length > 0,
  })

  if (decision === 'refuse') {
    const msg = describeRefusal(command, classification, {
      autoExecute: autoExecuteCommands,
      notReadOnly: readOnly.reasons,
    })
    console.log(`  ✗ ${msg.split('\n')[0]}`)
    return msg
  }

  let humanConfirmed = false
  if (decision === 'confirm' && tui !== null) {
    tui.stop()
    console.log(`\n  Tool: run_command`)
    console.log(`  $ ${command}`)
    if (classification.gated) {
      console.log(
        `  ! This command may change nodes or keys, touch credentials or run another command (${
          classification.reasons.join(', ')
        }).`,
      )
    } else if (autoExecuteCommands && !readOnly.readOnly) {
      console.log(
        `  ! Auto-execute runs read-only commands only, and this one is not read-only (${
          readOnly.reasons.join(', ')
        }).`,
      )
    }
    const confirmed = await Confirm.prompt({
      message: 'Execute this command?',
      default: !classification.gated,
    })
    tui.start()
    tui.requestRender(true)
    if (!confirmed) {
      return 'User declined to execute the command.'
    }
    humanConfirmed = true
  } else if (tui === null) {
    // No terminal: just show what's running
    console.log(`  ▸ ${command}`)
  }

  // Both timers are cleared when the command ends, on every exit path.
  let hardTimer: ReturnType<typeof setTimeout> | undefined
  let inactivityTimer: ReturnType<typeof setTimeout> | undefined
  let timersStopped = false
  try {
    // The shell gets an allow-listed environment, in a session of its own.
    // Host key checking stays on: new hosts are added, changed keys fail.
    const env = buildCommandEnv(Deno.env.toObject(), await readLang(), {
      humanConfirmed,
    })
    const invocation = buildShellInvocation(
      command,
      findExecutable('setsid', Deno.env.get('PATH')),
    )
    const proc = new Deno.Command(invocation.command, {
      args: invocation.args,
      stdin: 'null',
      stdout: 'piped',
      stderr: 'piped',
      env,
      clearEnv: true,
    })
    const child = proc.spawn()
    // Store child process so it can be killed on Ctrl+C
    activeChildProcess = child

    // Detect ansible commands to use task-title spinner mode
    const isAnsibleCommand = command.includes('ansible-playbook') ||
      command.includes('ansible ')

    // Stream stdout lines to TUI in real-time
    const stdoutChunks: string[] = []
    const stderrChunks: string[] = []
    // Heartbeat timestamp — updated on every byte read from either
    // stream. Used by the inactivity watcher below to detect truly
    // stuck subprocesses (waiting on stdin, hung network, zombie
    // state) vs. legitimately slow-but-progressing ones.
    let lastOutputMs = Date.now()

    const readStream = async (
      stream: ReadableStream<Uint8Array>,
      chunks: string[],
      isStdout: boolean,
    ) => {
      const reader = stream.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        lastOutputMs = Date.now()
        const text = decoder.decode(value, { stream: true })
        buffer += text
        chunks.push(text)

        {
          const lines = buffer.split('\n')
          buffer = lines.pop() || ''
          for (const line of lines) {
            const trimmed = line.trim()
            if (!trimmed) continue

            if (isAnsibleCommand && onAnsibleTaskUpdate) {
              // In ansible mode: only extract TASK titles for spinner
              if (isStdout) {
                const taskMatch = trimmed.match(/^TASK \[(.+?)\]/)
                if (taskMatch) {
                  onAnsibleTaskUpdate(taskMatch[1])
                }
                if (trimmed.startsWith('PLAY RECAP')) {
                  onAnsibleTaskUpdate('Finishing up...')
                }
              }
              // Don't stream raw ansible output to TUI
            } else if (onCommandOutput) {
              // Normal mode: stream both stdout and stderr
              onCommandOutput(trimmed)
              // Extract a "current step" hint for the spinner label so the
              // user can see WHAT the command is doing right now — during a
              // 5-minute cargo build the static "Running: cargo build" label
              // is indistinguishable from a hang.
              if (onProgressHint) {
                const hint = extractProgressHint(trimmed)
                if (hint) onProgressHint(hint)
              }
            }
          }
        }
      }
      // Flush remaining buffer
      if (!isAnsibleCommand && onCommandOutput && buffer.trim()) {
        onCommandOutput(buffer.trim())
      }
    }

    // Two timeouts guard every subprocess:
    //   - Hard ceiling (60 min) — for builds/snapshots that legitimately
    //     run long. Kept as a seat belt against forgotten orphans.
    //   - Inactivity (2 min) — kills a subprocess that produced no
    //     output for the window. Catches truly hung processes (waiting
    //     on stdin, blocked network, dead loops) so the agent can
    //     report back to the user instead of freezing the chat.
    //     Legitimate long silent steps (cargo linking, npm resolve)
    //     usually emit something every 30–60 s; 2 min leaves headroom.
    const COMMAND_TIMEOUT_MS = 3_600_000
    const INACTIVITY_TIMEOUT_MS = 120_000
    const timeoutPromise = new Promise<'timeout'>((resolve) => {
      hardTimer = setTimeout(() => resolve('timeout'), COMMAND_TIMEOUT_MS)
    })
    const inactivityPromise = new Promise<'inactivity'>((resolve) => {
      const tick = () => {
        if (timersStopped) return
        if (Date.now() - lastOutputMs >= INACTIVITY_TIMEOUT_MS) {
          resolve('inactivity')
          return
        }
        inactivityTimer = setTimeout(tick, 1_000)
      }
      inactivityTimer = setTimeout(tick, 1_000)
    })

    const commandPromise = (async () => {
      await Promise.all([
        readStream(child.stdout, stdoutChunks, true),
        readStream(child.stderr, stderrChunks, false),
      ])
      return await child.status
    })()

    const result = await Promise.race([
      commandPromise,
      timeoutPromise,
      inactivityPromise,
    ])

    if (result === 'timeout' || result === 'inactivity') {
      try {
        child.kill('SIGTERM')
      } catch { /* ignore */ }
      // Wait for the stream readers to settle so we don't keep pushing
      // into stdoutChunks / firing onCommandOutput after the function
      // returns — the child is killed, streams close fast.
      await commandPromise.catch(() => {})
      activeChildProcess = null
      if (onCommandComplete) onCommandComplete()
      const stdout = await redactSecretKeys(stdoutChunks.join(''))
      const tail = stdout.slice(-2000)
      if (result === 'inactivity') {
        return `Command stopped — no output for ${
          INACTIVITY_TIMEOUT_MS / 1000
        } seconds (likely hung on stdin, blocked network, or an infinite loop). Partial output:\n${tail}\n\nTell the user the command was stopped and suggest one of: (a) re-run it manually in a shell where they can watch progress, (b) try a non-interactive variant with explicit flags, (c) check network / prerequisite (e.g. RPC reachability) before retrying.`
      }
      return `Command timed out after 60 minutes.\nPartial output:\n${tail}`
    }

    const status = result
    const stdout = await redactSecretKeys(stdoutChunks.join(''))
    const stderr = await redactSecretKeys(stderrChunks.join(''))

    // Aborted by user (Ctrl+C). Return a clear marker so the LLM knows the
    // command didn't complete — and the provider loop sees isAborted() and
    // stops requesting further turns.
    if (abortController.signal.aborted) {
      activeChildProcess = null
      if (onCommandComplete) onCommandComplete()
      return `Command aborted by user (Ctrl+C).\nPartial stdout (last 1000 chars):\n${
        stdout.slice(-1000)
      }`
    }

    // Save full ansible output to log file for debugging
    if (isAnsibleCommand) {
      try {
        const logDir = `${Deno.env.get('HOME') || '/tmp'}/.slv/logs`
        await Deno.mkdir(logDir, { recursive: true })
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
        const logPath = `${logDir}/ansible-${timestamp}.log`
        const logContent =
          `Command: ${command}\nExit code: ${status.code}\nTimestamp: ${
            new Date().toISOString()
          }\n\n--- STDOUT ---\n${stdout}\n\n--- STDERR ---\n${stderr}`
        await Deno.writeTextFile(logPath, logContent)
        // Rotate: keep only the last 10 log files
        const entries: string[] = []
        for await (const entry of Deno.readDir(logDir)) {
          if (
            entry.isFile && entry.name.startsWith('ansible-') &&
            entry.name.endsWith('.log')
          ) {
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
        const logHint =
          `\nFull log saved to ~/.slv/logs/ for detailed debugging.`
        const lastStdout = stdout.slice(-3000)
        const lastStderr = stderr.slice(-2000)
        return `Command failed (exit code ${status.code}):\nstdout (last 3000 chars):\n${lastStdout}\nstderr (last 2000 chars):\n${lastStderr}${logHint}`
      }
      return `Command failed (exit code ${status.code}):\nstdout:\n${stdout}\nstderr:\n${stderr}`
    }
    activeChildProcess = null
    if (onCommandComplete) onCommandComplete()
    invalidateReadFileCache()
    invalidateMcpCache()

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
      const recapIdx = lines.findIndex((l: string) =>
        l.trim().startsWith('PLAY RECAP')
      )
      const recapLines = recapIdx >= 0
        ? lines.slice(recapIdx, recapIdx + 20).filter((l: string) => l.trim())
        : []
      const summary = [...new Set([...taskLines, ...recapLines])].join('\n')
      const logNote = '\nFull log saved to ~/.slv/logs/ for detailed debugging.'
      return (summary || 'Ansible playbook completed successfully.') + logNote
    }

    // Cap non-ansible output to avoid excessive token usage on unexpectedly large outputs
    if (stdout.length > 10000) {
      return stdout.slice(-10000) +
        '\n... (output truncated to last 10000 chars)'
    }
    return stdout || '(no output)'
  } catch (error) {
    activeChildProcess = null
    if (onCommandComplete) onCommandComplete()
    return `Error executing command: ${(error as Error).message}`
  } finally {
    timersStopped = true
    clearTimeout(hardTimer)
    clearTimeout(inactivityTimer)
  }
}

async function executeReadFile(
  path: string,
  offset?: number,
  limit?: number,
  refresh = false,
): Promise<string> {
  const refusal = await fileToolRefusal('read_file', path)
  if (refusal !== null) return refusal
  const cacheKey = buildReadFileCacheKey(path, offset, limit)
  if (!refresh) {
    const cached = readFileCache.get(cacheKey)
    if (cached) return `${cached}\n\n[session cache hit]`
  }

  try {
    const raw = await Deno.readTextFile(path)
    if (/^\s*-----BEGIN/.test(raw) && raw.includes('PRIVATE KEY')) {
      return 'Error: read_file does not read a private key. Ask the user to handle it outside the AI console.'
    }
    const content = await redactSecretKeys(raw)
    const lines = content.split('\n')
    const totalLines = lines.length
    const startLine = Number.isFinite(offset) && offset && offset > 0
      ? Math.floor(offset)
      : 1
    const maxLines = Number.isFinite(limit) && limit && limit > 0
      ? Math.floor(limit)
      : 200
    const endLine = Math.min(totalLines, startLine + maxLines - 1)
    const slice = lines.slice(startLine - 1, endLine)
    const body = slice.join('\n')

    let result = body
    if (startLine > 1 || endLine < totalLines) {
      result =
        `Showing ${startLine}-${endLine} of ${totalLines} lines from ${path}\n${body}`
    } else if (totalLines > maxLines) {
      result = body + `\n\n... (truncated, ${totalLines} total lines)`
    }

    readFileCache.set(cacheKey, result)
    return result
  } catch (error) {
    return `Error reading file: ${(error as Error).message}`
  }
}

async function executeListFiles(path: string): Promise<string> {
  const refusal = await fileToolRefusal('list_files', path)
  if (refusal !== null) return refusal
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

async function executeWriteFile(
  path: string,
  content: string,
): Promise<string> {
  const refusal = await fileToolRefusal('write_file', path)
  if (refusal !== null) return refusal

  // The file written is the path that was checked and shown.
  const target = normalize(path)
  const tui = tuiInstance
  const decision = decideWriteFile({
    memoryFile: await isAgentMemoryFile(target),
    hasTerminal: tui !== null,
  })

  if (decision === 'refuse') {
    const msg = describeWriteRefusal(target)
    console.log(`  ✗ ${msg.split('\n')[0]}`)
    return msg
  }

  if (decision === 'confirm' && tui !== null) {
    let existingBytes: number | null = null
    try {
      existingBytes = (await Deno.stat(target)).size
    } catch { /* there is no file yet */ }
    tui.stop()
    console.log(`\n  Tool: write_file`)
    for (const line of describeWrite(target, content, existingBytes)) {
      console.log(line)
    }
    const confirmed = await Confirm.prompt({
      message: 'Write this file?',
      default: false,
    })
    tui.start()
    tui.requestRender(true)
    if (!confirmed) {
      return `User declined to write ${target}. The file is unchanged.`
    }
  }

  try {
    // Ensure parent directory exists
    const parentDir = target.substring(0, target.lastIndexOf('/'))
    if (parentDir) {
      await Deno.mkdir(parentDir, { recursive: true })
    }
    await Deno.writeTextFile(target, content)
    invalidateReadFileCache()
    return `Successfully wrote to ${target}`
  } catch (error) {
    return `Error writing file: ${(error as Error).message}`
  }
}

const MCP_MAX_RESPONSE_CHARS = 5000

async function executeCallMcp(
  toolName: string,
  args: Record<string, unknown>,
  refresh = false,
): Promise<string> {
  const login = await resolveUserApiAuth()
  if (!login.ok) {
    invalidateMcpCache()
    return `Error: ${login.lines.join('\n')}`
  }
  const auth = login.auth
  const cacheable = isCacheableMcpTool(toolName)
  try {
    const cacheKey = await buildMcpCacheKey(toolName, args, auth)
    if (cacheable && !refresh) {
      const cached = mcpResponseCache.get(cacheKey)
      if (cached) return `${cached}\n\n[session cache hit]`
    }
    const content = await callReadTool(
      auth,
      toolName,
      args || {},
    )
    const result = content.length > MCP_MAX_RESPONSE_CHARS
      ? content.slice(0, MCP_MAX_RESPONSE_CHARS) + '\n... (truncated)'
      : content
    if (cacheable && !isReadToolFailure(content)) {
      mcpResponseCache.set(cacheKey, result)
    } else {
      mcpResponseCache.delete(cacheKey)
    }
    return result
  } catch (error) {
    invalidateMcpCache()
    return `MCP request failed: ${(error as Error).message}`
  }
}

async function readDiscordWebhook(): Promise<string | undefined> {
  const home = resolveHome()
  // Primary location: ~/.slv/api.yml (written by `slv onboard`).
  // Legacy fallback: ~/.slv/agent/config.yml (older installs).
  const candidatePaths = [
    `${home}/.slv/api.yml`,
    `${home}/.slv/agent/config.yml`,
  ]

  for (const path of candidatePaths) {
    try {
      const raw = await Deno.readTextFile(path)
      const config = parse(raw) as Record<string, unknown> | null
      const notifications = config?.notifications as
        | Record<string, string>
        | undefined
      const webhook = notifications?.discord_webhook?.trim()
      if (webhook) return webhook
    } catch {
      // file missing or unreadable — try the next candidate
    }
  }
  return undefined
}

/**
 * Report whether a Discord webhook is configured without exposing the URL.
 * The system-prompt builder uses this so the main agent can proactively
 * offer Discord delivery of long outputs (payment links, benchmark
 * summaries, deploy results) without ever seeing the webhook URL itself.
 */
export async function hasDiscordWebhookConfigured(): Promise<boolean> {
  const webhook = await readDiscordWebhook()
  return Boolean(webhook)
}

async function executeSendNotification(message: string): Promise<string> {
  try {
    const webhook = await readDiscordWebhook()

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

async function executeDelegateToAgent(
  agentName: string,
  task: string,
): Promise<string> {
  // Tina covers all RPC types including gRPC Geyser streaming nodes.
  // Older agent configs may still reference the legacy "Cloud" label —
  // map it to Tina so those configs keep working after an upgrade.
  const effectiveName = agentName === 'Cloud' ? 'Tina' : agentName
  if (!isKnownAgentId(effectiveName)) {
    return `Unknown agent: ${agentName}. Available agents: ${
      ALL_AGENT_IDS.join(', ')
    }`
  }

  const ctx = await loadAgentContext()
  const home = ctx.home
  const skillNames = ctx.skillSourcesByAgent[effectiveName] ?? []

  // Collect AGENT.md and SKILL.md bodies for every skill registered to
  // this agent. Each block is section-headed with the skill name so the
  // sub-agent can tell sources apart. Missing files are skipped silently
  // (e.g. when the user has not run `slv skills sync` yet) — the loader
  // already emitted a warning for these cases at startup.
  const agentMdBlocks: string[] = []
  const skillMdBlocks: string[] = []
  for (const skillName of skillNames) {
    try {
      const md = await Deno.readTextFile(resolveAgentMdPath(skillName, home))
      agentMdBlocks.push(`## Agent doc: ${skillName}\n${md}`)
    } catch { /* AGENT.md optional per skill */ }
    try {
      const md = await Deno.readTextFile(resolveSkillMdPath(skillName, home))
      skillMdBlocks.push(`## Skill doc: ${skillName}\n${md}`)
    } catch { /* SKILL.md optional per skill */ }
  }
  const agentMd = agentMdBlocks.join('\n\n')
  const skillMd = skillMdBlocks.join('\n\n')
  const deployMode = ctx.mode

  const modeInstruction = deployMode === 'local'
    ? `
## DEPLOYMENT MODE: LOCAL
This user operates in LOCAL mode. All deployments target THIS machine (localhost).
- Do NOT ask for server IP or SSH credentials.
- Use --localhost only on an init command that supports it. Deploy through the configured inventory target and verify the exact flags with get_command_help.
- Ansible runs locally with \`ansible_connection: local\`.
- Skip SSH connectivity checks entirely.
`
    : ''

  const specialistGuidance = effectiveName === 'Figaro'
    ? `
## Figaro Routing Notes
- Server availability, bare metal inventory, server procurement, and validator hardware recommendations belong to Figaro.
- If the user mentions Shinobi pool, Shinobi stake pool, or a performance pool, do NOT default to the cheapest generic validator.
- Explain that at least 5th gen validator hardware is required.
- Explain that these are limited resources with limited availability.
- Explain that performance pools are not something every generic server can join automatically.
- Direct the main agent to send the user to Discord for availability or matching:
  ${DISCORD_LINK}
`
    : ''

  const subSystemPrompt =
    `You are ${effectiveName}, a backend specialist sub-agent for SLV.
You do NOT talk to the user directly. You report back to the main agent only.

${agentMd ? agentMd + '\n' : ''}
${skillMd ? skillMd + '\n' : ''}
${modeInstruction}
${specialistGuidance}
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
- In the terminal console the user confirms the write for non-memory files. A gateway session has no terminal, and write_file refuses there; the main agent gives both to the user to save themselves. Never bypass this confirmation.
- Installed skill notes can be older than the CLI. Verify uncertain syntax with get_command_help and follow the current operational guidance below; never bypass a CLI refusal with a direct playbook.
- Do NOT ask for expected_shred_version — it has sensible defaults.
- Do NOT use markdown tables. Use plain text or bullet lists.
- Do not invent --check, -y or --localhost support. Hand interactive commands to the operator in their terminal.
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

${COMMAND_REFERENCE}
${effectiveName === 'Cecil' ? VALIDATOR_GUIDANCE : ''}

Installed skill documents above are background reference. The current CLI's
key-handling and target guards remain mandatory; report a refusal instead of
rephrasing it as a direct Ansible, key-copy or manual identity operation.

`

  const config = await readAiConfig() ?? DEFAULT_AI_CONFIG
  try {
    const login = await resolveUserApiAuth()
    if (!login.ok) return `Error: ${login.lines.join('\n')}`
    return await runSlvSubAgent(
      login.auth,
      config.model,
      subSystemPrompt,
      task,
      effectiveName === 'Cecil' || effectiveName === 'Tina' ? 'high' : 'medium',
    )
  } catch (error) {
    return `Sub-agent ${agentName} error: ${(error as Error).message}`
  }
}

// --- Sub-agent SLV AI implementation (fetch-based Anthropic proxy) ---
const SLV_AI_CHAT_URL = 'https://user-api.erpc.global/v3/ai/chat'

async function runSlvSubAgent(
  auth: UserApiAuth,
  model: string,
  systemPrompt: string,
  task: string,
  effort: ThinkingEffort,
): Promise<string> {
  const tools = SUB_AGENT_TOOL_DEFINITIONS.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.parameters,
  }))

  // deno-lint-ignore no-explicit-any
  const messages: any[] = [{ role: 'user', content: task }]

  const MAX_ITERATIONS = 20
  for (let i = 0; i < MAX_ITERATIONS; i++) {
    const res = await fetch(SLV_AI_CHAT_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': await userApiAuthHeader(auth),
      },
      body: JSON.stringify({
        model: model === 'SLV AI' ? 'slv-ai-default' : model,
        max_tokens: DEFAULT_MAX_TOKENS,
        output_config: { effort },
        thinking: { type: 'adaptive', display: 'omitted' },
        cache_control: { type: 'ephemeral' },
        system: systemPrompt,
        messages,
        tools,
      }),
      signal: AbortSignal.timeout(600_000),
    })

    if (!res.ok) {
      throw await readUserApiError(res)
    }

    // deno-lint-ignore no-explicit-any
    const data = await res.json() as any
    if (!data || !Array.isArray(data.content)) {
      throw new Error(
        `SLV AI returned unexpected response: ${
          JSON.stringify(data).slice(0, 200)
        }`,
      )
    }

    if (data.stop_reason === 'max_tokens') {
      throw new Error(
        'The specialist reached its output limit. Tool requests from that response were not executed.',
      )
    }

    let textContent = ''
    const toolUseBlocks: {
      id: string
      name: string
      input: Record<string, unknown>
    }[] = []
    for (const block of data.content) {
      if (block.type === 'text') {
        textContent += block.text
      } else if (block.type === 'tool_use') {
        if (
          !block.input || typeof block.input !== 'object' ||
          Array.isArray(block.input)
        ) {
          throw new Error(
            'The specialist returned invalid tool arguments. That request was not executed.',
          )
        }
        toolUseBlocks.push({
          id: block.id,
          name: block.name,
          input: block.input as Record<string, unknown>,
        })
      }
    }

    messages.push({ role: 'assistant', content: data.content })

    if (toolUseBlocks.length === 0 || data.stop_reason === 'end_turn') {
      return textContent || '(no response from sub-agent)'
    }

    // Execute tools
    // deno-lint-ignore no-explicit-any
    const toolResults: any[] = []
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
