import { Command } from '@cliffy'
import { colors } from '@cliffy/colors'
import { clearSlvCredentials } from '/lib/getApiKeyFromYml.ts'

export const logoutCmd = new Command()
  .description('Logout from SLV')
  .action(async () => {
    const loginTxt = `⚡️ SLV Logout to remove your saved credentials ⚡️\n`
    console.log(colors.bold.blue(loginTxt))

    // Clears every credential in the `slv:` section (API key, account access
    // token, storage access key) and keeps the other sections (e.g. ai).
    await clearSlvCredentials()

    console.log(
      colors.green(
        '\n✔️ Credentials Successfully Removed from ~/.slv/api.yml\n',
      ),
    )
    console.log(colors.white(`🚀 You have been logged out\n`))
  })
