import { colors } from '@cliffy/colors'
import { join } from '@std/path'
import { keyPath } from '@cmn/constants/path.ts'
import type { InventoryType } from '@cmn/types/config.ts'
import { type InventoryHost, readInventoryHosts } from '/lib/targetGuard.ts'
import { registerBlsPubkey } from '/src/validator/registerBlsPubkey.ts'

type DeployNetwork = 'mainnet' | 'testnet'

type RegisterBlsAfterDeployDeps = {
  readHosts: (inventoryType: InventoryType) => Promise<InventoryHost[]>
  /** Whether ~/.slv/keys/<identity>.json is on this machine. */
  keyFileExists: (identityAccount: string) => Promise<boolean>
  registerBls: (network: DeployNetwork, limit?: string) => Promise<boolean>
  warn: (line: string) => void
}

const keyFileOnThisMachine = async (
  identityAccount: string,
  keyDir: string = keyPath,
): Promise<boolean> => {
  try {
    return (await Deno.stat(join(keyDir, `${identityAccount}.json`))).isFile
  } catch (error) {
    // Only a file that is not there skips the step; any other answer lets the
    // registration try, as it did before.
    return !(error instanceof Deno.errors.NotFound)
  }
}

const defaultRegisterBlsAfterDeployDeps = (): RegisterBlsAfterDeployDeps => ({
  readHosts: readInventoryHosts,
  keyFileExists: keyFileOnThisMachine,
  registerBls: registerBlsPubkey,
  warn: (line) => console.warn(colors.yellow(line)),
})

/**
 * The step after a validator deploy: register the BLS public key on the vote
 * account of each deployed host. The key that signs it is the identity key on
 * this machine (~/.slv/keys/<identity>.json), and deploy never copies that key
 * to the node, so a host whose key file is not here is skipped, with the
 * command to run when it is. It never fails the deploy.
 */
const registerBlsAfterDeploy = async (
  network: DeployNetwork,
  limit?: string,
  overrides: Partial<RegisterBlsAfterDeployDeps> = {},
): Promise<void> => {
  const deps = { ...defaultRegisterBlsAfterDeployDeps(), ...overrides }
  try {
    const inventoryType: InventoryType = network === 'mainnet'
      ? 'mainnet_validators'
      : 'testnet_validators'
    let hosts: InventoryHost[] = []
    try {
      hosts = await deps.readHosts(inventoryType)
    } catch (_error) {
      // The registration reads the inventory itself and says what is wrong.
    }
    const byName = new Map(hosts.map((host) => [host.name, host]))
    const names = limit && limit.trim().toLowerCase() !== 'all'
      ? limit.split(',').map((name) => name.trim()).filter(Boolean)
      : hosts.map((host) => host.name)

    const withKey: string[] = []
    for (const name of names) {
      const identity = byName.get(name)?.identityAccount ?? ''
      // A host the inventory does not have, or has no identity for, is left to
      // the registration, which says so.
      if (identity === '' || await deps.keyFileExists(identity)) {
        withKey.push(name)
        continue
      }
      deps.warn(
        `⚠️ ${name}: no key file at ~/.slv/keys/${identity}.json on this machine, so its BLS public key was not registered. Run this when the key is here: slv v register:bls -n ${network} -p ${name}`,
      )
    }
    if (withKey.length === names.length) {
      await deps.registerBls(network, limit)
    } else if (withKey.length > 0) {
      await deps.registerBls(network, withKey.join(','))
    }
  } catch (e) {
    deps.warn(
      `⚠️ BLS pubkey registration skipped: ${
        e instanceof Error ? e.message : e
      }`,
    )
  }
}

export { keyFileOnThisMachine, registerBlsAfterDeploy }
export type { DeployNetwork, RegisterBlsAfterDeployDeps }
