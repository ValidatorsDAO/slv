import { Command } from '@cliffy'
import { prompt, Secret } from '@cliffy/prompt'
import { colors } from '@cliffy/colors'
import { DISCORD_LINK } from '@cmn/constants/url.ts'

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
    const home = Deno.env.get('HOME')
    if (!home) {
      console.log(colors.red('⚠️ HOME environment variable not found'))
      Deno.exit(1)
    }
    const configDir = home + '/.slv'
    const inventoryPath = configDir + '/api.yml'
    await Deno.mkdir(configDir, { recursive: true })
    await Deno.writeTextFile(
      inventoryPath,
      `slv:
  api_key: ${apiKey}`,
    )
    console.log(
      colors.green('\n✔️ API Key Successfully Saved to ~/.slv/api.yml\n'),
    )
    console.log(colors.white(`🚀 Full Features Unlocked\n`))
    console.log(colors.blue(`👉 $ slv metal product\n`))
  })
