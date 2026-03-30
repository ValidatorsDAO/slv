import { join } from '@std/path'
import { parse, stringify } from '@std/yaml'
import { configRoot } from '@cmn/constants/path.ts'
import type { BotConfig } from '@cmn/zod/bot.ts'
import { BotConfigSchema } from '@cmn/zod/bot.ts'

export const botConfigDir = join(configRoot, 'bot')

export const getBotConfigPath = (name: string): string => {
  return join(botConfigDir, `${name}.yml`)
}

export const saveBotConfig = async (config: BotConfig): Promise<void> => {
  await Deno.mkdir(botConfigDir, { recursive: true })
  const path = getBotConfigPath(config.name)
  const yml = stringify(config as Record<string, unknown>)
  await Deno.writeTextFile(path, yml)
}

export const loadBotConfig = async (
  name: string,
): Promise<BotConfig | null> => {
  const path = getBotConfigPath(name)
  try {
    const content = await Deno.readTextFile(path)
    const data = parse(content)
    const result = BotConfigSchema.safeParse(data)
    if (!result.success) return null
    return result.data
  } catch {
    return null
  }
}

export const listBotConfigs = async (): Promise<BotConfig[]> => {
  const configs: BotConfig[] = []
  try {
    for await (const entry of Deno.readDir(botConfigDir)) {
      if (entry.isFile && entry.name.endsWith('.yml')) {
        const name = entry.name.replace(/\.yml$/, '')
        const config = await loadBotConfig(name)
        if (config) configs.push(config)
      }
    }
  } catch {
    // directory doesn't exist yet
  }
  return configs
}
