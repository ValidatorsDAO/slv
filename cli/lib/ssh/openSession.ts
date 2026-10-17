import { findExecutable } from '/lib/secret/opCli.ts'
import {
  defaultSshSpawn,
  openSshSession,
  SshRefusal,
  type SshSession,
} from '/lib/ssh/hardenedSsh.ts'
import { PINS_PATH } from '/lib/ssh/knownHosts.ts'
import type { SshTarget } from '/lib/ssh/sshTarget.ts'

/** A session of the hardened ssh to a host, with the ssh of the PATH and the pins of ~/.slv/known_hosts. */
const defaultOpenSession = async (
  target: SshTarget,
  network: string,
): Promise<SshSession> => {
  const sshPath = await findExecutable('ssh', Deno.env.get('PATH'))
  if (sshPath === null) {
    throw new SshRefusal('ssh is not in an absolute directory of PATH')
  }
  return await openSshSession(target, network, {
    spawn: defaultSshSpawn,
    sshPath,
    knownHostsPath: PINS_PATH,
    parentEnv: (name) => Deno.env.get(name),
  })
}

export { defaultOpenSession }
