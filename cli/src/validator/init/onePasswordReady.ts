import { buildOpEnv } from '/lib/secret/opCli.ts'
import { zero } from '/lib/secret/keypairBytes.ts'
import {
  defaultSecretSetupDeps,
  prepareSecretSetup,
  SecretRefusal,
  type SecretSetupDeps,
} from '/lib/secret/setup.ts'

export const ONE_PASSWORD_HELP =
  'Open and unlock 1Password, enable Settings > Developer > Integrate with 1Password CLI, then retry from your terminal. On macOS 27, allow that terminal to access “Data shared by 1Password” in System Settings > Privacy & Security > Files & Folders. Do not add an account or paste a token into SLV. https://www.1password.dev/cli/app-integration'

/** Metadata only, before SSH or any key/account/inventory mutation. */
export async function verifyInitOnePassword(
  network: 'mainnet' | 'testnet',
  deps: SecretSetupDeps = defaultSecretSetupDeps(),
): Promise<void> {
  const setup = await prepareSecretSetup(network, deps)
  const run = (args: string[]) =>
    setup.resolve.op(setup.resolve.opPath, args, {
      env: buildOpEnv(setup.resolve.parentEnv, setup.token),
      stdin: null,
      timeoutMs: 60_000,
    })
  if (setup.token === null) {
    // account list does not enter op's interactive account-add fallback. Do not
    // ask vault list/whoami to authenticate until an account is discoverable.
    const accounts = await run(['account', 'list', '--format', 'json'])
    try {
      let listed: unknown
      try {
        listed = JSON.parse(new TextDecoder().decode(accounts.stdout))
      } catch {
        listed = null
      }
      if (
        !accounts.success || !Array.isArray(listed) ||
        !listed.some((a) =>
          a && typeof a === 'object' && !Array.isArray(a) &&
          Object.keys(a).length > 0
        )
      ) {
        throw new SecretRefusal(
          `1Password CLI cannot find an account. ${ONE_PASSWORD_HELP}`,
        )
      }
    } finally {
      zero(accounts.stdout, accounts.stderr)
    }
  }
  const vaults = await run(['vault', 'list', '--format', 'json'])
  try {
    let listed: unknown
    try {
      listed = JSON.parse(new TextDecoder().decode(vaults.stdout))
    } catch {
      listed = null
    }
    if (
      !vaults.success || !Array.isArray(listed) ||
      !listed.some((v) =>
        v && typeof v.id === 'string' && /^[a-z0-9]{26}$/.test(v.id)
      )
    ) {
      throw new SecretRefusal(
        `1Password vault access is not ready. ${ONE_PASSWORD_HELP}`,
      )
    }
    if (
      setup.policy.vaultId &&
      !listed.some((v) => v?.id === setup.policy.vaultId)
    ) {
      throw new SecretRefusal(
        'The configured network vault is not available in this 1Password account. Check keyless.yml before retrying; no key was created.',
      )
    }
  } finally {
    zero(vaults.stdout, vaults.stderr)
  }
}
