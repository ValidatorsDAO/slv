import { resolveHome } from '/lib/getApiKeyFromYml.ts'
import { Confirm } from '@cliffy/prompt'
import Anthropic from '@anthropic-ai/sdk'
import OpenAI from 'openai'
import { DEFAULT_MAX_TOKENS, readAiConfig, readLang } from '@/ai/config.ts'
import { parse } from '@std/yaml'
import type { TUI } from '@mariozechner/pi-tui'
import {
  injectSkillDocs,
  isModuleLoaded,
  loadContextModules,
} from '@/ai/console/systemPrompt.ts'
import { DISCORD_LINK } from '@cmn/constants/url.ts'
import { loadAgentContext } from '@/ai/agentConfig/loader.ts'
import {
  isKnownAgentId,
  ALL_AGENT_IDS,
} from '@/ai/agentConfig/registry.ts'
import {
  resolveAgentMdPath,
  resolveSkillMdPath,
} from '@/ai/agentConfig/paths.ts'

// TUI instance for suspend/resume during confirm prompts
let tuiInstance: TUI | null = null
let autoExecuteCommands = true // Default: auto-execute without confirmation

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
//       passes `signal` to the SDK), so a stalled Anthropic/OpenAI
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
 * AbortSignal to pass into LLM SDK calls (Anthropic `messages.stream`,
 * OpenAI `chat.completions.create`). Aborting this signal cancels the
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
      'Load additional context modules into your knowledge. Available: ssh_check, delegation, deploy, validator, cli_reference, mcp_reference. Call this BEFORE performing tasks that need specialized knowledge.',
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
      'Read the contents of a file. Use this to inspect configuration files, logs, keys, etc. Prefer focused reads for large files by using offset/limit.',
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

function buildMcpCacheKey(
  toolName: string,
  args: Record<string, unknown>,
): string {
  return JSON.stringify({ toolName, args })
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
    case 'run_command':
      return await executeRunCommand(String(args.command || ''))
    case 'read_file':
      return await executeReadFile(
        String(args.path || ''),
        Number.isFinite(Number(args.offset)) ? Number(args.offset) : undefined,
        Number.isFinite(Number(args.limit)) ? Number(args.limit) : undefined,
        args.refresh === true,
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
      // Auto-inject skill docs for the target agent
      const agentName = String(args.agent || '')
      await injectSkillDocs(agentName)
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
      reason: 'refusing to truncate or overwrite wallet.json via shell redirect',
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
    const msg =
      `Command blocked by wallet safety guard: ${guardReason}\n\n` +
      `Command: ${command}\n\n` +
      `This is a hard guard that runs before confirmation to protect wallet.json and ~/.slv from accidental deletion. Do not retry with a rephrased command — either delegate to the Setzer sub-agent (agent='Setzer') for bot/app work, or ask the user to run the command manually if they truly intend it.`
    if (!tuiInstance) {
      console.log(`  ✗ ${msg}`)
    }
    return msg
  }

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
      ANSIBLE_SSH_ARGS:
        '-o StrictHostKeyChecking=accept-new -o UserKnownHostsFile=/dev/null -o PasswordAuthentication=no',
      ANSIBLE_STDOUT_CALLBACK: 'default',
      ANSIBLE_DISPLAY_ARGS_TO_STDOUT: 'False',
      PYTHONUNBUFFERED: '1',
      TRADE_APP_LANG: await readLang(),
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
    const timeoutPromise = new Promise<'timeout'>((resolve) =>
      setTimeout(() => resolve('timeout'), COMMAND_TIMEOUT_MS)
    )
    const inactivityPromise = new Promise<'inactivity'>((resolve) => {
      const tick = () => {
        if (Date.now() - lastOutputMs >= INACTIVITY_TIMEOUT_MS) {
          resolve('inactivity')
          return
        }
        setTimeout(tick, 1_000)
      }
      setTimeout(tick, 1_000)
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
      const stdout = stdoutChunks.join('')
      const tail = stdout.slice(-2000)
      if (result === 'inactivity') {
        return `Command stopped — no output for ${
          INACTIVITY_TIMEOUT_MS / 1000
        } seconds (likely hung on stdin, blocked network, or an infinite loop). Partial output:\n${tail}\n\nTell the user the command was stopped and suggest one of: (a) re-run it manually in a shell where they can watch progress, (b) try a non-interactive variant with explicit flags, (c) check network / prerequisite (e.g. RPC reachability) before retrying.`
      }
      return `Command timed out after 60 minutes.\nPartial output:\n${tail}`
    }

    const status = result
    const stdout = stdoutChunks.join('')
    const stderr = stderrChunks.join('')

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
  }
}

