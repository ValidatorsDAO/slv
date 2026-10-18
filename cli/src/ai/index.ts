import { Command } from '@cliffy'
import { colors } from '@cliffy/colors'
import { onboardAction } from '@/ai/onboard/onboardAction.ts'
import { consoleAction } from '@/ai/console/consoleAction.ts'
import { aiUsageAction } from '@/ai/usage/usageAction.ts'
import { aiProductAction } from '@/ai/product/productAction.ts'

// `-g / --via-gateway` opts the TUI into the new WebSocket-backed
// client that talks to the local gateway daemon. Still experimental
// (Phase 2D-v1) — tool calls aren't wired into gateway sessions
// yet, so for now this is a text-chat dogfood mode. Kept as a flag
// (not the default) to avoid regressing non-engineer users mid-
// rollout. Will flip default once tool support + reconnect land.
type ConsoleFlags = { viaGateway?: boolean }

export const aiCmd = new Command()
  .description(colors.white('AI console and configuration'))
  .option(
    '-g, --via-gateway',
    'Run the chat through the local SLV background service (experimental — text-only for now)',
    { default: false },
  )
  .action(async (opts: ConsoleFlags) => {
    await consoleAction({ viaGateway: opts.viaGateway })
  })
  .command('console', 'Start the AI chat console')
  .option(
    '-g, --via-gateway',
    'Run the chat through the local SLV background service (experimental — text-only for now)',
    { default: false },
  )
  .action(async (opts: ConsoleFlags) => {
    await consoleAction({ viaGateway: opts.viaGateway })
  })
  .command('usage', 'Show AI token usage and remaining balance')
  .action(async () => {
    await aiUsageAction()
  })
  .command('product', 'Browse AI plans and purchase options')
  .action(async () => {
    await aiProductAction()
  })

export const onboardCmd = new Command()
  .description(
    colors.white(
      'Quick setup: connect ERPC and enable all specialists, then start chatting. Use --advanced for personalization, notifications and browser access. Config-file runs never start browser sign-in or chat.',
    ),
  )
  .option(
    '--config <path:string>',
    'YAML overrides for setup defaults (language and confirmation may still be prompted).',
  )
  .option(
    '--advanced',
    'Personalize names, deployment mode, notifications and browser access',
    { default: false },
  )
  .option('--no-start', 'Save settings without opening the AI console')
  .action(
    async (opts: { config?: string; advanced?: boolean; start?: boolean }) => {
      const result = await onboardAction({
        configPath: opts.config,
        advanced: opts.advanced,
      })
      if (
        result.ready && opts.start !== false && !opts.config &&
        !opts.advanced && Deno.stdin.isTerminal()
      ) {
        await consoleAction()
      } else if (!result.ready && !result.cancelled && !opts.config) {
        Deno.exitCode = 1
      }
    },
  )
