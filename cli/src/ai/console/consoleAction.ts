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
import { setTuiInstance } from '@/ai/console/tools.ts'
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

export const consoleAction = async () => {
  const config = await readAiConfig()
  if (!config) {
    console.log('\n  AI not configured. Run `slv onboard` first.\n')
    return
  }

  const systemPrompt = await buildSystemPrompt()
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

  // Provider init with callbacks
  let provider: OpenAIProvider | AnthropicProvider
  let loader: Loader | null = null

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
      if (loader) {
        chatLog.removeChild(loader)
        loader.stop()
        loader = null
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

  // Editor submit handler
  let isProcessing = false

  editor.onSubmit = async (text: string) => {
    const input = text.trim()
    if (!input || isProcessing) return

    editor.setText('')

    if (input === '/exit' || input === '/quit') {
      chatLog.addSystem('  Saving session...')
      tui.requestRender()
      isProcessing = true
      try {
        await provider.chat(
          'Session ending. If anything important happened, update ~/.slv/agent/MEMORY.md using write_file. Keep it concise. If nothing notable, do nothing.',
        )
      } catch { /* ignore */ }
      tui.stop()
      await terminal.drainInput()
      console.log('\n  Goodbye!\n')
      Deno.exit(0)
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

    if (input === '/help') {
      chatLog.addSystem('  /exit, /quit — Exit')
      chatLog.addSystem('  /clear — Clear conversation')
      chatLog.addSystem('  /help — Show this help')
      tui.requestRender()
      return
    }

    chatLog.addUser(input)
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
      tui.stop()
      console.log('\n  Goodbye!\n')
      Deno.exit(0)
      return { consume: true }
    }
    return undefined
  })
}
