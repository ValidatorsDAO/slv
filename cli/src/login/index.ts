import { Command } from '@cliffy'
import { prompt, Secret } from '@cliffy/prompt'
import { colors } from '@cliffy/colors'
import { ERPC_DASHBOARD_URL } from '@cmn/constants/url.ts'
import {
  isValidAccessToken,
  isValidApiKey,
  isValidStorageAccessKeyId,
  isValidStorageSecret,
  mergeSlvCredentials,
  resolveHome,
  type SlvCredentialKey,
  type SlvCredentialUpdate,
} from '/lib/getApiKeyFromYml.ts'
import { userApiAuthFromAccessToken } from '/lib/userApi/auth.ts'
import { userApiRequest } from '/lib/userApi/client.ts'

/**
 * What `slv login` asks for. A field that is empty or left out keeps the
 * value that is already saved.
 */
export type LoginInput = {
  /** API key (RPC endpoints). */
  apiKey?: string
  /** Account access token (user-api). */
  accessToken?: string
  /** Storage access key id (restic). Comes together with the secret. */
  storageAccessKeyId?: string
  /** Storage access key secret (restic). Comes together with the id. */
  storageSecret?: string
}

export type LoginResult =
  | { ok: true; saved: SlvCredentialKey[] }
  | { ok: false; error: string }

const clean = (value: string | undefined): string | undefined => {
  const trimmed = value?.trim()
  return trimmed ? trimmed : undefined
}

/**
 * Check everything first, then write once: a value of the wrong shape, a
 * half-given storage key, or a token the server does not accept leaves
 * ~/.slv/api.yml untouched. The new values are merged into `slv:` and the
 * rest of the file is kept.
 */
export const saveLogin = async (
  input: LoginInput,
  home: string = resolveHome(),
): Promise<LoginResult> => {
  const apiKey = clean(input.apiKey)
  const accessToken = clean(input.accessToken)
  const storageId = clean(input.storageAccessKeyId)
  const storageSecret = clean(input.storageSecret)

  if (apiKey && !isValidApiKey(apiKey)) {
    return {
      ok: false,
      error: 'The API key does not have the expected format (a UUID).',
    }
  }
  if (accessToken && !isValidAccessToken(accessToken)) {
    return {
      ok: false,
      error:
        'The account access token does not have the expected format (erpcat_ followed by 43 characters).',
    }
  }
  if (Boolean(storageId) !== Boolean(storageSecret)) {
    return {
      ok: false,
      error:
        'A storage access key needs both the key id and the secret. Enter both, or leave both empty.',
    }
  }
  if (storageId && !isValidStorageAccessKeyId(storageId)) {
    return {
      ok: false,
      error:
        'The storage access key id does not have the expected format (erpcsk_ followed by 16 characters).',
    }
  }
  if (storageSecret && !isValidStorageSecret(storageSecret)) {
    return {
      ok: false,
      error:
        'The storage access key secret does not have the expected format (43 characters).',
    }
  }

  if (accessToken) {
    try {
      const res = await userApiRequest<unknown>(
        userApiAuthFromAccessToken(accessToken),
        'GET',
        '/v3/user/get',
      )
      if (!res.ok) {
        return {
          ok: false,
          error:
            `The account access token was not accepted (HTTP ${res.status}).`,
        }
      }
    } catch (error) {
      return {
        ok: false,
        error: `Could not check the account access token: ${
          error instanceof Error ? error.message : String(error)
        }`,
      }
    }
  }

  const update: SlvCredentialUpdate = {}
  if (apiKey) update.api_key = apiKey
  if (accessToken) update.access_token = accessToken
  if (storageId && storageSecret) {
    update.storage_access_key_id = storageId
    update.storage_secret = storageSecret
  }
  const saved = Object.keys(update) as SlvCredentialKey[]
  if (saved.length > 0) await mergeSlvCredentials(update, home)
  return { ok: true, saved }
}

const LABELS: Record<SlvCredentialKey, string> = {
  api_key: 'API key',
  access_token: 'account access token',
  storage_access_key_id: 'storage access key id',
  storage_secret: 'storage access key secret',
}

export const loginCmd = new Command()
  .description(
    'Save your API key, account access token and storage access key on this machine',
  )
  .action(async () => {
    const loginTxt = `⚡️ SLV Login to unlock full features ⚡️\n`
    console.log(colors.bold.blue(loginTxt))
    console.log(
      colors.white(
        `If you don't have an account yet:

$ slv signup

Create your account access token and your storage access key in the ERPC dashboard:
${ERPC_DASHBOARD_URL} (storage access keys are on the Storage page).
Press Enter to keep a value that is already saved.
A storage access key with read_write permission is needed for --retention in
$ slv backup create --restic

`,
      ),
    )
    const answers = await prompt([
      {
        name: 'apiKey',
        message: '🔑 API key (for RPC; Enter to skip)',
        type: Secret,
      },
      {
        name: 'accessToken',
        message: '🔑 Account access token (Enter to skip)',
        type: Secret,
      },
      {
        name: 'storageAccessKeyId',
        message: '🔑 Storage access key id (optional; Enter to skip)',
        type: Secret,
      },
      {
        name: 'storageSecret',
        message: '🔑 Storage access key secret (optional; Enter to skip)',
        type: Secret,
      },
    ])

    const result = await saveLogin(answers)
    if (!result.ok) {
      console.log(colors.red(`\n❌ ${result.error}`))
      console.log(colors.white('Nothing was saved.\n'))
      Deno.exit(1)
    }
    if (result.saved.length === 0) {
      console.log(
        colors.yellow('\nNothing new was entered. Nothing was changed.\n'),
      )
      return
    }

    console.log(
      colors.green('\n✔️ Saved to ~/.slv/api.yml:'),
      result.saved.map((key) => LABELS[key]).join(', '),
      '\n',
    )
    console.log(colors.white(`🚀 Full Features Unlocked\n`))
    console.log(colors.blue(`👉 $ slv metal product\n`))
  })
