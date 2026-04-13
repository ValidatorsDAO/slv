import { getTipsForAgent, pickRandomTip } from '@/ai/console/tips.ts'
import {
  Container,
  Editor,
  type EditorTheme,
  Loader,
  Markdown,
  type MarkdownTheme,
  matchesKey,
  ProcessTerminal,
  Spacer,
  Text,
  TUI,
} from '@mariozechner/pi-tui'
import chalk from 'chalk'
import { readAiConfig } from '@/ai/config.ts'
import { initI18n, t } from '@/ai/i18n/index.ts'
import { OpenAIProvider } from '@/ai/console/providers/openai.ts'
import { AnthropicProvider } from '@/ai/console/providers/anthropic.ts'
import { SLVProvider } from '@/ai/console/providers/slv.ts'
import {
  buildSystemPrompt,
  filterUnloadedContextModules,
  injectSkillDocs,
  loadContextModules,
  resetContextModules,
} from '@/ai/console/systemPrompt.ts'
import {
  activateExtendedTools,
  killActiveProcess,
  resetActiveTools,
  resetSessionCaches,
  setAutoExecute,
  setCommandOutputCallback,
  setTuiInstance,
} from '@/ai/console/tools.ts'
import {
  classifyIntent,
  type DeploymentMode,
  describeIntent,
  describeUserContextKind,
  type IntentType,
  type SpecialistAgent,
  type UserContextKind,
} from '@/ai/console/intentClassifier.ts'
import { resolveHome } from '/lib/getApiKeyFromYml.ts'
import { parse } from '@std/yaml'
import {
  applyVersionUpdates,
  checkSolanaReleases,
  type VersionUpdate,
} from '@/ai/console/checkRelease.ts'
import denoJson from '/deno.json' with { type: 'json' }

export type ChatCallbacks = {
  onStream: (fullText: string) => void
  onToolCall: (name: string, detail: string) => void
  onComplete: () => void
}

const green = chalk.hex('#14f195')
const greenBold = chalk.bold.hex('#14f195')
const gray = chalk.gray
const white = chalk.white
const yellow = chalk.yellow
const red = chalk.red

const markdownTheme: MarkdownTheme = {
  heading: (t: string) => greenBold(t),
  link: (t: string) => chalk.cyan.underline(t),
  linkUrl: (t: string) => gray(t),
  code: (t: string) => chalk.bgGray.white(t),
  codeBlock: (t: string) => gray(t),
  codeBlockBorder: (t: string) => gray(t),
  quote: (t: string) => chalk.italic(gray(t)),
  quoteBorder: (t: string) => gray(t),
  hr: (t: string) => gray(t),
  listBullet: (t: string) => green(t),
  bold: (t: string) => chalk.bold(t),
  italic: (t: string) => chalk.italic(t),
  strikethrough: (t: string) => chalk.strikethrough(t),
  underline: (t: string) => chalk.underline(t),
  codeBlockIndent: '  ',
}

const editorTheme: EditorTheme = {
  borderColor: (t: string) => green(t),
  selectList: {
    selectedPrefix: (t: string) => green(t),
    selectedText: (t: string) => white(t),
    description: (t: string) => gray(t),
    scrollInfo: (t: string) => gray(t),
    noMatch: (t: string) => gray(t),
  },
}



/**
 * ChatLog: scrollable container for messages
 */
class ChatLog extends Container {
  addUser(text: string) {
    this.addChild(new Spacer(1))
    this.addChild(new Text(chalk.bold.green('You: ') + white(text), 1))
  }

  addAssistant(text: string) {
    this.addChild(new Spacer(1))
    this.addChild(new Markdown(text, 2, 0, markdownTheme))
  }

  updateStreaming(text: string) {
    const last = this.children[this.children.length - 1]
    if (last instanceof Markdown) {
      last.setText(text)
    } else {
      this.addChild(new Spacer(1))
      this.addChild(new Markdown(text, 2, 0, markdownTheme))
    }
  }

  addSystem(text: string) {
    this.addChild(new Text(gray(text), 1))
  }

  addTool(name: string, detail: string) {
    // Show user-friendly tool descriptions instead of raw JSON
    const friendlyNames: Record<string, string> = {
      'run_command': '⚡ Running command',
      'read_file': '📄 Reading file',
      'enable_tools': '🧰 Enabling tools',
      'write_file': '📝 Writing file',
      'list_files': '📂 Listing files',
      'call_mcp': '🔗 Calling SLV Cloud API',
      'delegate_to_agent': '', // handled separately
    }
    const friendly = friendlyNames[name]
    if (friendly === '') return // skip
    const label = friendly || `⚡ ${name}`

    let parsed: Record<string, unknown> | null = null
    try {
      parsed = JSON.parse(detail) as Record<string, unknown>
    } catch {
      parsed = null
    }

    // For run_command, show the actual command being executed
    if (name === 'run_command') {
      const cmd = String(parsed?.command ?? detail ?? '')
      if (cmd) {
        const display = cmd.length > 120 ? cmd.slice(0, 117) + '...' : cmd
        this.addChild(new Text(yellow(`${label}: `) + gray(`$ ${display}`), 1))
        return
      }
    }

    // For read_file/write_file, show the file path
    if (name === 'read_file' || name === 'write_file') {
      const path = String(parsed?.path ?? parsed?.file_path ?? '')
      if (path) {
        this.addChild(new Text(yellow(`${label}: `) + gray(path), 1))
        return
      }
    }

    if (name === 'enable_tools') {
      const tools = Array.isArray(parsed?.tools)
        ? (parsed?.tools as unknown[]).map((tool) => String(tool)).filter(
          Boolean,
        )
        : []
      const whyMap: Record<string, string> = {
        'run_command': 'inspect or operate the local/remote SLV environment',
        'read_file': 'inspect focused local SLV files',
        'call_mcp': 'check subscriptions or fetch SLV Cloud data',
        'write_file': 'save configuration or update memory',
        'list_files': 'inspect available files before acting',
        'send_notification': 'notify you when a long task finishes',
        'delegate_to_agent': 'hand work to a specialist agent',
      }
      if (tools.length > 0) {
        const why = tools
          .map((tool) => whyMap[tool])
          .filter((reason, index, reasons) =>
            reason && reasons.indexOf(reason) === index
          )
        const message = why.length > 0
          ? `${label}: ${tools.join(', ')} — ${why.join('; ')}`
          : `${label}: ${tools.join(', ')}`
        this.addChild(new Text(yellow(message), 1))
        return
      }
    }

    // For call_mcp, show the tool name
    if (name === 'call_mcp') {
      const toolName = String(parsed?.tool_name ?? parsed?.tool ?? '')
      if (toolName) {
        this.addChild(new Text(yellow(`${label}: `) + gray(toolName), 1))
        return
      }
    }

    this.addChild(new Text(yellow(label + '...'), 1))
  }
}

