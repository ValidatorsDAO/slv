import { Command } from '@cliffy'
import { colors } from '@cliffy/colors'

// Discord login URL - replace with the actual URL if needed
const DISCORD_LOGIN_URL =
  'https://discord.com/oauth2/authorize?client_id=1283876217006718976&response_type=code&redirect_uri=https%3A%2F%2Fuser-api.erpc.global%2Fv2%2Fdiscord%2Flogin&scope=identify+email'

export const signupCmd = new Command()
  .description('Signup to SLV using Discord')
  .action(() => {
    console.log(colors.bold.green('\n✏️ SLV Signup\n'))
    console.log(
      colors.white(`👇 Please visit the following URL to login with Discord:`),
    )
    console.log(colors.blue.underline(DISCORD_LOGIN_URL))
    console.log(
      colors.white(
        `\nAfter logging in,\nYou will get a validation link to your email.\nAPI Key will be showed on the discord dashboard after validation.\n`,
      ),
    )
    console.log(
      colors.white(
        `This login is required to access certain SLV features.\n\n$ slv login\n\nTo login after signup.\n`,
      ),
    )
  })
