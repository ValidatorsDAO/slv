// The commands that slv runs on a node over ssh. Each is a fixed string made
// from constants: nothing that is typed, read from the inventory or resolved
// from a secret is ever put in one. A secret goes to a command on its stdin.

/**
 * Loads the profile of the user the way a login shell does, with its stdin,
 * stdout and stderr cut off so that nothing in it reads the input of the next
 * command or prints into its output; `exec` then gives the command that stdin.
 */
const PROFILE = '. ~/.profile </dev/null >/dev/null 2>&1;'

const LEDGER = '/mnt/ledger'
const UNSTAKED_IDENTITY = '/home/solv/unstaked-identity.json'

/** How set-identity treats the tower and the vote history file of the node. */
type SetIdentityFlag = 'none' | 'require-tower' | 'do-not-require-vote-history'

const FLAG_ARGUMENTS: Record<SetIdentityFlag, string> = {
  'none': '',
  'require-tower': ' --require-tower',
  'do-not-require-vote-history': ' --do-not-require-vote-history',
}

const remoteCommands = {
  /** Proves that a session can be opened and a command run: prints nothing. */
  alive: 'true',
  /** The identity the validator runs now, as JSON with an "id". */
  guardContactInfo:
    `${PROFILE} exec agave-validator -l ${LEDGER} contact-info --output json`,
  /** The public key of the unstaked identity file of the node. */
  unstakedPubkey: `${PROFILE} exec solana-keygen pubkey ${UNSTAKED_IDENTITY}`,
  /** Sets the identity to the key on stdin. */
  setIdentity: (flag: SetIdentityFlag): string =>
    `${PROFILE} exec agave-validator -l ${LEDGER} set-identity${
      FLAG_ARGUMENTS[flag]
    }`,
  /** Sets the identity back to the unstaked identity file of the node: no secret. */
  setUnstaked:
    `${PROFILE} exec agave-validator -l ${LEDGER} set-identity ${UNSTAKED_IDENTITY}`,
  /** Adds the key on stdin as an authorized voter. */
  authorizedVoterAdd:
    `${PROFILE} exec agave-validator -l ${LEDGER} authorized-voter add`,
} as const

type RemoteCommandName =
  | Exclude<keyof typeof remoteCommands, 'setIdentity'>
  | 'setIdentity'

const ID_IN_CONTACT_INFO = /"id"\s*:\s*"([1-9A-HJ-NP-Za-km-z]{32,44})"/

/** The identity in the output of `contact-info --output json`, or null. */
const parseContactInfoId = (output: string): string | null =>
  ID_IN_CONTACT_INFO.exec(output)?.[1] ?? null

/** What set-identity prints when it has set the identity. */
const setIdentityConfirmation = (pubkey: string): string =>
  `New validator identity: ${pubkey}`

export {
  parseContactInfoId,
  remoteCommands,
  setIdentityConfirmation,
  UNSTAKED_IDENTITY,
}
export type { RemoteCommandName, SetIdentityFlag }