async function executeReadFile(
  path: string,
  offset?: number,
  limit?: number,
  refresh = false,
): Promise<string> {
  const cacheKey = buildReadFileCacheKey(path, offset, limit)
  if (!refresh) {
    const cached = readFileCache.get(cacheKey)
    if (cached) return `${cached}\n\n[session cache hit]`
  }

  try {
    const content = await Deno.readTextFile(path)
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
    invalidateReadFileCache()
    return `Successfully wrote to ${path}`
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
  const cacheable = isCacheableMcpTool(toolName)
  const cacheKey = buildMcpCacheKey(toolName, args)
  if (cacheable && !refresh) {
    const cached = mcpResponseCache.get(cacheKey)
    if (cached) return `${cached}\n\n[session cache hit]`
  }

  const mcpCtx = await loadAgentContext()
  const apiKey = mcpCtx.raw.api.slv.api_key ?? ''
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

    const content = data.result?.content?.[0]?.text ||
      JSON.stringify(data.result)
    const result = content.length > MCP_MAX_RESPONSE_CHARS
      ? content.slice(0, MCP_MAX_RESPONSE_CHARS) + '\n... (truncated)'
      : content
    if (cacheable) {
      mcpResponseCache.set(cacheKey, result)
    }
    return result
  } catch (error) {
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
- Use \`--localhost\` flag for ALL init/deploy commands.
- Examples: \`slv v init --localhost\`, \`slv v deploy --localhost\`, \`slv r init --localhost\`, \`slv r deploy --localhost\`
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
      return await runAnthropicSubAgent(
        config.api_key,
        config.model,
        subSystemPrompt,
        task,
      )
    } else if (config.provider === 'slv') {
      const subCtx = await loadAgentContext()
      const slvApiKey = subCtx.raw.api.slv.api_key ?? ''
      if (!slvApiKey) {
        return 'Error: SLV API Key not found. Run `slv login` first.'
      }
      return await runSlvSubAgent(
        slvApiKey,
        config.model,
        subSystemPrompt,
        task,
      )
    } else {
      return await runOpenAISubAgent(
        config.api_key,
        config.model,
        subSystemPrompt,
        task,
      )
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
    const toolUseBlocks: {
      id: string
      name: string
      input: Record<string, unknown>
    }[] = []
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

// --- Sub-agent SLV AI implementation (fetch-based Anthropic proxy) ---
const SLV_AI_CHAT_URL = 'https://user-api.erpc.global/v3/ai/chat'

async function runSlvSubAgent(
  apiKey: string,
  model: string,
  systemPrompt: string,
  task: string,
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
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        max_tokens: DEFAULT_MAX_TOKENS,
        system: systemPrompt,
        messages,
        tools,
      }),
      signal: AbortSignal.timeout(600_000),
    })

    if (!res.ok) {
      const errText = await res.text().catch(() => '')
      throw new Error(`SLV AI API error (${res.status}): ${errText}`)
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

// --- Sub-agent OpenAI implementation ---
async function runOpenAISubAgent(
  apiKey: string,
  model: string,
  systemPrompt: string,
  task: string,
): Promise<string> {
  const client = new OpenAI({ apiKey })
  const tools: OpenAI.ChatCompletionTool[] = SUB_AGENT_TOOL_DEFINITIONS.map((
    t,
  ) => ({
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

    if (
      !assistantMessage.tool_calls || assistantMessage.tool_calls.length === 0
    ) {
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
