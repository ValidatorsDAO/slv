import {
  anyTokenConfigured,
  type KeylessConfig,
  type KeylessNetwork,
  policyOf,
} from '/lib/secret/vaultPolicy.ts'

// Where a key may be read: only by a person at a terminal, on a machine that is
// not a node, and never on mainnet while a service account token is about.

type ContextDeps = {
  env: (name: string) => string | undefined
  envNames: () => string[]
  exists: (path: string) => Promise<boolean>
  /** True when /dev/tty can be opened. */
  canOpenTty: () => Promise<boolean>
}

const defaultContextDeps = (): ContextDeps => ({
  env: (name) => Deno.env.get(name),
  envNames: () => Object.keys(Deno.env.toObject()),
  exists: async (path) => {
    try {
      await Deno.stat(path)
      return true
    } catch (_error) {
      return false
    }
  },
  canOpenTty: async () => {
    try {
      const tty = await Deno.open('/dev/tty', { read: true, write: true })
      tty.close()
      return true
    } catch (_error) {
      return false
    }
  },
})

/** The marker that an operator puts on a machine where no key may be resolved. */
const NO_RESOLUTION_MARKER = '/etc/slv/no-op-resolution'
/** What shows that this machine is a node. */
const NODE_MARKERS = [
  '/home/solv/unstaked-identity.json',
  '/etc/systemd/system/solv.service',
]

const isTokenVariable = (name: string): boolean =>
  name === 'OP_SERVICE_ACCOUNT_TOKEN' || name.startsWith('OP_CONNECT_') ||
  name.startsWith('OP_SESSION_')

/**
 * Why a key may not be resolved here, or null when it may. Nothing is read or
 * spawned to find out.
 */
const checkSecretContext = async (
  network: KeylessNetwork,
  config: KeylessConfig,
  deps: ContextDeps = defaultContextDeps(),
): Promise<string | null> => {
  if (!(await deps.canOpenTty())) {
    return 'there is no terminal: this asks you on /dev/tty and does not run without one'
  }
  if (deps.env('SLV_EXECUTION_CONTEXT') === 'ai-console') {
    return 'this does not run from the AI console'
  }
  if (await deps.exists(NO_RESOLUTION_MARKER)) {
    return `${NO_RESOLUTION_MARKER} exists: no key is resolved on this machine`
  }
  for (const marker of NODE_MARKERS) {
    if (await deps.exists(marker)) {
      return `${marker} exists: this machine is a node, and a key is not resolved on a node`
    }
  }
  if (network === 'mainnet') {
    if (anyTokenConfigured(config)) {
      return 'mainnet is refused while a 1Password service account token is configured in keyless.yml'
    }
    if (deps.envNames().some(isTokenVariable)) {
      return 'mainnet is refused while a 1Password service account or Connect token is in the environment'
    }
  }
  // Without a service account, 1Password asks the person at the app, and that
  // has to be a person at this machine.
  if (policyOf(config, network).tokenFile === null) {
    if (deps.env('SSH_CONNECTION') || deps.env('SSH_TTY')) {
      return 'this does not run in a shell reached over ssh, unless a service account is configured for the network'
    }
    if (deps.env('OP_BIOMETRIC_UNLOCK_ENABLED') === 'false') {
      return 'OP_BIOMETRIC_UNLOCK_ENABLED is false, so 1Password cannot ask you'
    }
  }
  return null
}

export { checkSecretContext, defaultContextDeps, NO_RESOLUTION_MARKER }
export type { ContextDeps }
