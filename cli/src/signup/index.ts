import { Command } from '@cliffy'
import { colors } from '@cliffy/colors'
import { ERPC_DASHBOARD_URL } from '@cmn/constants/url.ts'
import { openInBrowser } from '/lib/userApi/session.ts'

export const signupAction = (
  deps: { openBrowser?: (url: string) => void } = {},
): void => {
  console.log(colors.bold.green('\n✏️ SLV Signup\n'))
  console.log(
    colors.white(`👇 Open the ERPC dashboard and create your account:`),
  )
  console.log(colors.blue.underline(ERPC_DASHBOARD_URL))
  console.log(
    colors.white(
      '\nChoose Sign up or a sign-in provider, then complete the account and email verification steps shown there.\n' +
        'Any paid service activation is handled separately in the dashboard, with its current price shown before payment.\n',
    ),
  )
  console.log(
    colors.white(
      'After registration, return to this terminal and sign in on this machine:\n\n$ slv login\n' +
        '\nThen set up your AI agent with $ slv onboard and open it with $ slv c.\n',
    ),
  )
  ;(deps.openBrowser ?? openInBrowser)(ERPC_DASHBOARD_URL)
}

export const signupCmd = new Command()
  .description('Open ERPC account registration, then sign in with slv login')
  .action(() => signupAction())
