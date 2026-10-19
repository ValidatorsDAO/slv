import { parse } from '@std/yaml'
import type { InventoryType } from '@cmn/types/config.ts'
import { getInventoryPath } from '@cmn/constants/path.ts'
import { BASE58_PUBKEY } from '/lib/secret/base58.ts'
import {
  parseSshTarget,
  type SshTarget,
  TargetError,
} from '/lib/ssh/sshTarget.ts'

// The validator inventory of a network, read for the verbs that talk to one
// node: the host to connect to, and every account the inventory names.

/** The inventory group of a network's validators, or null when the network has none. */
const validatorGroup = (network: string): InventoryType | null =>
  network === 'testnet'
    ? 'testnet_validators'
    : network === 'mainnet'
    ? 'mainnet_validators'
    : null

type InventoryReader = {
  /** The text of a file, or null when there is none. */
  readText: (path: string) => Promise<string | null>
  homeDir: string | undefined
}

const defaultInventoryReader = (): InventoryReader => ({
  readText: async (path) => {
    try {
      return await Deno.readTextFile(path)
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) return null
      throw error
    }
  },
  homeDir: Deno.env.get('HOME'),
})

const readInventoryText = async (
  group: InventoryType,
  reader: InventoryReader,
): Promise<string> => {
  const path = getInventoryPath(group)
  const text = await reader.readText(path)
  if (text === null) throw new TargetError(`there is no inventory file ${path}`)
  return text
}

/** The target of one host of the validator inventory of a network. */
const readSshTarget = async (
  network: string,
  name: string,
  options: { identityAgent: string | null },
  reader: InventoryReader = defaultInventoryReader(),
): Promise<{ target: SshTarget; accounts: string[] }> => {
  const group = validatorGroup(network)
  if (group === null) {
    throw new TargetError(`${network} has no validator inventory`)
  }
  if (!reader.homeDir) throw new TargetError('HOME is not set')
  const text = await readInventoryText(group, reader)
  return {
    target: parseSshTarget(text, group, name, {
      homeDir: reader.homeDir,
      identityAgent: options.identityAgent,
    }),
    accounts: inventoryAccounts(text, group),
  }
}

/**
 * The accounts that an inventory file names, or none when the file is not
 * there. A file that cannot be read or is not valid is an error: what it names
 * is not known then.
 */
const readInventoryAccounts = async (
  group: InventoryType,
  reader: InventoryReader,
): Promise<string[]> => {
  const text = await reader.readText(getInventoryPath(group))
  return text === null ? [] : inventoryAccounts(text, group)
}

/** Every identity_account and vote_account that the hosts of a group name. */
const inventoryAccounts = (text: string, group: InventoryType): string[] => {
  const document = parse(text) as
    | Record<string, { hosts?: Record<string, Record<string, unknown> | null> }>
    | null
  const accounts = new Set<string>()
  for (const entry of Object.values(document?.[group]?.hosts ?? {})) {
    for (const key of ['identity_account', 'vote_account']) {
      const value = entry?.[key]
      if (typeof value === 'string' && BASE58_PUBKEY.test(value)) {
        accounts.add(value)
      }
    }
  }
  return [...accounts]
}

export {
  defaultInventoryReader,
  inventoryAccounts,
  readInventoryAccounts,
  readSshTarget,
  validatorGroup,
}
export type { InventoryReader }
