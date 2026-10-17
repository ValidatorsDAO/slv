import { assertEquals } from '@std/assert'
import {
  parseContactInfoId,
  remoteCommands,
  setIdentityConfirmation,
  UNSTAKED_IDENTITY,
} from '/lib/ssh/remoteCommands.ts'

const PROFILE = '. ~/.profile </dev/null >/dev/null 2>&1;'

Deno.test('the commands that run on a node are these strings and no others, one for each way of calling set-identity', () => {
  assertEquals(UNSTAKED_IDENTITY, '/home/solv/unstaked-identity.json')
  assertEquals(remoteCommands.alive, 'true')
  assertEquals(
    remoteCommands.guardContactInfo,
    `${PROFILE} exec agave-validator -l /mnt/ledger contact-info --output json`,
  )
  assertEquals(
    remoteCommands.unstakedPubkey,
    `${PROFILE} exec solana-keygen pubkey /home/solv/unstaked-identity.json`,
  )
  assertEquals(
    remoteCommands.setUnstaked,
    `${PROFILE} exec agave-validator -l /mnt/ledger set-identity /home/solv/unstaked-identity.json`,
  )
  assertEquals(
    remoteCommands.authorizedVoterAdd,
    `${PROFILE} exec agave-validator -l /mnt/ledger authorized-voter add`,
  )
  assertEquals(
    remoteCommands.setIdentity('none'),
    `${PROFILE} exec agave-validator -l /mnt/ledger set-identity`,
  )
  assertEquals(
    remoteCommands.setIdentity('require-tower'),
    `${PROFILE} exec agave-validator -l /mnt/ledger set-identity --require-tower`,
  )
  assertEquals(
    remoteCommands.setIdentity('do-not-require-vote-history'),
    `${PROFILE} exec agave-validator -l /mnt/ledger set-identity --do-not-require-vote-history`,
  )
})

Deno.test('none of the commands has a place for a name, an address, a path or a key: they hold no quote, template or substitution', () => {
  const all = [
    remoteCommands.alive,
    remoteCommands.guardContactInfo,
    remoteCommands.unstakedPubkey,
    remoteCommands.setUnstaked,
    remoteCommands.authorizedVoterAdd,
    remoteCommands.setIdentity('none'),
    remoteCommands.setIdentity('require-tower'),
    remoteCommands.setIdentity('do-not-require-vote-history'),
  ]
  for (const command of all) {
    assertEquals(/['"`$\\{}]|&&|\|\||;;/.test(command), false, command)
  }
})

Deno.test('the identity in the output of contact-info is read, and anything that does not hold one gives null', () => {
  const pubkey = '586Z7H2vpX9qNhN2T4e9Utugie3ogjbxzGaMtM3E6HR5'
  assertEquals(
    parseContactInfoId(`{"id": "${pubkey}", "gossip": "127.0.0.1:8001"}`),
    pubkey,
  )
  assertEquals(parseContactInfoId(`{\n  "id" : "${pubkey}"\n}`), pubkey)
  for (
    const output of [
      '',
      '{}',
      '{"id": ""}',
      '{"id": "short"}',
      '{"id": "0OIl0OIl0OIl0OIl0OIl0OIl0OIl0OIl0OIl"}',
      'Identity: 586Z7H2vpX9qNhN2T4e9Utugie3ogjbxzGaMtM3E6HR5',
    ]
  ) {
    assertEquals(parseContactInfoId(output), null, output)
  }
  assertEquals(
    setIdentityConfirmation(pubkey),
    `New validator identity: ${pubkey}`,
  )
})