async function buildLocalGreeting(home: string): Promise<string> {
  const agentDir = `${home}/.slv/agent`

  // Extract agent name from SOUL.md
  let agentName = 'your SLV assistant'
  try {
    const soulMd = await Deno.readTextFile(`${agentDir}/SOUL.md`)
    const nameMatch = soulMd.match(/name:\s*([^\n]+)/i)
    if (nameMatch) agentName = nameMatch[1].trim()
  } catch { /* not configured */ }

  // Extract user's preferred name from USER.md
  let userName = ''
  try {
    const userMd = await Deno.readTextFile(`${agentDir}/USER.md`)
    const nameMatch = userMd.match(/preferred_name:\s*([^\n]+)/i)
    if (nameMatch) userName = nameMatch[1].trim()
  } catch { /* not configured */ }

  // Read enabled agents from config.yml
  let enabledAgents: string[] = []
  try {
    const raw = await Deno.readTextFile(`${agentDir}/config.yml`)
    const agentConfig = parse(raw) as Record<string, unknown>
    const skills = (agentConfig.skills || []) as Array<
      { name: string; enabled: boolean; agent: string }
    >
    enabledAgents = skills.filter((s) => s.enabled).map((s) => s.agent)
  } catch { /* not configured */ }

  // Figaro should be visible when the skill is installed, even if older configs
  // predate the Server Procurement toggle.
  try {
    await Deno.stat(`${home}/.slv/skills/slv-server-procurement/SKILL.md`)
    enabledAgents.push('Figaro')
  } catch {
    // skill not installed
  }

  const greetLine = userName
    ? t('Hey {name}! 👋').replace('{name}', userName)
    : t('Hey there! 👋')

  const introLine = agentName !== 'your SLV assistant'
    ? t("I'm {agent}, your SLV commander.").replace('{agent}', agentName)
    : t("I'm your SLV assistant.")

  const agentDescriptions: Record<string, string> = {
    'Cecil': t('Solana Validator deployments & management'),
    'Tina': t('RPC nodes (Index RPC, gRPC Geyser, combos)'),
    'Setzer': t('Trading bots & Solana apps'),
    'Figaro': t('Find optimized Solana server resources'),
    'Cid': t('Benchmarks & connectivity testing'),
  }

  const preferredOrder = ['Cecil', 'Tina', 'Setzer', 'Figaro', 'Cid']
  const crew = preferredOrder.filter((agent) => enabledAgents.includes(agent))
  let crewSection = ''
  if (crew.length > 0) {
    crewSection = ` ${t("Here's my crew:")}\n\n${
      crew.map((a) => `- ${a} — ${agentDescriptions[a]}`).join('\n')
    }\n\n`
  } else {
    crewSection = ' '
  }

  return `${greetLine}\n\n${introLine}${crewSection}${
    t('What would you like to work on today?')
  }`
}

async function checkDependencies(): Promise<string[]> {
  const missing: string[] = []

  // Check ansible
  try {
    const p = new Deno.Command('ansible-playbook', {
      args: ['--version'],
      stdout: 'piped',
      stderr: 'piped',
    })
    const { success } = await p.output()
    if (!success) missing.push('ansible')
  } catch {
    missing.push('ansible')
  }

  // Check solana-keygen (or agave-keygen)
  try {
    const p = new Deno.Command('solana-keygen', {
      args: ['--version'],
      stdout: 'piped',
      stderr: 'piped',
    })
    const { success } = await p.output()
    if (!success) missing.push('solana-cli')
  } catch {
    try {
      const p = new Deno.Command('agave-keygen', {
        args: ['--version'],
        stdout: 'piped',
        stderr: 'piped',
      })
      const { success } = await p.output()
      if (!success) missing.push('solana-cli')
    } catch {
      missing.push('solana-cli')
    }
  }

  return missing
}

