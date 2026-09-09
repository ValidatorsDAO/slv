import { Command } from '@cliffy'
import { colors } from '@cliffy/colors'
import { ERPC_DASHBOARD_URL } from '/lib/slvCloudMcp.ts'

export const signupCmd = new Command()
  .description('Sign up for SLV and activate an API key')
  .action(() => {
    console.log(colors.bold.green('\n✏️ SLV Signup\n'))
    console.log(
      colors.white(`👇 Open the ERPC dashboard and create your account:`),
    )
    console.log(colors.blue.underline(ERPC_DASHBOARD_URL))
    console.log(
      colors.white(
        `\nRegister there, then complete the €5 payment authorization to activate your API key.\n`,
      ),
    )
    console.log(
      colors.white(
        `Save the key on this machine with:\n\n$ slv login\n`,
      ),
    )
  })
