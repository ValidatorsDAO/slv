import { Command } from '@cliffy'
import { colors } from '@cliffy/colors'
import { onboardAction } from '@/ai/onboard/onboardAction.ts'
import { consoleAction } from '@/ai/console/consoleAction.ts'

export const aiCmd = new Command()
  .description(colors.white('AI console and configuration'))
  .action(async () => {
    await consoleAction()
  })
  .command('console', 'Start the AI chat console')
  .action(async () => {
    await consoleAction()
  })

export const onboardCmd = new Command()
  .description(colors.white('Set up AI provider and API key'))
  .action(async () => {
    await onboardAction()
  })
