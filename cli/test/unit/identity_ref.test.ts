import { assertEquals, assertThrows } from '@std/assert'
import {
  IdentityRefError,
  parseIdentityRef,
  pubkeyFieldRef,
} from '/lib/secret/identityRef.ts'

const VAULT = 'abcdefghijklmnopqrstuvwxyz'
const ITEM = 'a1b2c3d4e5f6g7h8i9j0k1l2m3'
const IDENTITY = 'FVen3X669xLzsi6N2V91DoiyzHzg1uAgqiT8jZ9nS96Z'
const HOME = '/home/operator'

const parse = (value: string | undefined, identityAccount?: string) =>
  parseIdentityRef(value, { identityAccount, homeDir: HOME })

Deno.test('a reference of 1Password ids or of an absolute file path is read, and nothing else', () => {
  const op = parse(`op://${VAULT}/${ITEM}/keypair`)
  assertEquals(op.ref, {
    kind: 'op',
    vaultId: VAULT,
    itemId: ITEM,
    text: `op://${VAULT}/${ITEM}/keypair`,
  })
  assertEquals(op.warnings, [])
  assertEquals(pubkeyFieldRef(op.ref), `op://${VAULT}/${ITEM}/pubkey`)

  const file = parse('file:///home/operator/.slv/keys/test-1.json')
  assertEquals(file.ref, {
    kind: 'file',
    path: '/home/operator/.slv/keys/test-1.json',
    legacy: false,
    text: 'file:///home/operator/.slv/keys/test-1.json',
  })
  assertEquals(file.warnings, [])
  assertEquals(pubkeyFieldRef(file.ref), null)

  const refused: [string, string][] = [
    [
      'a vault and an item named by name',
      'op://slv-validators/my item/keypair',
    ],
    ['a vault name with an item id', `op://Private/${ITEM}/keypair`],
    ['an item name with a vault id', `op://${VAULT}/my-key/keypair`],
    ['a section', `op://${VAULT}/${ITEM}/section/keypair`],
    ['no field', `op://${VAULT}/${ITEM}`],
    ['another field', `op://${VAULT}/${ITEM}/password`],
    ['a query', `op://${VAULT}/${ITEM}/keypair?attribute=otp`],
    ['an id of 25 characters', `op://${VAULT.slice(1)}/${ITEM}/keypair`],
    ['an id of 27 characters', `op://${VAULT}x/${ITEM}/keypair`],
    ['an id in capitals', `op://${VAULT.toUpperCase()}/${ITEM}/keypair`],
    ['a space', `op://${VAULT}/${ITEM}/key pair`],
    ['a line break', `op://${VAULT}/${ITEM}/keypair\n`],
    ['a relative file', 'file://relative/key.json'],
    ['a file with .. in it', 'file:///home/operator/../root/key.json'],
    ['a file with a double slash', 'file:///home//operator/key.json'],
    ['a file with a space', 'file:///home/operator/my key.json'],
    ['a file with a query', 'file:///home/operator/key.json?x=1'],
    ['a bare path', '/home/operator/.slv/keys/test-1.json'],
    ['a relative path', '.slv/keys/test-1.json'],
    ['another scheme', 'https://example.com/key'],
    ['a scheme of 1Password with one slash', `op:/${VAULT}/${ITEM}/keypair`],
    ['stdin', '-'],
  ]
  for (const [name, value] of refused) {
    assertThrows(() => parse(value), IdentityRefError, undefined, name)
  }
})

Deno.test('no reference means the key file of the identity account on this machine, with one warning, and needs an identity account', () => {
  for (const absent of [undefined, '']) {
    const { ref, warnings } = parse(absent, IDENTITY)
    assertEquals(ref, {
      kind: 'file',
      path: `${HOME}/.slv/keys/${IDENTITY}.json`,
      legacy: true,
      text: `file://${HOME}/.slv/keys/${IDENTITY}.json`,
    })
    assertEquals(warnings.length, 1)
  }
  for (const identity of [undefined, '', 'not-base58-0OIl', '../../etc']) {
    assertThrows(() => parse(undefined, identity), IdentityRefError)
  }
})
