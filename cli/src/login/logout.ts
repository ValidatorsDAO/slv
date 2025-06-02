import { Command } from '@cliffy'
import { colors } from '@cliffy/colors'

export const logoutCmd = new Command()
  .description('Logout from SLV')
  .action(async () => {
    const loginTxt = `⚡️ SLV Logout to remove API Key ⚡️\n`
    console.log(colors.bold.blue(loginTxt))
    const home = Deno.env.get('HOME')
    if (!home) {
      console.log(colors.red('⚠️ HOME environment variable not found'))
      Deno.exit(1)
    }
    const inventoryPath = home + '/.slv/api.yml'
    try {
      await Deno.stat(inventoryPath)
      await Deno.writeTextFile(
        inventoryPath,
        `slv:
  api_key:`,
      )
    } catch (_error) {
      await Deno.writeTextFile(
        inventoryPath,
        `slv:
  api_key:`,
      )
    }
    console.log(
      colors.green('\n✔️ API Key Successfully Removed from ~/.slv/api.yml\n'),
    )
    console.log(colors.white(`🚀 You have been logged out\n`))
  })
