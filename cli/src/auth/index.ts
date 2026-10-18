import { Command } from '@cliffy'
import { loginAction } from '@/login/index.ts'
import { SLV_OAUTH_MIGRATION_MESSAGE, writeAiConfig } from '@/ai/config.ts'

/** Compatibility entry point: authentication is always ERPC browser OAuth. */
export const authCmd = new Command()
  .description(
    'Sign in to ERPC with OAuth (alias for slv login; personal AI API keys are no longer supported)',
  )
  .action(async () => {
    console.log(SLV_OAUTH_MIGRATION_MESSAGE)
    await writeAiConfig()
    await loginAction()
  })
