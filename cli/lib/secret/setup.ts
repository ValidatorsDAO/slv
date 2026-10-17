import {
  checkSecretContext,
  type ContextDeps,
  defaultContextDeps,
} from '/lib/secret/context.ts'
import {
  defaultOpSpawn,
  findExecutable,
  type OpSpawn,
} from '/lib/secret/opCli.ts'
import type { ResolveDeps } from '/lib/secret/resolveIdentity.ts'
import {
  defaultPolicyDeps,
  type KeylessConfig,
  type KeylessNetwork,
  type NetworkPolicy,
  type PolicyDeps,
  PolicyError,
  policyOf,
  readKeylessConfig,
  readServiceAccountToken,
} from '/lib/secret/vaultPolicy.ts'

// What every verb that reads or makes a key does first, in this order and
// before it asks or reads anything: read keyless.yml, check where it is being
// run, read the service account token of the network, and find op.

/** A refusal with a reason that is safe to print: it never holds a key or a token. */
class SecretRefusal extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SecretRefusal'
  }
}

type SecretSetupDeps = {
  readConfig: () => Promise<KeylessConfig>
  context: ContextDeps
  policy: Pick<PolicyDeps, 'readText' | 'lstat' | 'uid'>
  op: OpSpawn
  findOp: () => Promise<string | null>
  parentEnv: (name: string) => string | undefined
  readFile: (path: string) => Promise<Uint8Array>
}

type SecretSetup = {
  network: KeylessNetwork
  config: KeylessConfig
  policy: NetworkPolicy
  /** The service account token of the network, or null. */
  token: string | null
  resolve: ResolveDeps
}

const defaultSecretSetupDeps = (): SecretSetupDeps => ({
  readConfig: () => readKeylessConfig(),
  context: defaultContextDeps(),
  policy: defaultPolicyDeps(),
  op: defaultOpSpawn,
  findOp: () => findExecutable('op', Deno.env.get('PATH')),
  parentEnv: (name) => Deno.env.get(name),
  readFile: (path) => Deno.readFile(path),
})

type SecretSetupOptions = {
  /** When the network has a service account in keyless.yml: refuse with this message, before the token file is read. */
  refuseServiceAccount?: string
}

const prepareSecretSetup = async (
  network: KeylessNetwork,
  deps: SecretSetupDeps,
  options: SecretSetupOptions = {},
): Promise<SecretSetup> => {
  let config: KeylessConfig
  try {
    config = await deps.readConfig()
  } catch (error) {
    if (error instanceof PolicyError) throw new SecretRefusal(error.message)
    throw error
  }
  const reason = await checkSecretContext(network, config, deps.context)
  if (reason !== null) throw new SecretRefusal(reason)
  const policy = policyOf(config, network)
  if (options.refuseServiceAccount !== undefined && policy.tokenFile !== null) {
    throw new SecretRefusal(options.refuseServiceAccount)
  }
  let token: string | null = null
  if (policy.tokenFile !== null) {
    try {
      token = await readServiceAccountToken(policy.tokenFile, deps.policy)
    } catch (error) {
      if (error instanceof PolicyError) throw new SecretRefusal(error.message)
      throw error
    }
  }
  const opPath = await deps.findOp()
  if (opPath === null) {
    throw new SecretRefusal(
      'op (the 1Password CLI) is not in an absolute directory of PATH',
    )
  }
  return {
    network,
    config,
    policy,
    token,
    resolve: {
      op: deps.op,
      opPath,
      parentEnv: deps.parentEnv,
      token,
      readFile: deps.readFile,
    },
  }
}

export { defaultSecretSetupDeps, prepareSecretSetup, SecretRefusal }
export type { SecretSetup, SecretSetupDeps, SecretSetupOptions }
