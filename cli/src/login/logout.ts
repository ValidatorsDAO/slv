import { Command } from '@cliffy'
import { colors } from '@cliffy/colors'
import { ERPC_DASHBOARD_URL } from '@cmn/constants/url.ts'
import { clearSlvCredentials, resolveHome } from '/lib/getApiKeyFromYml.ts'
import { userApiAuthFromSession } from '/lib/userApi/auth.ts'
import { userApiRequest } from '/lib/userApi/client.ts'
import {
  hasStoredLogin,
  readSlvSection,
  revokeRefreshToken,
} from '/lib/userApi/session.ts'

/**
 * Revoke the storage access key `slv` created for this machine, while the
 * login can still do it. A failure only warns: the local credentials are
 * removed either way.
 */
const revokeStorageAccessKey = async (home: string): Promise<void> => {
  const slv = await readSlvSection(home)
  const recordId = slv.storage_access_key_record_id
  if (
    typeof recordId !== 'number' || !Number.isInteger(recordId) ||
    recordId <= 0 || !hasStoredLogin(slv)
  ) {
    return
  }
  try {
    const res = await userApiRequest(
      userApiAuthFromSession(home),
      'DELETE',
      `/v3/storage/access-keys/${recordId}`,
    )
    // 404: already gone
    if (res.ok || res.status === 404) {
      console.log(
        colors.white('Revoked the storage access key of this machine.'),
      )
      return
    }
  } catch {
    // the login could not be refreshed, or user-api was not reachable
  }
  console.log(
    colors.yellow(
      `⚠️ Could not revoke the storage access key of this machine on the server. Please revoke it on the Storage page of the ERPC dashboard (${ERPC_DASHBOARD_URL}).`,
    ),
  )
}

/**
 * `slv logout`: revoke this machine's storage access key and the ERPC login's
 * refresh token on the servers (best effort), then remove every credential in
 * `slv:` (the ERPC login, the storage access key and the API key). The other
 * sections of ~/.slv/api.yml (e.g. ai) are kept.
 */
export const logoutAction = async (): Promise<void> => {
  console.log(
    colors.bold.blue(`⚡️ SLV Logout to remove your saved credentials ⚡️\n`),
  )
  const home = resolveHome()
  await revokeStorageAccessKey(home)
  // Read after the storage key step, which may have refreshed the login.
  await revokeRefreshToken(home)
  await clearSlvCredentials(home)

  console.log(
    colors.green(
      '\n✔️ Credentials Successfully Removed from ~/.slv/api.yml\n',
    ),
  )
  console.log(colors.white(`🚀 You have been logged out\n`))
}

export const logoutCmd = new Command()
  .description('Sign out of ERPC and remove the saved credentials')
  .action(() => logoutAction())
