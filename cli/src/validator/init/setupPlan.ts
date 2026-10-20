import { Confirm } from '@cliffy/prompt'
import type { SSHConnection } from '@cmn/prompt/checkSSHConnection.ts'
import type { SolanaNodeType } from '@cmn/types/config.ts'
import { inspectNode, recommendXdp } from '/src/validator/init/nodeFacts.ts'
import {
  promptXdpConfig,
  type XdpConfig,
} from '/src/validator/init/promptXdpConfig.ts'

export type InitConfigOptions = { advanced?: boolean; name?: string }

export async function defaultSshIdentity(
  home: string,
): Promise<string | undefined> {
  const exists = async (path: string) => {
    try {
      return (await Deno.stat(path)).isFile
    } catch {
      return false
    }
  }
  // OpenSSH does not load the adjacent private key when -i names a .pub
  // file. Preserve conventional file-key authentication when the pair exists.
  for (const name of ['id_ed25519', 'id_rsa']) {
    const path = `${home}/.ssh/${name}`
    if (await exists(path) && await exists(`${path}.pub`)) return path
  }
  for (const name of ['id_ed25519.pub', 'id_rsa.pub']) {
    const path = `${home}/.ssh/${name}`
    if (await exists(path)) return path
  }
  const publicKeys: string[] = []
  try {
    for await (const entry of Deno.readDir(`${home}/.ssh`)) {
      const path = `${home}/.ssh/${entry.name}`
      if (entry.name.endsWith('.pub') && await exists(path)) {
        publicKeys.push(path)
      }
    }
  } catch { /* no SSH directory yet */ }
  if (publicKeys.length === 1) {
    const publicKey = publicKeys[0]
    const privateKey = publicKey.slice(0, -4)
    return await exists(privateKey) ? privateKey : publicKey
  }
  return undefined
}

export async function confirmInitPlan(
  connection: SSHConnection,
  network: 'mainnet' | 'testnet',
  name: string,
  validatorType: SolanaNodeType,
  region: string,
  options: InitConfigOptions = {},
  localhost = false,
): Promise<XdpConfig | null> {
  console.log('\nInspecting the server network, kernel and CPU topology...')
  const facts = await inspectNode(connection, localhost)
  const recommendation = recommendXdp(facts)
  const config = options.advanced
    ? await promptXdpConfig(validatorType, network, recommendation.config)
    : recommendation.config
  console.log([
    '\nValidator setup',
    `  Server: ${connection.username}@${connection.ip}`,
    ...(localhost ? [] : [`  SSH identity: ${connection.rsa_key_path}`]),
    `  Network: ${network}; client: ${validatorType}; name: ${name}`,
    `  Region: ${region}`,
    `  XDP: ${config.xdp_enabled ? 'enabled' : 'disabled'}${
      options.advanced ? '' : ` — ${recommendation.reason}`
    }`,
    options.advanced
      ? '  Identity: choose or create in 1Password; voting disabled'
      : '  Identity: create and verify in 1Password; voting disabled',
    ...(options.advanced
      ? []
      : ['  Kernel/reboot tuning: deferred; available with --advanced']),
    ...(facts?.validatorRunning
      ? [
        '  An existing validator is running. Deployment needs runtime verification before it is considered complete.',
      ]
      : []),
  ].join('\n'))
  return await Confirm.prompt({
      message: 'Create this configuration and set up the server user?',
      default: true,
    })
    ? config
    : null
}
