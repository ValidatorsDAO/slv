// Import-map substitutes for the init boundary tests. No subprocess, credential
// provider, network or operator inventory is used by these implementations.
export const calls: string[] = []
let passwordSaved = false
export const reset = (saved: boolean) => {
  calls.length = 0
  passwordSaved = saved
}
export const genPasswordYml = () => {
  calls.push('password')
  return Promise.resolve(passwordSaved)
}
export const genOrReadVersions = () => {
  calls.push('versions')
  return Promise.resolve()
}
export const assertNewValidatorHost = (..._args: unknown[]) => Promise.resolve()
export const saveValidatorInitHost = (..._args: unknown[]) => {
  calls.push('save')
  return Promise.resolve()
}
export const genSolvUser = (..._args: unknown[]) => {
  calls.push('server-user')
  return Promise.resolve(true)
}
export const optimizeNode = (..._args: unknown[]) => {
  calls.push('optimize')
  return Promise.resolve()
}
export const prepareValidatorInitAccounts = (..._args: unknown[]) => {
  calls.push('accounts')
  return Promise.resolve({
    identity_account: 'fixture-public-identity',
    identity_ref:
      'op://abcdefghijklmnopqrstuvwxyz/abcdefghijklmnopqrstuvwxyz/keypair',
    vote_account: '',
    authority_account: '',
    no_voting: true,
  })
}
export const Input = {}
export const Select = {
  prompt: <T>(..._args: unknown[]): Promise<T> =>
    Promise.resolve('fixture' as T),
}
export const prompt = (..._args: unknown[]) =>
  Promise.resolve({
    validatorType: 'agave',
    name: 'fixture-validator',
    commission_bps: '1000',
  })
const color = (text: string) => text
export const colors = { red: color, yellow: color, white: color }
export const getInventoryPath = (..._args: unknown[]) =>
  '/tmp/unused-inventory.yml'
export const SolanaNodeTypes = ['agave', 'jito', 'allnodes-jito'] as const
export const DEFAULT_RPC_ADDRESS = 'fixture-public-rpc'
export const DEFAULT_MAINNET_VALIDATOR_TYPE = 'agave'
export const mainnetValidatorTypes = (types: readonly string[]) => [...types]
export const refuseMainnetValidatorType = (..._args: unknown[]) => false
export const buildMainnetHostEntry = (..._args: unknown[]) => ({})
export type SSHConnection = {
  ip: string
  username: string
  rsa_key_path: string
}
const region = {
  emoji: '',
  name: 'Fixture',
  blockEngineUrl: 'https://example.invalid',
  shredReceiver: 'example.invalid',
  relayerUrl: 'https://example.invalid',
}
export type RegionLatency = {
  region: string
  info: typeof region
  latency: number
  host: string
}
export const getAllRegions = (
  ..._args: unknown[]
): [string, typeof region][] => [
  ['fixture', region],
]
export const findNearestJitoRegion = (
  ..._args: unknown[]
): Promise<RegionLatency> =>
  Promise.resolve({
    region: 'fixture',
    info: region,
    latency: 0,
    host: 'localhost',
  })
export const findNearestSnapshotUrl = (..._args: unknown[]) =>
  Promise.resolve('')
export const promptXdpConfig = (..._args: unknown[]) => Promise.resolve({})

export type InitConfigOptions = { advanced?: boolean; name?: string }
export const confirmInitPlan = (..._args: unknown[]) => Promise.resolve({})
