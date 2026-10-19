import { prepareValidatorInitAccounts } from '/src/validator/init/accounts.ts'
import {
  assertNewValidatorHost,
  saveValidatorInitHost,
} from '/src/validator/init/inventory.ts'
import { genPasswordYml } from '/lib/genPasswordYml.ts'
import { genOrReadVersions } from '/lib/genOrReadVersions.ts'
import type {
  InventoryType,
  SolanaNodeType,
  ValidatorTestnetConfig,
} from '@cmn/types/config.ts'
import type { SSHConnection } from '@cmn/prompt/checkSSHConnection.ts'
import { getInventoryPath } from '@cmn/constants/path.ts'
import { colors } from '@cliffy/colors'
import { genSolvUser } from '/src/validator/init/genSolvUser.ts'
import { optimizeNode } from '/lib/optimizeNode.ts'
import { Input, prompt, Select } from '@cliffy/prompt'
import { SolanaNodeTypes } from '@cmn/constants/config.ts'
import { findNearestJitoRegion } from '/lib/jito/findNearestRegion.ts'
import type { RegionLatency } from '/lib/jito/findNearestRegion.ts'
import { getAllRegions } from '/lib/jito/jitoRegions.ts'
import { promptXdpConfig } from '/src/validator/init/promptXdpConfig.ts'

const initTestnetConfig = async (
  sshConnection: SSHConnection,
  isLocalhost?: boolean,
) => {
  const { validatorType } = await prompt([
    {
      name: 'validatorType',
      message: 'Select Validator Type',
      type: Select,
      options: SolanaNodeTypes.filter((type) =>
        ['agave', 'jito', 'allnodes-jito'].includes(type)
      ),
      default: 'agave',
    },
  ])
  if (!validatorType) {
    return
  }
  if (!['agave', 'jito', 'allnodes-jito'].includes(validatorType)) {
    throw new Error(
      'Sync-only 1Password setup supports Agave, Jito and Allnodes-Jito. Firedancer requires a separate reviewed setup.',
    )
  }
  const inventoryType = 'testnet_validators' as InventoryType
  const { name } = await prompt([
    {
      name: 'name',
      message: 'Enter Inventory Name',
      type: Input,
      default: 'testnet-validator',
      validate: (value: string) =>
        /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value) ||
        'Use letters, digits, dots, underscores or hyphens',
    },
  ])
  if (!name) {
    console.log(colors.red('⚠️ Inventory Name is required'))
    return
  }
  const inventoryPath = getInventoryPath(inventoryType)

  await assertNewValidatorHost('testnet', name)

  let getNearRegion: RegionLatency | null = null
  if (isLocalhost) {
    const regions = getAllRegions('testnet')
    const regionKeys = regions
      .filter(([key]) => key !== 'global')
      .map(([key, r]) => ({ name: `${r.emoji} ${r.name}`, value: key }))
    const selectedRegion = await Select.prompt<string>({
      message: 'Select your region',
      options: regionKeys,
    })
    const regionInfo = regions.find(([k]) => k === selectedRegion)
    if (regionInfo) {
      getNearRegion = {
        region: selectedRegion,
        info: regionInfo[1],
        latency: 0,
        host: 'localhost',
      }
    }
  } else {
    const host = sshConnection.ip
    const user = sshConnection.username
    const keyFile = sshConnection.rsa_key_path
    const network = 'testnet'
    getNearRegion = await findNearestJitoRegion(
      host,
      network,
      {
        user,
        keyFile,
        port: 22,
      },
    ) as RegionLatency | null
  }

  if (!getNearRegion) {
    console.log(colors.red('❌ Failed to measure latencies. Please try again.'))
    return
  }
  // XDP retransmit acceleration (Agave/Jito/Allnodes-Jito)
  // Validate XDP before the inventory is persisted; testnet zero-copy must
  // fail closed before addInventory writes any state.
  const xdpConfig = await promptXdpConfig(
    validatorType as SolanaNodeType,
    'testnet',
  )
  const accounts = await prepareValidatorInitAccounts('testnet', name)
  const configTestnet: Partial<ValidatorTestnetConfig> & {
    username: string
    ip: string
  } = {
    name,
    ...accounts,
    ansible_host: sshConnection.ip,
    ansible_user: sshConnection.username,
    ansible_ssh_private_key_file: sshConnection.rsa_key_path,
    username: 'solv',
    ip: sshConnection.ip,
    ...(isLocalhost ? { ansible_connection: 'local' as const } : {}),
    validator_type: validatorType as SolanaNodeType,
    region: getNearRegion.region,
    commission_bps: 1000,
    relayer_url: getNearRegion.info.relayerUrl,
    block_engine_url: getNearRegion.info.blockEngineUrl,
    shred_receiver_address: String(getNearRegion.info.shredReceiver),
    snapshot_url: '',
    port_rpc: 7211,
    dynamic_port_range: '8900-8930',
    ...xdpConfig,
  }
  if (!await genPasswordYml()) return
  await genOrReadVersions()
  await saveValidatorInitHost('testnet', name, configTestnet)
  // Create solv User on Ubuntu Server
  if (!await genSolvUser(name, inventoryType)) {
    throw new Error(
      'Inventory and verified 1Password reference were saved, but server user setup failed. Do not deploy until setup succeeds; reuse this identity instead of generating another.',
    )
  }
  console.log(
    `✔︎ Validator testnet config saved to ${inventoryPath}`,
  )

  // Pre-deploy node optimization: SMT off + IRQ tune + CPU boost + kernel update
  if (!isLocalhost) {
    await optimizeNode({ inventoryType, pubkey: name })
  } else {
    console.log(
      colors.yellow(
        '⏭  Localhost mode — skipping node optimization (run `cmn/optimize_node.yml` manually if needed).',
      ),
    )
  }

  console.log(
    colors.white(
      `Sync-only configuration saved. The identity is verified in 1Password.
Deploy will start the server's unstaked identity, not the identity stored in 1Password.
No vote account was created and voting is disabled. Normal identity promotion, switching and BLS signing are not enabled by this setup.

Deploy the unstaked node with:

$ slv v deploy -n testnet -p ${name}
`,
    ),
  )
  return configTestnet
}

export { initTestnetConfig }
