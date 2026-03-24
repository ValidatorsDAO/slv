import { getTipsForAgent, pickRandomTip } from '@/ai/console/tips.ts'
import {
  TUI,
  Container,
  Text,
  Markdown,
  Editor,
  Spacer,
  Loader,
  ProcessTerminal,
  matchesKey,
  type MarkdownTheme,
  type EditorTheme,
  type Component,
} from '@mariozechner/pi-tui'
import chalk from 'chalk'
import { readAiConfig } from '@/ai/config.ts'
import { OpenAIProvider } from '@/ai/console/providers/openai.ts'
import { AnthropicProvider } from '@/ai/console/providers/anthropic.ts'
import { buildSystemPrompt } from '@/ai/console/systemPrompt.ts'
import { setTuiInstance, setAutoExecute, setCommandOutputCallback } from '@/ai/console/tools.ts'
import { resolveHome } from '/lib/getApiKeyFromYml.ts'
import { parse } from '@std/yaml'
import { checkSolanaReleases, applyVersionUpdates, type VersionUpdate } from '@/ai/console/checkRelease.ts'
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
    this.addChild(new Text(yellow(`  ⚡ ${name}`) + gray(` ${detail}`), 1))
  }
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
        const cmd = new Deno.Command('pip3', {
          args: ['install', '--user', 'ansible-core'],
          stdout: 'inherit',
          stderr: 'inherit',
        })
        await cmd.output()
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
  const config = await readAiConfig()
  if (!config) {
    console.log('\n  AI not configured. Run `slv onboard` first.\n')
    return
  }

  // Check dependencies before TUI init
  const missing = await checkDependencies()
  if (missing.length > 0) {
    await promptInstallDependencies(missing)
  }

  // Pre-fetch user context from MCP and inventory files (silent, non-blocking)
  let userContext = ''
  try {
    const apiYmlRaw = await Deno.readTextFile(`${resolveHome()}/.slv/api.yml`)
    const apiYml = parse(apiYmlRaw) as Record<string, any>
    const slvApiKey = apiYml?.slv?.api_key || ''

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
      userContext += `\n## User Account (from MCP)\n${data.result?.content?.[0]?.text || 'Unable to fetch'}\n`
    }
  } catch {
    /* silent */
  }

  // Read inventory files
  for (const inv of [
    'inventory.testnet.validators.yml',
    'inventory.mainnet.validators.yml',
    'inventory.mainnet.rpcs.yml',
  ]) {
    try {
      const content = await Deno.readTextFile(`${resolveHome()}/.slv/${inv}`)
      userContext += `\n## ${inv}\n${content}\n`
    } catch {
      /* doesn't exist */
    }
  }

  const systemPrompt = await buildSystemPrompt(userContext || undefined)
  const providerLabel = config.provider === 'openai' ? 'OpenAI' : 'Anthropic'

  // TUI init
  const terminal = new ProcessTerminal()
  const tui = new TUI(terminal)

  // Layout
  const chatLog = new ChatLog()
  const editor = new Editor(tui, editorTheme, { paddingX: 1 })

  // Header
  chatLog.addChild(new Spacer(1))
  chatLog.addChild(new Text(greenBold(`  SLV AI Console v${denoJson.version}`), 1))
  chatLog.addChild(new Text(white(`  Provider: ${providerLabel} | Model: ${config.model}`), 1))
  chatLog.addChild(new Text(gray('  Type /exit to quit, /clear to reset. Press Enter to send.'), 1))
  chatLog.addChild(new Spacer(1))

  tui.addChild(chatLog)
  tui.addChild(new Spacer(1))
  tui.addChild(editor)

  tui.setFocus(editor)

  // Store TUI reference for tools.ts suspend/resume
  setTuiInstance(tui)

  // Stream command output lines to TUI — filter out table borders and limit line count
  let cmdOutputCount = 0
  const MAX_CMD_OUTPUT_LINES = 50
  setCommandOutputCallback((line: string) => {
    // Skip table border lines that break TUI rendering
    if (/^[┌┐└┘├┤┬┴┼─│═╔╗╚╝╠╣╦╩╬]+$/.test(line.trim())) return
    // Skip empty or whitespace-only lines
    if (!line.trim()) return
    // Limit output lines to prevent TUI overflow
    cmdOutputCount++
    if (cmdOutputCount > MAX_CMD_OUTPUT_LINES) {
      if (cmdOutputCount === MAX_CMD_OUTPUT_LINES + 1) {
        chatLog.addSystem('  ... (output truncated)')
      }
      return
    }
    // Clean up any remaining box-drawing characters
    const cleaned = line.replace(/[┌┐└┘├┤┬┴┼─│═╔╗╚╝╠╣╦╩╬]/g, ' ').replace(/\s+/g, ' ').trim()
    if (cleaned) {
      chatLog.addSystem(`  ${cleaned}`)
      tui.requestRender()
    }
  }, () => {
    // Reset output counter when command completes
    cmdOutputCount = 0
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
  let provider: OpenAIProvider | AnthropicProvider
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

        const loaderMessages: Record<string, string> = {
          'Figaro': 'Figaro is searching for the best server...',
          'Cecil': 'Cecil is preparing the deployment...',
          'Tina': 'Tina is configuring the RPC setup...',
          'Setzer': 'Setzer is crafting your app...',
        }
        const loaderMsg = loaderMessages[agentName] || `${agentName} is working...`
        loader = new Loader(tui, (s: string) => chalk.hex('#14f195')(s), (s: string) => chalk.gray(s), loaderMsg)
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
              chatLog.removeChild(tipText)
            }
            tipText = new Text(gray(nextTip), 1)
            chatLog.addChild(tipText)
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
      chatLog.addTool(name, detail)
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
      tui.requestRender()
    },
  }

  if (config.provider === 'openai') {
    provider = new OpenAIProvider(config.api_key, config.model, systemPrompt, callbacks)
  } else {
    provider = new AnthropicProvider(config.api_key, config.model, systemPrompt, callbacks)
  }

  // Auto-greet
  chatLog.addSystem('  Starting session...')
  tui.start()

  // Show loader during greet
  loader = new Loader(tui, (s: string) => green(s), (s: string) => gray(s), 'Thinking...')
  chatLog.addChild(loader)
  loader.start()
  tui.requestRender()

  try {
    await provider.chat(
      'Session started. Follow the "First Session Greeting" instructions in your system prompt. Do NOT use any tools for this greeting — just respond directly.',
    )
  } catch { /* ignore greeting errors */ }

  if (loader) {
    chatLog.removeChild(loader)
    loader.stop()
    loader = null
  }
  tui.requestRender()

  // Background version check (non-blocking)
  let pendingUpdates: VersionUpdate[] | null = null
  checkSolanaReleases().then((updates) => {
    if (updates.length === 0) return

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
  }).catch(() => { /* silent fail */ })

  // Track user interactions for memory save decision
  let userMessageCount = 0
  let isProcessing = false

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
    console.log('\n  Goodbye!\n')
    Deno.exit(0)
  }

  editor.onSubmit = async (text: string) => {
    const input = text.trim()
    if (!input || isProcessing) return

    editor.setText('')

    if (input === '/exit' || input === '/quit') {
      isProcessing = true
      await saveMemoryAndExit()
      return
    }

    if (input === '/clear') {
      chatLog.clear()
      const newSystemPrompt = await buildSystemPrompt()
      if (config.provider === 'openai') {
        provider = new OpenAIProvider(config.api_key, config.model, newSystemPrompt, callbacks)
      } else {
        provider = new AnthropicProvider(config.api_key, config.model, newSystemPrompt, callbacks)
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
      chatLog.addSystem('  /help — Show this help')
      tui.requestRender()
      return
    }

    chatLog.addUser(input)
    userMessageCount++
    isProcessing = true

    // Show loader
    loader = new Loader(tui, (s: string) => green(s), (s: string) => gray(s), 'Thinking...')
    chatLog.addChild(loader)
    loader.start()
    tui.requestRender()

    try {
      await provider.chat(input)
    } catch (error) {
      chatLog.addSystem(red(`  Error: ${(error as Error).message}`))
    }

    if (loader) {
      chatLog.removeChild(loader)
      loader.stop()
      loader = null
    }
    isProcessing = false
    tui.requestRender()
  }

  // Global ctrl+c handler
  tui.addInputListener((data: string) => {
    if (matchesKey(data, 'ctrl+c')) {
      if (isProcessing) {
        // If LLM is running, exit immediately (can't wait for memory save)
        tui.stop()
        console.log('\n  Goodbye!\n')
        Deno.exit(0)
      } else {
        // Save memory before exit
        saveMemoryAndExit()
      }
      return { consume: true }
    }
    return undefined
  })
}
