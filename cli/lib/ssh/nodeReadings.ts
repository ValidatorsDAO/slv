import { BASE58_PUBKEY } from '/lib/secret/base58.ts'
import type { SshSession } from '/lib/ssh/hardenedSsh.ts'
import { parseContactInfoId } from '/lib/ssh/remoteCommands.ts'

// What slv reads from a node over a session of the hardened ssh: the identity
// its validator runs now, and the public key of its unstaked identity file.

type Reading = { id: string | null; note: string }

const withStderr = (what: string, stderrLine: string): string =>
  stderrLine === '' ? what : `${what}: ${stderrLine}`

const describe = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

/** The identity that the validator of the node runs now. */
const readRunningId = async (session: SshSession): Promise<Reading> => {
  try {
    const result = await session.run('guardContactInfo')
    if (result.outcome !== 'ok') {
      return {
        id: null,
        note: withStderr(`contact-info ${result.outcome}`, result.stderrLine),
      }
    }
    const id = parseContactInfoId(result.stdout)
    return id === null
      ? { id: null, note: 'contact-info did not show an identity' }
      : { id, note: '' }
  } catch (error) {
    return { id: null, note: describe(error) }
  }
}

/** The public key of the unstaked identity file of the node, or null. */
const readUnstakedPubkey = async (
  session: SshSession,
): Promise<string | null> => {
  try {
    const result = await session.run('unstakedPubkey')
    if (result.outcome !== 'ok') return null
    const text = result.stdout.trim()
    return BASE58_PUBKEY.test(text) ? text : null
  } catch (_error) {
    return null
  }
}

export { readRunningId, readUnstakedPubkey, withStderr }
export type { Reading }
