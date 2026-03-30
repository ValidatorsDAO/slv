import { prompt, Select } from '@cliffy/prompt'
import { colors } from '@cliffy/colors'
import { listBotConfigs, loadBotConfig } from '/src/bot/botConfig.ts'
import type { BotConfig } from '@cmn/zod/bot.ts'

export const selectBot = async (
  name?: string,
): Promise<BotConfig | null> => {
  if (name) {
    const config = await loadBotConfig(name)
    if (!config) {
      console.log(
        colors.red(`❌ Bot config not found: ${name}`),
      )
      return null
    }
    return config
  }

  const configs = await listBotConfigs()

  if (configs.length === 0) {
    console.log(
      colors.yellow(
        '⚠️ No deployed bots found. Run `slv bot deploy` first.',
      ),
    )
    return null
  }

  if (configs.length === 1) {
    console.log(
      colors.cyan(`🤖 Auto-selected bot: ${configs[0].name}`),
    )
    return configs[0]
  }

  const options = configs.map((c) => ({
    name: colors.white(`${c.name} - ${c.ip} (${c.serviceName})`),
    value: c.name,
  }))

  const { botName } = await prompt([
    {
      name: 'botName',
      message: '🤖 Select a bot',
      type: Select,
      options,
    },
  ])

  return configs.find((c) => c.name === botName) ?? null
}
