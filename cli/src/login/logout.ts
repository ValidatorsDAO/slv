import { Command } from '@cliffy'
import { colors } from '@cliffy/colors'
import { resolveHome } from '/lib/getApiKeyFromYml.ts'

export const logoutCmd = new Command()
  .description('Logout from SLV')
  .action(async () => {
    const loginTxt = `⚡️ SLV Logout to remove API Key ⚡️\n`
    console.log(colors.bold.blue(loginTxt))
    const home = resolveHome()
    const configDir = home + '/.slv'
    const inventoryPath = configDir + '/api.yml'
    await Deno.mkdir(configDir, { recursive: true })
    await Deno.writeTextFile(
      inventoryPath,
      `slv:
  api_key:`,
    )
    console.log(
      colors.green('\n✔️ API Key Successfully Removed from ~/.slv/api.yml\n'),
    )
    console.log(colors.white(`🚀 You have been logged out\n`))
  })