async function promptInstallDependencies(missing: string[]): Promise<void> {
  console.log(
    yellow(`\n  ⚠️  Missing dependencies: ${missing.join(', ')}`),
  )
  const buf = new Uint8Array(1)
  Deno.stdout.writeSync(
    new TextEncoder().encode('  Install now? (Y/n) '),
  )
  await Deno.stdin.read(buf)
  const answer = new TextDecoder().decode(buf).trim().toLowerCase()
  if (answer === 'n') {
    console.log(gray('  Skipping installation. Some features may not work.\n'))
    return
  }

  const os = Deno.build.os

  for (const dep of missing) {
    if (dep === 'ansible') {
      console.log(green('  Installing ansible-core...'))
      if (os === 'darwin') {
        const cmd = new Deno.Command('brew', {
          args: ['install', 'ansible'],
          stdout: 'inherit',
          stderr: 'inherit',
        })
        await cmd.output()
      } else {
        // Ensure python3 and pip3 are available (clean Ubuntu servers may lack them)
        let hasPip3 = false
        try {
          const check = new Deno.Command('pip3', {
            args: ['--version'],
            stdout: 'piped',
            stderr: 'piped',
          })
          const { success } = await check.output()
          hasPip3 = success
        } catch { /* not found */ }

        if (!hasPip3) {
          console.log(green('  Installing python3-pip...'))
          // Try apt-get first (Debian/Ubuntu)
          let aptSuccess = false
          try {
            const update = new Deno.Command('sudo', {
              args: ['apt-get', 'update', '-qq'],
              stdout: 'inherit',
              stderr: 'inherit',
            })
            await update.output()
            const install = new Deno.Command('sudo', {
              args: ['apt-get', 'install', '-y', 'python3-pip'],
              stdout: 'inherit',
              stderr: 'inherit',
            })
            const result = await install.output()
            aptSuccess = result.success
          } catch { /* apt-get not available */ }

          if (!aptSuccess) {
            // Try dnf (Fedora/RHEL)
            try {
              const install = new Deno.Command('sudo', {
                args: ['dnf', 'install', '-y', 'python3-pip'],
                stdout: 'inherit',
                stderr: 'inherit',
              })
              await install.output()
            } catch {
              console.log(
                red(
                  '  ✗ Could not install python3-pip. Please install manually: sudo apt-get install -y python3-pip',
                ),
              )
            }
          }
        }

        // Try apt install first (avoids PEP 668 on Ubuntu 24.04+)
        let ansibleInstalled = false
        try {
          const aptInstall = new Deno.Command('sudo', {
            args: ['apt-get', 'install', '-y', 'ansible-core'],
            stdout: 'inherit',
            stderr: 'inherit',
          })
          const aptResult = await aptInstall.output()
          ansibleInstalled = aptResult.success
        } catch { /* apt-get not available */ }

        // Fallback: pip3 with --break-system-packages
        if (!ansibleInstalled) {
          const isRoot = Deno.uid?.() === 0
          const pipArgs = isRoot
            ? ['install', '--break-system-packages', 'ansible-core']
            : ['install', '--user', '--break-system-packages', 'ansible-core']
          try {
            const cmd = new Deno.Command('pip3', {
              args: pipArgs,
              stdout: 'inherit',
              stderr: 'inherit',
            })
            await cmd.output()
          } catch {
            // Last resort: try without --break-system-packages (older distros)
            const fallbackArgs = isRoot
              ? ['install', 'ansible-core']
              : ['install', '--user', 'ansible-core']
            const cmd = new Deno.Command('pip3', {
              args: fallbackArgs,
              stdout: 'inherit',
              stderr: 'inherit',
            })
            await cmd.output()
          }

          // Ensure ~/.local/bin is in PATH for --user installs
          if (!isRoot) {
            const home = Deno.env.get('HOME') || ''
            const currentPath = Deno.env.get('PATH') || ''
            const localBin = `${home}/.local/bin`
            if (!currentPath.includes(localBin)) {
              Deno.env.set('PATH', `${localBin}:${currentPath}`)
            }
          }
        }
      }
      console.log(green('  ✓ ansible-core installed'))
    }

    if (dep === 'solana-cli') {
      console.log(green('  Installing solana-cli (agave)...'))
      // Try to read agave version from versions.yml in ~/.slv
      let agaveVersion = 'stable'
      try {
        const versionsPath = `${Deno.env.get('HOME')}/.slv/versions.yml`
        const content = await Deno.readTextFile(versionsPath)
        const match = content.match(/AGAVE_VERSION:\s*["']?([^"'\s\n]+)/)
        if (match) agaveVersion = match[1]
      } catch {
        // fallback to stable
      }
      const installUrl = agaveVersion === 'stable'
        ? 'https://release.anza.xyz/stable/install'
        : `https://release.anza.xyz/v${agaveVersion}/install`
      const cmd = new Deno.Command('sh', {
        args: ['-c', `curl -sSfL "${installUrl}" | sh`],
        stdout: 'inherit',
        stderr: 'inherit',
      })
      await cmd.output()
      console.log(green('  ✓ solana-cli installed'))
    }
  }
  console.log('')
}

export const consoleAction = async () => {
  await initI18n()
  // Reset lazy-loaded tools, context modules, and demand-driven caches at session start
  resetActiveTools()
  resetContextModules()
  resetSessionCaches()

  let config = await readAiConfig()
  if (!config) {
    // Default to SLV AI — works with just the SLV API Key
    config = { provider: 'slv', api_key: '', model: 'SLV AI' }
  }

  // Check dependencies before TUI init
  const missing = await checkDependencies()
  if (missing.length > 0) {
    await promptInstallDependencies(missing)
  }

  let currentSystemPrompt = await buildSystemPrompt()
  const providerLabel = config.provider === 'openai'
    ? 'OpenAI'
    : config.provider === 'slv'
    ? 'SLV AI'
    : 'Anthropic'

  // TUI init
  const terminal = new ProcessTerminal()
  const tui = new TUI(terminal)

  // Layout
  const chatLog = new ChatLog()
  const editor = new Editor(tui, editorTheme, { paddingX: 1 })

  // Header
  chatLog.addChild(new Spacer(1))
  chatLog.addChild(
    new Text(
      greenBold(`  ${t('SLV AI Console')} v${denoJson.version}`),
      1,
    ),
  )
  chatLog.addChild(
    new Text(
      white(
        config.provider === 'slv'
          ? `  ${t('Provider:')} ${providerLabel}`
          : `  ${t('Provider:')} ${providerLabel} | ${t('Model:')} ${config.model}`,
      ),
      1,
    ),
  )
  chatLog.addChild(
    new Text(
      gray(
        `  ${t('Type /exit to quit, /clear to reset. Press Enter to send.')}`,
      ),
      1,
    ),
  )
  chatLog.addChild(new Spacer(1))

  tui.addChild(chatLog)
  tui.addChild(new Spacer(1))
  tui.addChild(editor)

  tui.setFocus(editor)

  // Store TUI reference for tools.ts suspend/resume
  setTuiInstance(tui)

  // Stream command output lines to TUI — filter out table borders and limit line count
  let cmdOutputLines: string[] = []
  let cmdOutputText: Text | null = null
  const MAX_CMD_VISIBLE_LINES = 30
  let cmdFlushTimer: ReturnType<typeof setTimeout> | null = null
  let cmdTotalLineCount = 0

  // Activity spinner shown while `run_command` executes. Long commands
  // (cargo build, curl downloads, ansible plays) can produce little or no
  // output for a while, so we show a rotating spinner with elapsed time so
  // the user knows work is in progress.
  let commandLoader: Loader | null = null
  let commandStartedAt = 0
  let commandLabel = ''
  let commandTimer: ReturnType<typeof setInterval> | null = null

  const formatElapsed = (ms: number): string => {
    const s = Math.floor(ms / 1000)
    if (s < 60) return `${s}s`
    const m = Math.floor(s / 60)
    return `${m}m ${s % 60}s`
  }

  const startCommandLoader = (command: string) => {
    stopCommandLoader() // guard against overlap
    // Keep the label short so it fits on one line in narrow terminals.
    const cleaned = command.replace(/\s+/g, ' ').trim()
    commandLabel = cleaned.length > 56
      ? cleaned.slice(0, 53) + '...'
      : cleaned
    commandStartedAt = Date.now()
    commandLoader = new Loader(
      tui,
      (s: string) => chalk.hex('#14f195')(s),
      (s: string) => chalk.gray(s),
      `Running: ${commandLabel} (0s)`,
    )
    chatLog.addChild(commandLoader)
    commandLoader.start()
    commandTimer = setInterval(() => {
      if (!commandLoader) return
      const elapsed = formatElapsed(Date.now() - commandStartedAt)
      commandLoader.setMessage(`Running: ${commandLabel} (${elapsed})`)
      tui.requestRender()
    }, 1000)
    tui.requestRender()
  }

  const stopCommandLoader = () => {
    if (commandTimer) {
      clearInterval(commandTimer)
      commandTimer = null
    }
    if (commandLoader) {
      chatLog.removeChild(commandLoader)
      commandLoader.stop()
      commandLoader = null
    }
  }

  const flushCmdOutput = () => {
    if (cmdOutputLines.length === 0) return
    // Show last N lines as a rolling window so the user always sees progress
    const visible = cmdOutputLines.slice(-MAX_CMD_VISIBLE_LINES)
    const hiddenCount = cmdTotalLineCount - visible.length
    const header = hiddenCount > 0
      ? `  ... (${hiddenCount} earlier lines hidden)\n`
      : ''
    const combined = header + visible.join('\n')
    if (cmdOutputText) {
      // Update text in-place — no remove/add cycle, no layout thrash, no scrollbar flicker
      cmdOutputText.setText(gray(combined))
    } else {
      cmdOutputText = new Text(gray(combined), 1)
      chatLog.addChild(cmdOutputText)
    }
    tui.requestRender()
  }

  setCommandOutputCallback((line: string) => {
    // Skip table border lines that break TUI rendering
    if (/^[┌┐└┘├┤┬┴┼─│═╔╗╚╝╠╣╦╩╬]+$/.test(line.trim())) return
    // Skip empty or whitespace-only lines
    if (!line.trim()) return

    const cleaned = line.replace(/[┌┐└┘├┤┬┴┼─│═╔╗╚╝╠╣╦╩╬]/g, ' ').replace(
      /\s+/g,
      ' ',
    ).trim()
    if (!cleaned) return
    cmdTotalLineCount++
    cmdOutputLines.push(`  ${cleaned}`)
    // Keep buffer from growing unbounded — retain 2x visible window
    if (cmdOutputLines.length > MAX_CMD_VISIBLE_LINES * 2) {
      cmdOutputLines = cmdOutputLines.slice(-MAX_CMD_VISIBLE_LINES)
    }

    // Debounce flush to batch rapid output
    if (cmdFlushTimer) clearTimeout(cmdFlushTimer)
    cmdFlushTimer = setTimeout(flushCmdOutput, 300)
  }, () => {
    // Flush remaining on command complete
    if (cmdFlushTimer) {
      clearTimeout(cmdFlushTimer)
      cmdFlushTimer = null
    }
    flushCmdOutput()
    cmdOutputLines = []
    cmdOutputText = null
    cmdTotalLineCount = 0
    stopCommandLoader()
  }, (taskName: string) => {
    // Ansible task-title spinner mode: update the running-command loader with
    // the current task name while keeping the elapsed-time counter.
    if (commandLoader) {
      const elapsed = formatElapsed(Date.now() - commandStartedAt)
      commandLabel = taskName
      commandLoader.setMessage(`Running: ${taskName} (${elapsed})`)
      tui.requestRender()
    }
  })

  // Read auto-execute setting from agent config
  try {
    const agentConfigPath = `${resolveHome()}/.slv/agent/config.yml`
    const raw = await Deno.readTextFile(agentConfigPath)
    const agentConfig = parse(raw) as Record<string, unknown>
    if (agentConfig.auto_execute === false) {
      setAutoExecute(false)
    }
  } catch { /* default: auto-execute on */ }

  // Provider init with callbacks
  let provider: OpenAIProvider | AnthropicProvider | SLVProvider
  let slvApiKey = ''
  let loader: Loader | null = null
  let tipTimer: ReturnType<typeof setInterval> | null = null
  let tipText: Text | null = null
  let currentDelegateAgent: string | null = null

  const callbacks: ChatCallbacks = {
    onStream: (text: string) => {
      if (loader) {
        chatLog.removeChild(loader)
        loader.stop()
        loader = null
      }
      // Clean up tips before streaming starts
      if (tipTimer) {
        clearInterval(tipTimer)
        tipTimer = null
      }
      if (tipText) {
        chatLog.removeChild(tipText)
        tipText = null
      }
      chatLog.updateStreaming(text)
      tui.requestRender()
    },
    onToolCall: (name: string, detail: string) => {
      // For delegate_to_agent, show tips while agent works (no JSON display)
      if (name === 'delegate_to_agent') {
        if (loader) {
          chatLog.removeChild(loader)
          loader.stop()
        }
        // Clear any previous tip timer
        if (tipTimer) {
          clearInterval(tipTimer)
          tipTimer = null
        }

        let agentName = 'sub-agent'
        try {
          const parsed = JSON.parse(detail)
          agentName = parsed.agent || agentName
        } catch {
          const match = detail.match(/"agent"\s*:\s*"([^"]+)"/)
          if (match) agentName = match[1]
        }
        currentDelegateAgent = agentName
        currentTaskDescription = `${agentName} is working`
        currentTaskStartedAt = Date.now()

        const loaderMessages: Record<string, string> = {
          'Figaro': 'Figaro is searching for the best server...',
          'Cecil': 'Cecil is preparing the deployment...',
          'Tina': 'Tina is configuring the RPC setup...',
          'Cid': 'Cid is running benchmark and connectivity checks...',
          'Setzer': 'Setzer is crafting your app...',
        }
        const loaderMsg = loaderMessages[agentName] ||
          `${agentName} is working...`
        loader = new Loader(
          tui,
          (s: string) => chalk.hex('#14f195')(s),
          (s: string) => chalk.gray(s),
          loaderMsg,
        )
        chatLog.addChild(loader)
        loader.start()
        tui.requestRender()

        // Show rotating tips every 4 seconds
        const tips = getTipsForAgent(agentName)
        if (tips.length > 0) {
          // Show first tip immediately
          if (tipText) chatLog.removeChild(tipText)
          tipText = new Text(gray(pickRandomTip(tips)), 1)
          chatLog.addChild(tipText)

          tipTimer = setInterval(() => {
            const nextTip = pickRandomTip(tips)
            if (tipText) {
              tipText.setText(gray(nextTip))
            } else {
              tipText = new Text(gray(nextTip), 1)
              chatLog.addChild(tipText)
            }
            tui.requestRender()
          }, 4000)
        }
        // Do NOT show chatLog.addTool for delegate_to_agent
        return
      } else {
        if (loader) {
          chatLog.removeChild(loader)
          loader.stop()
          loader = null
        }
      }

      if (name === 'enable_tools') {
        try {
          const parsed = JSON.parse(detail) as { tools?: string[] }
          const requested = Array.isArray(parsed.tools) ? parsed.tools : []
          const newTools = requested.filter((tool) => !announcedEnabledTools.has(tool))
          if (newTools.length === 0) return
          newTools.forEach((tool) => announcedEnabledTools.add(tool))
          chatLog.addTool(name, JSON.stringify({ tools: newTools }))
        } catch {
          chatLog.addTool(name, detail)
        }
      } else {
        chatLog.addTool(name, detail)
      }
      // Track what's running for side-chat status
      if (name === 'run_command') {
        currentTaskDescription = 'Running a command'
        if (!currentTaskStartedAt) currentTaskStartedAt = Date.now()
        // Parse the command out of the tool detail JSON so the spinner label
        // reflects what's actually running (e.g. `cargo build --release`).
        let cmd = ''
        try {
          const parsed = JSON.parse(detail) as { command?: string }
          if (typeof parsed.command === 'string') cmd = parsed.command
        } catch {
          const m = detail.match(/"command"\s*:\s*"([^"]+)"/)
          if (m) cmd = m[1]
        }
        if (cmd) startCommandLoader(cmd)
      } else if (name === 'call_mcp') {
        currentTaskDescription = 'Calling SLV Cloud API'
        if (!currentTaskStartedAt) currentTaskStartedAt = Date.now()
      }
      tui.requestRender()
    },
    onComplete: () => {
      if (loader) {
        chatLog.removeChild(loader)
        loader.stop()
        loader = null
      }
      // Clean up tips display
      if (tipTimer) {
        clearInterval(tipTimer)
        tipTimer = null
      }
      if (tipText) {
        chatLog.removeChild(tipText)
        tipText = null
      }
      currentDelegateAgent = null
      currentTaskDescription = ''
      currentTaskStartedAt = 0
      tui.requestRender()
    },
  }

  if (config.provider === 'openai') {
    provider = new OpenAIProvider(
      config.api_key,
      config.model,
      currentSystemPrompt,
      callbacks,
    )
  } else if (config.provider === 'slv') {
    // SLV AI uses slv.api_key from ~/.slv/api.yml (not ai.api_key)
    try {
      const apiYmlRaw = await Deno.readTextFile(`${resolveHome()}/.slv/api.yml`)
      const apiYml = parse(apiYmlRaw) as Record<string, any>
      slvApiKey = apiYml?.slv?.api_key || ''
    } catch { /* */ }
    if (!slvApiKey) {
      console.log('\n  SLV API Key not found. Run `slv login` first.\n')
      return
    }
    provider = new SLVProvider(
      slvApiKey,
      config.model,
      currentSystemPrompt,
      callbacks,
    )
  } else {
    provider = new AnthropicProvider(
      config.api_key,
      config.model,
      currentSystemPrompt,
      callbacks,
    )
  }

  tui.start()

  // Local greeting — no API call, typewriter effect
  {
    const greetingText = await buildLocalGreeting(resolveHome())
    const words = greetingText.split(' ')
    let revealed = ''
    for (let i = 0; i < words.length; i++) {
      revealed += (i === 0 ? '' : ' ') + words[i]
      chatLog.updateStreaming(revealed)
      tui.requestRender()
      await new Promise((r) => setTimeout(r, 40))
    }
  }

  // Background version check (non-blocking)
  let pendingUpdates: VersionUpdate[] | null = null
  const versionCheckLoader = new Loader(
    tui,
    white,
    white,
    'Checking for new versions…',
  )
  chatLog.addChild(versionCheckLoader)
  tui.requestRender()
  checkSolanaReleases().then((updates) => {
    versionCheckLoader.stop()
    chatLog.removeChild(versionCheckLoader)

    if (updates.length === 0) {
      tui.requestRender(true)
      return
    }

    // Deduplicate for display only (all updates are applied)
    const seen = new Set<string>()
    let msg = '🔄 New versions available:\n'
    for (const u of updates) {
      const displayKey = `${u.component}-${u.network}-${u.latest}`
      if (seen.has(displayKey)) continue
      seen.add(displayKey)
      msg += `  • ${u.component} (${u.network}): ${u.current} → ${u.latest}\n`
    }
    msg += '\nType /update to apply, or ignore to keep current versions.'

    chatLog.addSystem(msg)
    tui.requestRender(true)

    pendingUpdates = updates
  }).catch(() => {
    // silent fail — still clear the loader
    versionCheckLoader.stop()
    chatLog.removeChild(versionCheckLoader)
    tui.requestRender(true)
  })

  // Track user interactions for memory save decision
  let userMessageCount = 0
  let isProcessing = false
  let currentTaskDescription = '' // What the main agent is currently doing
  let currentTaskStartedAt = 0
  const announcedEnabledTools = new Set<string>()
  let deploymentMode: DeploymentMode = 'remote'
  let enabledSpecialists: string[] = []
  let currentIntent: IntentType | null = null
  let currentSpecialist: SpecialistAgent | null = null
  const hydratedUserContextKinds = new Set<UserContextKind>()
  const hydratedUserContextBlocks = new Map<UserContextKind, string>()

  try {
    const raw = await Deno.readTextFile(
      `${resolveHome()}/.slv/agent/config.yml`,
    )
    const agentConfig = parse(raw) as Record<string, unknown>
    deploymentMode =
      ((agentConfig.mode as string) || 'remote') as DeploymentMode
    enabledSpecialists =
      ((agentConfig.skills as Array<Record<string, unknown>> | undefined) || [])
        .filter((skill) => skill?.enabled)
        .map((skill) => String(skill.agent || ''))
        .filter(Boolean)
  } catch {
    deploymentMode = 'remote'
    enabledSpecialists = []
  }

  const delay = (ms: number) => new Promise((r) => setTimeout(r, ms))

  const renderStage = (message: string) => {
    chatLog.addChild(new Text(white(`  ${message}`), 1, 0))
    tui.requestRender()
  }

  const refreshSystemPrompt = async () => {
    const userContext = Array.from(hydratedUserContextBlocks.values()).join(
      '\n\n',
    )
    currentSystemPrompt = await buildSystemPrompt(userContext || undefined)
    provider.setSystemPrompt(currentSystemPrompt)
  }

  const hydrateUserContextKind = async (kind: UserContextKind) => {
    if (hydratedUserContextKinds.has(kind)) return

    if (kind === 'mcp_user_account') {
      renderStage(`📚 Loading ${describeUserContextKind(kind)}…`)
      try {
        if (!slvApiKey) {
          const apiYmlRaw = await Deno.readTextFile(
            `${resolveHome()}/.slv/api.yml`,
          )
          const apiYml = parse(apiYmlRaw) as Record<string, any>
          slvApiKey = apiYml?.slv?.api_key || ''
        }
        if (slvApiKey) {
          const res = await fetch('https://mcp-slv-cloud.erpc.global/mcp', {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${slvApiKey}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              jsonrpc: '2.0',
              id: 1,
              method: 'tools/call',
              params: { name: 'get_user_get', arguments: {} },
            }),
          })
          const data = await res.json()
          hydratedUserContextBlocks.set(
            kind,
            `## User Account (from MCP)\n${
              data.result?.content?.[0]?.text || 'Unable to fetch'
            }`,
          )
          hydratedUserContextKinds.add(kind)
        }
      } catch {
        // leave unset on failure
      }
      return
    }

    const inventoryMap: Record<
      Exclude<UserContextKind, 'mcp_user_account'>,
      string
    > = {
      inventory_testnet_validators: 'inventory.testnet.validators.yml',
      inventory_mainnet_validators: 'inventory.mainnet.validators.yml',
      inventory_mainnet_rpcs: 'inventory.mainnet.rpcs.yml',
    }

    const inventoryFile =
      inventoryMap[kind as Exclude<UserContextKind, 'mcp_user_account'>]
    if (!inventoryFile) return

    renderStage(`📚 Loading ${describeUserContextKind(kind)}…`)
    try {
      const content = await Deno.readTextFile(
        `${resolveHome()}/.slv/${inventoryFile}`,
      )
      hydratedUserContextBlocks.set(kind, `## ${inventoryFile}\n${content}`)
      hydratedUserContextKinds.add(kind)
    } catch {
      // inventory file may not exist yet
    }
  }

  const saveMemoryAndExit = async () => {
    if (userMessageCount > 0) {
      chatLog.addSystem('  Saving session memory...')
      tui.requestRender()
      try {
        await provider.chat(
          `Session ending. Update ~/.slv/agent/MEMORY.md using write_file with any noteworthy outcomes from this session.

RULES:
- Only record: server IPs, deploy results, config changes, key decisions, errors encountered
- Do NOT record: greetings, questions asked, general chat, help commands
- Keep each entry to 1-2 lines max
- Append to existing content, never overwrite
- If nothing notable happened, do NOT write to the file
- MEMORY.md must stay under 50 lines total. If it would exceed 50 lines, remove the oldest entries to make room.`,
        )
      } catch { /* ignore save errors */ }
    }
    tui.stop()
    await terminal.drainInput()
    console.log(`\n  ${t('Goodbye!')}\n`)
    Deno.exit(0)
  }

  const formatElapsedTime = (startMs: number): string => {
    const seconds = Math.floor((Date.now() - startMs) / 1000)
    if (seconds < 60) return `${seconds}s`
    const minutes = Math.floor(seconds / 60)
    const secs = seconds % 60
    return `${minutes}m ${secs}s`
  }

  const intentDomain = (intent: IntentType | null) => {
    switch (intent) {
      case 'server_availability':
      case 'server_procurement':
        return 'server'
      case 'validator_deploy':
      case 'validator_ops':
        return 'validator'
      case 'rpc_deploy':
      case 'rpc_ops':
        return 'rpc'
      case 'benchmark':
        return 'benchmark'
      case 'app_builder':
        return 'app'
      case 'account_billing':
        return 'account'
      case 'command_execution':
        return 'command'
      case 'general_chat':
        return 'chat'
      default:
        return 'unknown'
    }
  }

  const isLikelyFollowUp = (input: string) => {
    const trimmed = input.trim()
    if (!trimmed) return false
    return trimmed.length <= 80 || /^(it|that|this|those|these|then|and|also|what about|how about|which|so)/i.test(trimmed)
  }

  const applyIntentBootstrap = async (input: string) => {
    renderStage('👂 Understanding your request…')
    await delay(150)
    let plan = await classifyIntent(
      {
        provider: config.provider,
        apiKey: config.api_key,
        model: config.model,
        slvApiKey,
      },
      {
        message: input,
        deploymentMode,
        enabledSpecialists,
        currentIntent,
        currentSpecialist,
      },
    )

    if (
      !plan.delegateAgent &&
      currentSpecialist &&
      currentIntent &&
      isLikelyFollowUp(input) &&
      (plan.intent === 'unknown' || intentDomain(plan.intent) === intentDomain(currentIntent))
    ) {
      plan = {
        ...plan,
        intent: plan.intent === 'unknown' ? currentIntent : plan.intent,
        delegateAgent: currentSpecialist,
      }
    }

    renderStage(`🎓 Intent detected: ${describeIntent(plan.intent)}`)
    await delay(150)

    if (plan.toolsToEnable.length > 0) {
      const enabled = activateExtendedTools(plan.toolsToEnable)
      if (enabled.length > 0) {
        renderStage(`🧰 Enabling tools: ${enabled.join(', ')}`)
        await delay(150)
      }
    }

    const newlyLoadedModules = filterUnloadedContextModules(plan.contextModulesToLoad)
    if (newlyLoadedModules.length > 0) {
      renderStage(`📚 Loading context: ${newlyLoadedModules.join(', ')}`)
      await delay(150)
      loadContextModules(newlyLoadedModules)
    }

    if (plan.delegateAgent && plan.delegateAgent !== currentSpecialist) {
      renderStage(`🤖 Loading specialist: ${plan.delegateAgent}`)
      await injectSkillDocs(plan.delegateAgent)
      currentSpecialist = plan.delegateAgent
    } else if (!plan.delegateAgent && plan.confidence >= 0.7 && intentDomain(plan.intent) !== intentDomain(currentIntent)) {
      currentSpecialist = null
    }

    for (const kind of plan.userContextKindsToHydrate) {
      await hydrateUserContextKind(kind)
    }

    if (plan.userContextKindsToHydrate.length > 0) {
      await refreshSystemPrompt()
    }

    if (plan.intent !== 'unknown') currentIntent = plan.intent

    return plan
  }

  editor.onSubmit = async (text: string) => {
    const input = text.trim()
    if (!input) return

    editor.setText('')

    // While processing, handle side-chat messages
    if (isProcessing) {
      chatLog.addUser(input)
      const elapsed = currentTaskStartedAt
        ? formatElapsedTime(currentTaskStartedAt)
        : 'a moment'
      const agent = currentDelegateAgent || 'The system'

      // Build a helpful status response
      let status = `⏳ ${agent} is still working (${elapsed} elapsed).`
      if (currentDelegateAgent === 'Cecil') {
        status +=
          ' Validator deployment can take 20-40 minutes — building Solana, downloading snapshots, and configuring the node.'
      } else if (currentDelegateAgent === 'Tina') {
        status +=
          ' RPC deployment can take 30-60 minutes — building Solana, syncing with the cluster.'
      } else if (currentDelegateAgent === 'Cid') {
        status +=
          ' Benchmark and connectivity checks usually finish faster, but larger throughput tests can still take a few minutes.'
      } else if (currentDelegateAgent === 'Figaro') {
        status += ' Checking server availability and preparing your options.'
      }
      status += " I'll let you know as soon as it's done!"

      chatLog.addSystem(status)
      tui.requestRender()
      return
    }

    if (input === '/exit' || input === '/quit') {
      isProcessing = true
      await saveMemoryAndExit()
      return
    }

    if (input === '/clear') {
      chatLog.clear()
      resetActiveTools()
      resetContextModules()
      resetSessionCaches()
      announcedEnabledTools.clear()
      hydratedUserContextKinds.clear()
      hydratedUserContextBlocks.clear()
      currentIntent = null
      currentSpecialist = null
      currentSystemPrompt = await buildSystemPrompt()
      if (config.provider === 'openai') {
        provider = new OpenAIProvider(
          config.api_key,
          config.model,
          currentSystemPrompt,
          callbacks,
        )
      } else if (config.provider === 'slv') {
        let slvKey = ''
        try {
          const raw = await Deno.readTextFile(`${resolveHome()}/.slv/api.yml`)
          const yml = parse(raw) as Record<string, any>
          slvKey = yml?.slv?.api_key || ''
        } catch { /* */ }
        if (slvKey) {
          slvApiKey = slvKey
          provider = new SLVProvider(
            slvKey,
            config.model,
            currentSystemPrompt,
            callbacks,
          )
        }
      } else {
        provider = new AnthropicProvider(
          config.api_key,
          config.model,
          currentSystemPrompt,
          callbacks,
        )
      }
      chatLog.addSystem('  Conversation cleared.')
      tui.requestRender()
      return
    }

    if (input === '/update') {
      if (pendingUpdates && pendingUpdates.length > 0) {
        await applyVersionUpdates(pendingUpdates)
        chatLog.addSystem('  ✅ versions.yml updated successfully!')
        pendingUpdates = null
      } else {
        chatLog.addSystem('  No pending updates.')
      }
      tui.requestRender(true)
      return
    }

    if (input === '/help') {
      chatLog.addSystem('  /exit, /quit — Exit')
      chatLog.addSystem('  /clear — Clear conversation')
      chatLog.addSystem('  /update — Apply pending version updates')
      chatLog.addSystem(
        '  /<command> — Execute shell command directly (e.g. /slv ai usage)',
      )
      chatLog.addSystem('  /help — Show this help')
      tui.requestRender()
      return
    }

    // Direct CLI execution: input starting with / (but not a known command) runs as shell command
    if (
      input.startsWith('/') &&
      !['/exit', '/quit', '/clear', '/update', '/help'].includes(
        input.split(' ')[0],
      )
    ) {
      const shellCommand = input.slice(1).trim()
      if (!shellCommand) return

      chatLog.addUser(input)
      chatLog.addSystem(`  ⚡ $ ${shellCommand}`)
      tui.requestRender()

      try {
        const proc = new Deno.Command('bash', {
          args: ['-c', shellCommand],
          stdin: 'null',
          stdout: 'piped',
          stderr: 'piped',
        })
        const child = proc.spawn()

        const readStream = async (
          stream: ReadableStream<Uint8Array>,
        ): Promise<string> => {
          const reader = stream.getReader()
          const decoder = new TextDecoder()
          const chunks: string[] = []
          while (true) {
            const { done, value } = await reader.read()
            if (done) break
            chunks.push(decoder.decode(value, { stream: true }))
          }
          return chunks.join('')
        }

        const [stdout, stderr] = await Promise.all([
          readStream(child.stdout),
          readStream(child.stderr),
        ])
        const status = await child.status

        const output = (stdout + stderr).trim()
        if (output) {
          // Batch output into a single widget to avoid per-line padding
          const filtered = output.split('\n')
            .filter((line: string) => line.trim())
            .map((line: string) => `  ${line}`)
            .join('\n')
          if (filtered) {
            chatLog.addChild(new Text(filtered, 1, 0))
          }
        }
        if (!status.success) {
          chatLog.addSystem(red(`  (exit code ${status.code})`))
        }
      } catch (error) {
        chatLog.addSystem(red(`  Error: ${(error as Error).message}`))
      }

      tui.requestRender()
      return
    }

    chatLog.addUser(input)
    userMessageCount++
    isProcessing = true

    // Show loader
    loader = new Loader(
      tui,
      (s: string) => green(s),
      (s: string) => gray(s),
      'Understanding your request...',
    )
    chatLog.addChild(loader)
    loader.start()
    tui.requestRender()

    const plan = await applyIntentBootstrap(input)

    // Only ask for clarification on the very first message.
    // On follow-up messages the AI already has conversation context
    // and can interpret short replies (e.g. an IP address answering
    // a previous question) correctly.
    if (plan.askClarify && plan.intent === 'unknown' && userMessageCount <= 1) {
      if (loader) {
        chatLog.removeChild(loader)
        loader.stop()
        loader = null
      }
      chatLog.addAssistant(plan.askClarify)
      isProcessing = false
      tui.requestRender()
      return
    }

    try {
      await provider.chat(input)
    } catch (error) {
      const msg = (error as Error).message
      const color = /[Ii]nsufficient.*token|token.*limit/i.test(msg) ? yellow : red
      chatLog.addSystem(color(`  Error: ${msg}`))
    }

    if (loader) {
      chatLog.removeChild(loader)
      loader.stop()
      loader = null
    }
    isProcessing = false
    tui.requestRender()
  }

  // Global ctrl+c handler — always works, never hangs
  let ctrlCCount = 0
  let ctrlCResetTimer: ReturnType<typeof setTimeout> | null = null

  tui.addInputListener((data: string) => {
    if (matchesKey(data, 'ctrl+c')) {
      ctrlCCount++

      // Reset counter after 2 seconds
      if (ctrlCResetTimer) clearTimeout(ctrlCResetTimer)
      ctrlCResetTimer = setTimeout(() => {
        ctrlCCount = 0
      }, 2000)

      if (ctrlCCount >= 2) {
        // Double Ctrl+C: force exit immediately no matter what
        killActiveProcess()
        tui.stop()
        console.log('\n  Force exit.\n')
        Deno.exit(1)
      }

      if (isProcessing) {
        // First Ctrl+C during processing: kill child process, show message
        killActiveProcess()
        chatLog.addSystem(
          '  ⚠️ Interrupted. Press Ctrl+C again to exit, or type a message.',
        )
        isProcessing = false
        if (loader) {
          chatLog.removeChild(loader)
          loader.stop()
          loader = null
        }
        if (tipTimer) {
          clearInterval(tipTimer)
          tipTimer = null
        }
        if (tipText) {
          chatLog.removeChild(tipText)
          tipText = null
        }
        currentDelegateAgent = null
        currentTaskDescription = ''
        currentTaskStartedAt = 0
        tui.requestRender()
      } else {
        // Not processing: save memory and exit
        saveMemoryAndExit()
      }
      return { consume: true }
    }
    return undefined
  })
}
