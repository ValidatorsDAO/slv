import { Command } from '@cliffy'
import { prompt, Secret } from '@cliffy/prompt'
import { colors } from '@cliffy/colors'
import { DISCORD_LINK } from '@cmn/constants/url.ts'
import { resolveHome } from '/lib/getApiKeyFromYml.ts'
import { parse, stringify } from '@std/yaml'

export const loginCmd = new Command()
  .description('Login to SLV using Discord')
  .action(async () => {
    const loginTxt = `⚡️ SLV Login to unlock full features ⚡️\n`
    console.log(colors.bold.blue(loginTxt))
    console.log(
      colors.white(
        `If you don't have one:
        
$ slv signup

`,
      ),
    )
    const { apiKey } = await prompt([{
      name: 'apiKey',
      message: '🔑 Enter API Key',
      type: Secret,
    }])
    const home = resolveHome()
    const configDir = home + '/.slv'
    const inventoryPath = configDir + '/api.yml'
    await Deno.mkdir(configDir, { recursive: true })

    // Read existing config to preserve other sections (e.g. ai)
    let existing: Record<string, unknown> = {}
    try {
      const content = await Deno.readTextFile(inventoryPath)
      existing = (parse(content) as Record<string, unknown>) ?? {}
    } catch {
      // File doesn't exist or is invalid — start fresh
    }
    existing.slv = { api_key: apiKey }
    await Deno.writeTextFile(inventoryPath, stringify(existing))
    await Deno.chmod(inventoryPath, 0o600)

    console.log(
      colors.green('\n✔️ API Key Successfully Saved to ~/.slv/api.yml\n'),
    )
    console.log(colors.white(`🚀 Full Features Unlocked\n`))
    console.log(colors.blue(`👉 $ slv metal product\n`))
  })
