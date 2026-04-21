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
  truncateToWidth,
  TUI,
} from '@mariozechner/pi-tui'
import { getTerminalWidth } from '@/ai/rendering.ts'
import chalk from 'chalk'
import { readAiConfig } from '@/ai/config.ts'
import { initI18n, t } from '@/ai/i18n/index.ts'
import {
  clearFocusOverride,
  describeProfile,
  detectProfile,
  type PrimaryFocus,
  writeFocusOverride,
} from '@/ai/console/profile.ts'
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
  clearAbort,
  isAborted,
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
import { loadAgentContext } from '@/ai/agentConfig/loader.ts'
import { listAgentsByOrder } from '@/ai/agentConfig/registry.ts'
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
      'run_command': t('⚡ Running command'),
      'read_file': t('📄 Reading file'),
      'enable_tools': t('🧰 Enabling tools'),
      'write_file': t('📝 Writing file'),
      'list_files': t('📂 Listing files'),
      'call_mcp': t('🔗 Calling SLV Cloud API'),
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
        'run_command': t('inspect or operate the local/remote SLV environment'),
        'read_file': t('inspect focused local SLV files'),
        'call_mcp': t('check subscriptions or fetch SLV Cloud data'),
        'write_file': t('save configuration or update memory'),
        'list_files': t('inspect available files before acting'),
        'send_notification': t('notify you when a long task finishes'),
        'delegate_to_agent': t('hand work to a specialist agent'),
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
  const ctx = await loadAgentContext({ home })

  const agentName = ctx.soul?.name ?? 'your SLV assistant'
  const userName = ctx.user?.preferredName ?? ''

  const greetLine = userName
    ? t('Hey {name}! 👋').replace('{name}', userName)
    : t('Hey there! 👋')

  const introLine = agentName !== 'your SLV assistant'
    ? t("I'm {agent}, your SLV commander.").replace('{agent}', agentName)
    : t("I'm your SLV assistant.")

  const crew = listAgentsByOrder(ctx.enabledAgents)
  const crewSection = crew.length > 0
    ? ` ${t("Here's my crew:")}\n\n${
      crew.map((meta) => `- ${meta.id} — ${meta.description()}`).join('\n')
    }\n\n`
    : ' '

  // Append a one-line profile hint so the user sees we've detected their
  // primary focus. Failures are non-fatal — the greeting still works.
  let profileLine = ''
  try {
    const profile = await detectProfile()
    profileLine = `\n\n${describeProfile(profile)}`
  } catch { /* profile detection is best-effort */ }

  return `${greetLine}\n\n${introLine}${crewSection}${
    t('What would you like to work on today?')
  }${profileLine}`
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
    yellow(
      `\n  ${
        t('⚠️  Missing dependencies: {deps}').replace(
          '{deps}',
          missing.join(', '),
        )
      }`,
    ),
  )
  const buf = new Uint8Array(1)
  Deno.stdout.writeSync(
    new TextEncoder().encode(`  ${t('Install now? (Y/n) ')}`),
  )
  await Deno.stdin.read(buf)
  const answer = new TextDecoder().decode(buf).trim().toLowerCase()
  if (answer === 'n') {
    console.log(
      gray(`  ${t('Skipping installation. Some features may not work.')}\n`),
    )
    return
  }

  const os = Deno.build.os

  for (const dep of missing) {
    if (dep === 'ansible') {
      console.log(green(`  ${t('Installing ansible-core...')}`))
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
          console.log(green(`  ${t('Installing python3-pip...')}`))
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
                  `  ${
                    t(
                      '✗ Could not install python3-pip. Please install manually: sudo apt-get install -y python3-pip',
                    )
                  }`,
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
      console.log(green(`  ${t('✓ ansible-core installed')}`))
    }

    if (dep === 'solana-cli') {
      console.log(green(`  ${t('Installing solana-cli (agave)...')}`))
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
      console.log(green(`  ${t('✓ solana-cli installed')}`))
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

  // Strip bytes that confuse pi-tui's differential renderer — ANSI colors,
  // cursor/erase/OSC sequences, C0 controls, bell. Box-drawing chars are
  // also collapsed (they are fine in a real terminal but wrap unpredictably
  // when squeezed through pi-tui's column bookkeeping). Progress bars that
  // rewrite the same line via CR are collapsed to the final state — what
  // you'd actually see on a real terminal after all the rewrites. Lines
  // are then capped to a sane visible width so pathological single-line
  // blobs (e.g. minified JSON from `curl`) don't blow the layout on mobile
  // terminals like Terminus that wrap/truncate unpredictably.
  //
  // Regex alternation order matters: the OSC arm (`\x1b]...ST`) must come
  // before the single-char C1 arm `[@-Z\\-_]`, otherwise the bare `]` is
  // matched as a 2-byte C1 sequence and the OSC body leaks through.
  // ANSI is dropped outright (pure formatting); box-drawing and C0 controls
  // become a space so they don't glue neighboring words together.
  const ANSI_RE =
    // deno-lint-ignore no-control-regex
    /\x1b(?:\][^\x07\x1b]*(?:\x07|\x1b\\)|\[[0-?]*[ -/]*[@-~]|[@-Z\\-_])/g
  // deno-lint-ignore no-control-regex
  const JUNK_RE = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f┌┐└┘├┤┬┴┼─│═╔╗╚╝╠╣╦╩╬]/g
  const MAX_LINE_WIDTH = 200
  const sanitizeTtyLine = (s: string): string => {
    const afterLastCR = s.includes('\r') ? (s.split('\r').pop() ?? s) : s
    const plain = afterLastCR
      .replace(ANSI_RE, '')
      .replace(JUNK_RE, ' ')
      .replace(/\s+/g, ' ')
      .trim()
    return truncateToWidth(plain, MAX_LINE_WIDTH, '…')
  }

  // Activity spinner shown while `run_command` executes. Long commands
  // (cargo build, curl downloads, ansible plays) can produce little or no
  // output for a while, so we show a rotating spinner with elapsed time so
  // the user knows work is in progress.
  //
  // "Lite" mode: on narrow terminals (< 60 cols) typical of mobile SSH apps
  // like Termius/Terminus, or when SLV_TUI_LITE=1, we swap the animated
  // Loader (80ms frame re-render in pi-tui) for a static Text node updated
  // only on the elapsed-time tick. The 80ms cadence + pi-tui's differential
  // cursor-movement sequences are the main trigger for ghost characters and
  // column-drift on flaky mobile ANSI handling.
  const detectLiteMode = (): boolean => {
    const flag = Deno.env.get('SLV_TUI_LITE')
    if (flag === '1') return true
    if (flag === '0') return false
    return getTerminalWidth() < 60
  }
  const tuiLite = detectLiteMode()

  // Single abstraction for the active "Running…" indicator — closures hide
  // whether it's driven by an animated Loader or a static Text node.
  let updateIndicator: ((elapsed: string) => void) | null = null
  let disposeIndicator: (() => void) | null = null
  let commandStartedAt = 0
  let commandLabel = ''
  let commandTimer: ReturnType<typeof setInterval> | null = null

  const formatElapsed = (ms: number): string => {
    const s = Math.floor(ms / 1000)
    if (s < 60) return `${s}s`
    const m = Math.floor(s / 60)
    return `${m}m ${s % 60}s`
  }

  // Lite mode has no animated glyph, so prepend a static ▶ to signal activity.
  const liteIndicatorLabel = (elapsed: string): string =>
    `${chalk.hex('#14f195')('▶')} ${
      chalk.gray(`Running: ${commandLabel} (${elapsed})`)
    }`
  const fullIndicatorLabel = (elapsed: string): string =>
    `Running: ${commandLabel} (${elapsed})`

  const startCommandLoader = (command: string) => {
    stopCommandLoader() // guard against overlap
    // Keep the label short so it fits on one line in narrow terminals.
    const cleaned = command.replace(/\s+/g, ' ').trim()
    commandLabel = cleaned.length > 56
      ? cleaned.slice(0, 53) + '...'
      : cleaned
    commandStartedAt = Date.now()

    if (tuiLite) {
      const node = new Text(liteIndicatorLabel('0s'), 1)
      chatLog.addChild(node)
      updateIndicator = (elapsed) => node.setText(liteIndicatorLabel(elapsed))
      disposeIndicator = () => chatLog.removeChild(node)
    } else {
      const node = new Loader(
        tui,
        (s: string) => chalk.hex('#14f195')(s),
        (s: string) => chalk.gray(s),
        fullIndicatorLabel('0s'),
      )
      chatLog.addChild(node)
      node.start()
      updateIndicator = (elapsed) => node.setMessage(fullIndicatorLabel(elapsed))
      disposeIndicator = () => {
        node.stop()
        chatLog.removeChild(node)
      }
    }

    const tickMs = tuiLite ? 2000 : 1000
    commandTimer = setInterval(() => {
      updateIndicator?.(formatElapsed(Date.now() - commandStartedAt))
      tui.requestRender()
    }, tickMs)
    tui.requestRender()
  }

  const stopCommandLoader = () => {
    if (commandTimer) {
      clearInterval(commandTimer)
      commandTimer = null
    }
    disposeIndicator?.()
    disposeIndicator = null
    updateIndicator = null
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
    const cleaned = sanitizeTtyLine(line)
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
    // Ansible task-title spinner mode: swap the label to the current task
    // name while keeping the elapsed-time counter running.
    commandLabel = taskName
    updateIndicator?.(formatElapsed(Date.now() - commandStartedAt))
    tui.requestRender()
  })

  // Read auto-execute setting from agent config
  {
    const ctx = await loadAgentContext()
    if (!ctx.autoExecute) setAutoExecute(false)
  }

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
    const ctx = await loadAgentContext()
    slvApiKey = ctx.raw.api.slv.api_key ?? ''
    if (!slvApiKey) {
      console.log(
        `\n  ${t('SLV API Key not found. Run `slv login` first.')}\n`,
      )
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
    t('Checking for new versions…'),
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
    let msg = `${t('🔄 New versions available:')}\n`
    for (const u of updates) {
      const displayKey = `${u.component}-${u.network}-${u.latest}`
      if (seen.has(displayKey)) continue
      seen.add(displayKey)
      msg += `  • ${u.component} (${u.network}): ${u.current} → ${u.latest}\n`
    }
    msg += `\n${t('Type /update to apply, or ignore to keep current versions.')}`

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
  // Messages the user typed while a previous turn was still running. Drained
  // FIFO after each turn completes so long builds/deploys don't block the
  // conversation — the user can queue follow-ups and walk away.
  const pendingUserMessages: string[] = []
  let currentTaskDescription = '' // What the main agent is currently doing
  let currentTaskStartedAt = 0
  const announcedEnabledTools = new Set<string>()
  let deploymentMode: DeploymentMode = 'remote'
  let enabledSpecialists: string[] = []
  let currentIntent: IntentType | null = null
  let currentSpecialist: SpecialistAgent | null = null
  const hydratedUserContextKinds = new Set<UserContextKind>()
  const hydratedUserContextBlocks = new Map<UserContextKind, string>()

  {
    const ctx = await loadAgentContext()
    deploymentMode = ctx.mode
    enabledSpecialists = ctx.enabledAgents
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
      renderStage(
        t('📚 Loading {context}…').replace(
          '{context}',
          t(describeUserContextKind(kind)),
        ),
      )
      try {
        if (!slvApiKey) {
          const ctx = await loadAgentContext()
          slvApiKey = ctx.raw.api.slv.api_key ?? ''
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

    renderStage(
      t('📚 Loading {context}…').replace(
        '{context}',
        t(describeUserContextKind(kind)),
      ),
    )
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
      chatLog.addSystem(`  ${t('Saving session memory...')}`)
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
    renderStage(t('👂 Understanding your request…'))
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

    renderStage(
      t('🎓 Intent detected: {intent}').replace(
        '{intent}',
        t(describeIntent(plan.intent)),
      ),
    )
    await delay(150)

    if (plan.toolsToEnable.length > 0) {
      const enabled = activateExtendedTools(plan.toolsToEnable)
      if (enabled.length > 0) {
        renderStage(
          t('🧰 Enabling tools: {tools}').replace(
            '{tools}',
            enabled.join(', '),
          ),
        )
        await delay(150)
      }
    }

    const newlyLoadedModules = filterUnloadedContextModules(plan.contextModulesToLoad)
    if (newlyLoadedModules.length > 0) {
      renderStage(
        t('📚 Loading context: {modules}').replace(
          '{modules}',
          newlyLoadedModules.join(', '),
        ),
      )
      await delay(150)
      loadContextModules(newlyLoadedModules)
    }

    if (plan.delegateAgent && plan.delegateAgent !== currentSpecialist) {
      renderStage(
        t('🤖 Loading specialist: {specialist}').replace(
          '{specialist}',
          plan.delegateAgent,
        ),
      )
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

  const handleSubmit = async (text: string): Promise<void> => {
    const input = text.trim()
    if (!input) return

    editor.setText('')

    // While processing, queue the message instead of blocking it. It will
    // be processed automatically once the current turn (and any earlier
    // queued turns) finishes.
    if (isProcessing) {
      chatLog.addUser(input)
      pendingUserMessages.push(input)
      const elapsed = currentTaskStartedAt
        ? formatElapsedTime(currentTaskStartedAt)
        : t('a moment')
      const agent = currentDelegateAgent || t('The system')
      const position = pendingUserMessages.length

      let status = t(
        '📥 Queued (#{position}). {agent} is still working ({elapsed} elapsed) — I will process this right after.',
      )
        .replace('{position}', String(position))
        .replace('{agent}', agent)
        .replace('{elapsed}', elapsed)
      if (currentDelegateAgent === 'Cecil') {
        status += t(
          ' Validator deployment can take 20-40 minutes — building Solana, downloading snapshots, and configuring the node.',
        )
      } else if (currentDelegateAgent === 'Tina') {
        status += t(
          ' RPC deployment can take 30-60 minutes — building Solana, syncing with the cluster.',
        )
      } else if (currentDelegateAgent === 'Cid') {
        status += t(
          ' Benchmark and connectivity checks usually finish faster, but larger throughput tests can still take a few minutes.',
        )
      } else if (currentDelegateAgent === 'Figaro') {
        status += t(' Checking server availability and preparing your options.')
      }

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
        const ctx = await loadAgentContext()
        const slvKey = ctx.raw.api.slv.api_key ?? ''
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
      chatLog.addSystem(`  ${t('Conversation cleared.')}`)
      tui.requestRender()
      return
    }

    if (input === '/update') {
      if (pendingUpdates && pendingUpdates.length > 0) {
        await applyVersionUpdates(pendingUpdates)
        chatLog.addSystem(`  ${t('✅ versions.yml updated successfully!')}`)
        pendingUpdates = null
      } else {
        chatLog.addSystem(`  ${t('No pending updates.')}`)
      }
      tui.requestRender(true)
      return
    }

    if (input === '/help') {
      chatLog.addSystem(`  ${t('/exit, /quit — Exit')}`)
      chatLog.addSystem(`  ${t('/clear — Clear conversation')}`)
      chatLog.addSystem(`  ${t('/update — Apply pending version updates')}`)
      chatLog.addSystem(
        `  ${
          t(
            '/focus <validator|rpc|app|mixed|auto> — Switch or reset the main agent\'s primary focus',
          )
        }`,
      )
      chatLog.addSystem(
        `  ${
          t('/<command> — Execute shell command directly (e.g. /slv ai usage)')
        }`,
      )
      chatLog.addSystem(`  ${t('/help — Show this help')}`)
      tui.requestRender()
      return
    }

    // /focus <role> — switch the main agent's routing bias. Persisted to
    // ~/.slv/agent/focus.txt so it carries across sessions. `/focus auto`
    // clears the override and returns to heuristic detection.
    // Exact-token match so `/focuses`, `/focusapp`, etc. fall through to the
    // shell-command path below instead of silently being interpreted.
    const firstToken = input.split(/\s+/)[0]
    if (firstToken === '/focus') {
      const rest = input.slice(firstToken.length).trim().toLowerCase()
      const valid: PrimaryFocus[] = ['validator', 'rpc', 'app', 'mixed']

      // /focus with no argument — show current state and usage. detectProfile
      // failures are logged but never crash the input loop.
      if (!rest) {
        try {
          const profile = await detectProfile()
          const focusKey = profile.overridden
            ? 'Current focus: {focus} (manual override)'
            : 'Current focus: {focus} (auto)'
          chatLog.addSystem(
            `  ${t(focusKey).replace('{focus}', profile.primary)}`,
          )
        } catch (err) {
          chatLog.addSystem(
            `  ${
              t('⚠ Could not detect current focus: {error}').replace(
                '{error}',
                () => (err as Error).message,
              )
            }`,
          )
        }
        chatLog.addSystem(
          `  ${t('Usage: /focus validator | rpc | app | mixed | auto')}`,
        )
        tui.requestRender()
        return
      }

      let handled = false
      if (rest === 'auto' || rest === 'clear' || rest === 'reset') {
        try {
          await clearFocusOverride()
          chatLog.addSystem(`  ${t('◇ Focus override cleared.')}`)
          handled = true
        } catch (err) {
          chatLog.addSystem(
            `  ${
              t('⚠ Failed to clear focus override: {error}').replace(
                '{error}',
                () => (err as Error).message,
              )
            }`,
          )
          tui.requestRender()
          return
        }
      } else if ((valid as string[]).includes(rest)) {
        try {
          await writeFocusOverride(rest as PrimaryFocus)
          chatLog.addSystem(
            `  ${t('◇ Focus set to: {focus}').replace('{focus}', rest)}`,
          )
          handled = true
        } catch (err) {
          chatLog.addSystem(
            `  ${
              t('⚠ Failed to set focus: {error}').replace(
                '{error}',
                () => (err as Error).message,
              )
            }`,
          )
          tui.requestRender()
          return
        }
      }

      if (!handled) {
        chatLog.addSystem(
          `  ${
            t(
              'Unknown focus "{focus}". Use: validator | rpc | app | mixed | auto',
            ).replace('{focus}', () => rest)
          }`,
        )
        tui.requestRender()
        return
      }

      // Rebuild the system prompt so the new profile takes effect on the
      // next user message without requiring a /clear. Wrap in try/catch so
      // a best-effort profile refresh failure doesn't crash the input loop.
      try {
        currentSystemPrompt = await buildSystemPrompt()
        provider.setSystemPrompt(currentSystemPrompt)
        const refreshed = await detectProfile()
        chatLog.addSystem(`  ${describeProfile(refreshed)}`)
      } catch (err) {
        chatLog.addSystem(
          `  ${
            t('⚠ Profile refresh failed: {error}').replace(
              '{error}',
              () => (err as Error).message,
            )
          }`,
        )
      }
      tui.requestRender()
      return
    }

    // Direct CLI execution: input starting with / (but not a known command) runs as shell command
    if (
      input.startsWith('/') &&
      !['/exit', '/quit', '/clear', '/update', '/help', '/focus'].includes(
        firstToken,
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
          chatLog.addSystem(
            red(
              `  ${
                t('(exit code {code})').replace('{code}', String(status.code))
              }`,
            ),
          )
        }
      } catch (error) {
        chatLog.addSystem(
          red(
            `  ${
              t('Error: {message}').replace(
                '{message}',
                () => (error as Error).message,
              )
            }`,
          ),
        )
      }

      tui.requestRender()
      return
    }

    chatLog.addUser(input)
    userMessageCount++
    isProcessing = true
    // Clear any prior Ctrl+C abort state so this turn is not short-circuited.
    clearAbort()

    // Show loader
    loader = new Loader(
      tui,
      (s: string) => green(s),
      (s: string) => gray(s),
      t('Understanding your request...'),
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
      chatLog.addSystem(
        color(`  ${t('Error: {message}').replace('{message}', () => msg)}`),
      )
    }

    if (loader) {
      chatLog.removeChild(loader)
      loader.stop()
      loader = null
    }
    isProcessing = false
    tui.requestRender()

    // Drain one queued message (if any) via microtask so the stack
    // doesn't grow with each chained turn. Ctrl+C drops the whole queue.
    if (pendingUserMessages.length > 0 && !isAborted()) {
      const next = pendingUserMessages.shift()!
      queueMicrotask(() => {
        handleSubmit(next).catch((e: unknown) => {
          chatLog.addSystem(
            red(
              `  ${
                t('Queued message failed: {message}').replace(
                  '{message}',
                  () => (e as Error).message,
                )
              }`,
            ),
          )
          tui.requestRender()
        })
      })
    }
  }

  editor.onSubmit = (text: string) => {
    handleSubmit(text).catch((e: unknown) => {
      chatLog.addSystem(
        red(
          `  ${
            t('Input handler failed: {message}').replace(
              '{message}',
              () => (e as Error).message,
            )
          }`,
        ),
      )
      tui.requestRender()
    })
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
        console.log(`\n  ${t('Force exit.')}\n`)
        Deno.exit(1)
      }

      if (isProcessing) {
        // First Ctrl+C during processing: kill child process, drop queued
        // messages (user wants to stop, not resume with stale intent).
        killActiveProcess()
        const dropped = pendingUserMessages.length
        pendingUserMessages.length = 0
        chatLog.addSystem(
          `  ${
            t('⚠️ Interrupted. Press Ctrl+C again to exit, or type a message.')
          }${dropped > 0
            ? ` ${
              t('({count} queued message(s) discarded.)').replace(
                '{count}',
                String(dropped),
              )
            }`
            : ''}`,
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
