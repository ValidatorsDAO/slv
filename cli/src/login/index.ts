import { Command } from '@cliffy'
import { colors } from '@cliffy/colors'
import { ERPC_DASHBOARD_URL } from '@cmn/constants/url.ts'
import { resolveHome } from '/lib/getApiKeyFromYml.ts'
import { userApiAuthFromAccessToken } from '/lib/userApi/auth.ts'
import { userApiRequest } from '/lib/userApi/client.ts'
import {
  nowInSeconds,
  openInBrowser,
  pollDeviceToken,
  requestDeviceAuthorization,
  revokeRefreshToken,
  saveSession,
} from '/lib/userApi/session.ts'

/** What `slv login` waits with; tests replace these so nothing really waits. */
export type LoginDeps = {
  /** Wait `ms` milliseconds before the next poll. */
  sleep?: (ms: number) => Promise<void>
  /** Current time in Unix seconds. */
  now?: () => number
  /** Open the sign-in page (desktop sessions only). */
  openBrowser?: (url: string) => void
}

const wait = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms))

const TRY_AGAIN = 'Run $ slv login to try again.'

export type DeviceLoginResult =
  | { ok: true; username: string | null }
  | { ok: false; lines: string[] }

const pollError = (error: string): string[] => {
  switch (error) {
    case 'access_denied':
      return ['The sign-in was denied in the browser.', TRY_AGAIN]
    case 'expired_token':
      return ['The code expired before the sign-in was finished.', TRY_AGAIN]
    default:
      return [`The sign-in did not finish (${error}).`, TRY_AGAIN]
  }
}

/**
 * Sign in to ERPC in a browser (OAuth device authorization) and save the
 * login. Shows the page and the code, waits for the browser, checks the new
 * access token against user-api, and only then merges the access token, the
 * refresh token and the expiry into `slv:` of ~/.slv/api.yml (a saved storage
 * access key and API key stay). The refresh token of a login it replaces is
 * then revoked (best effort). A failure returns what to tell the user and
 * leaves the file as it was.
 */
export const runDeviceLogin = async (
  deps: LoginDeps = {},
): Promise<DeviceLoginResult> => {
  const sleep = deps.sleep ?? wait
  const now = deps.now ?? nowInSeconds
  const openBrowser = deps.openBrowser ?? openInBrowser
  const home = resolveHome()

  const started = await requestDeviceAuthorization()
  if (!started.ok) {
    return {
      ok: false,
      lines: [`Could not start the sign-in (${started.error}).`, TRY_AGAIN],
    }
  }
  const authorization = started.authorization

  console.log(colors.white('Open this page and confirm the code:\n'))
  console.log(
    colors.blue.underline(`  ${authorization.verificationUriComplete}`),
  )
  console.log(colors.white(`\n  Code: ${colors.bold(authorization.userCode)}`))
  console.log(
    colors.gray(
      `  (or open ${authorization.verificationUri} and enter the code)\n`,
    ),
  )
  openBrowser(authorization.verificationUriComplete)
  console.log(
    colors.white('Waiting for the sign-in to finish in the browser...'),
  )

  const polled = await pollDeviceToken(authorization, { sleep, now })
  if (!polled.ok) return { ok: false, lines: pollError(polled.error) }

  // user-api answers 401 when no ERPC account belongs to this sign-in.
  let username: string | null = null
  try {
    const res = await userApiRequest<{ username?: unknown }>(
      userApiAuthFromAccessToken(polled.tokens.accessToken),
      'GET',
      '/v3/user/get',
    )
    if (!res.ok) {
      return {
        ok: false,
        lines: [
          'No ERPC account was found for this sign-in.',
          `Create your account at ${ERPC_DASHBOARD_URL}, then run $ slv login again.`,
        ],
      }
    }
    if (typeof res.data?.username === 'string') username = res.data.username
  } catch (error) {
    return {
      ok: false,
      lines: [
        `Could not check the sign-in with user-api (${
          error instanceof Error ? error.message : String(error)
        }).`,
        TRY_AGAIN,
      ],
    }
  }

  const replaced = await saveSession(home, polled.tokens, polled.receivedAt)
  // The login this one replaced is not needed any more (best effort).
  if (replaced && replaced !== polled.tokens.refreshToken) {
    await revokeRefreshToken(replaced)
  }
  return { ok: true, username }
}

/** `slv login`. Asks for nothing in the terminal; any failure exits with 1. */
export const loginAction = async (deps: LoginDeps = {}): Promise<void> => {
  console.log(colors.bold.blue(`⚡️ SLV Login ⚡️\n`))
  console.log(
    colors.white(
      `Sign in to ERPC in your browser to link this machine to your ERPC account.
To switch to another account, run $ slv logout first.
Sign in on each machine: a copy of ~/.slv/api.yml used on a second machine
signs both machines out at the next token refresh.
No account yet? $ slv signup
`,
    ),
  )

  const result = await runDeviceLogin(deps)
  if (!result.ok) {
    console.log(colors.red(`\n❌ ${result.lines[0]}`))
    for (const line of result.lines.slice(1)) console.log(colors.white(line))
    console.log(colors.white('Nothing was saved.\n'))
    Deno.exit(1)
  }

  console.log(
    colors.green(
      `\n✔️ ${
        result.username
          ? `Signed in as ${result.username}.`
          : 'Signed in to ERPC.'
      } Saved to ~/.slv/api.yml.\n`,
    ),
  )
  console.log(colors.white(`🚀 Full Features Unlocked\n`))
  console.log(colors.blue(`👉 $ slv metal product\n`))
}

export const loginCmd = new Command()
  .description('Sign in to ERPC in your browser and link this machine')
  .action(() => loginAction())
