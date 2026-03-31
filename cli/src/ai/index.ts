import { Command } from '@cliffy'
import { colors } from '@cliffy/colors'
import { onboardAction } from '@/ai/onboard/onboardAction.ts'
import { consoleAction } from '@/ai/console/consoleAction.ts'
import { aiUsageAction } from '@/ai/usage/usageAction.ts'
import { aiProductAction } from '@/ai/product/productAction.ts'

export const aiCmd = new Command()
  .description(colors.white('AI console and configuration'))
  .action(async () => {
    await consoleAction()
  })
  .command('console', 'Start the AI chat console')
  .action(async () => {
    await consoleAction()
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
  .description(colors.white('Set up AI provider and API key'))
  .action(async () => {
    await onboardAction()
  })
