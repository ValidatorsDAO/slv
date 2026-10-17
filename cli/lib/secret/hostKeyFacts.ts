import { parse } from '@std/yaml'
import type { InventoryType } from '@cmn/types/config.ts'
import { BASE58_PUBKEY } from '/lib/secret/base58.ts'

// What an inventory entry says about the key of its host: the identity_account,
// the vote_account and the identity_ref. Nothing else of the entry is read.

type HostKeyFacts = {
  name: string
  identityAccount: string
  /** The vote_account of the entry, or null when it has none. */
  voteAccount: string | null
  /** The identity_ref as written, or undefined when the entry has none. */
  identityRef: string | undefined
}

class HostFactsError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'HostFactsError'
  }
}

const isMapping = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** The key facts of one host of the group in the text of an inventory file. */
const readHostKeyFacts = (
  inventoryText: string,
  group: InventoryType,
  name: string,
): HostKeyFacts => {
  let document: unknown
  try {
    document = parse(inventoryText)
  } catch (_error) {
    throw new HostFactsError('the inventory is not valid YAML')
  }
  const section = isMapping(document) ? document[group] : undefined
  const hosts = isMapping(section) ? section.hosts : undefined
  const entry = isMapping(hosts) && Object.hasOwn(hosts, name)
    ? hosts[name]
    : undefined
  if (!isMapping(entry)) {
    throw new HostFactsError(
      `${name} is not a host of ${group} in the inventory`,
    )
  }
  const identityAccount = entry.identity_account
  if (
    typeof identityAccount !== 'string' || !BASE58_PUBKEY.test(identityAccount)
  ) {
    throw new HostFactsError(`${name} has no identity_account in the inventory`)
  }
  let voteAccount: string | null = null
  if (entry.vote_account !== undefined && entry.vote_account !== '') {
    if (
      typeof entry.vote_account !== 'string' ||
      !BASE58_PUBKEY.test(entry.vote_account)
    ) {
      throw new HostFactsError(`vote_account of ${name} is not a public key`)
    }
    voteAccount = entry.vote_account
  }
  const ref = entry.identity_ref
  if (ref !== undefined && ref !== null && typeof ref !== 'string') {
    throw new HostFactsError(`identity_ref of ${name} is not text`)
  }
  return {
    name,
    identityAccount,
    voteAccount,
    identityRef: ref === null || ref === '' ? undefined : ref,
  }
}

export { HostFactsError, readHostKeyFacts }
export type { HostKeyFacts }
