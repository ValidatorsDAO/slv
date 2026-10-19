import { parseIdentityRef } from '/lib/secret/identityRef.ts'
import { keypairText, proveKeypair, zero } from '/lib/secret/keypairBytes.ts'
import {
  createItem,
  itemTemplate,
  listItems,
  verifyStoredKey,
} from '/lib/secret/opItems.ts'
import type { SecretSetup } from '/lib/secret/setup.ts'

/** Safe metadata returned only after the stored key and public field verify. */
export type StoredIdentity = { pubkey: string; identityRef: string }

/** Call only after prepareSecretSetup and the applicable vault confirmation. */
export async function storeGeneratedKey(
  setup: SecretSetup,
  vaultId: string,
  title: string,
  generate: () => Promise<Uint8Array>,
  consequence: string,
): Promise<StoredIdentity> {
  const before = await listItems(setup, vaultId)
  let keypair: Uint8Array | undefined
  let canonical: Uint8Array | undefined
  let template: Uint8Array | undefined
  try {
    keypair = await generate()
    const pubkey = await proveKeypair(keypair)
    canonical = keypairText(keypair)
    template = itemTemplate(title, pubkey, canonical)
    const itemId = await createItem(setup, vaultId, title, template, before)
    const ref =
      parseIdentityRef(`op://${vaultId}/${itemId}/keypair`, { homeDir: '/' })
        .ref
    await verifyStoredKey(setup, ref, { pubkey, canonical }, {
      what: 'made',
      consequence,
    })
    return { pubkey, identityRef: ref.text }
  } finally {
    zero(keypair, canonical, template)
  }
}
