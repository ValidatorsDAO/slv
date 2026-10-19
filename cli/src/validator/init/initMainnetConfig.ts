import { prepareValidatorInitAccounts } from '/src/validator/init/accounts.ts'
import {
  assertNewValidatorHost,
  saveValidatorInitHost,
} from '/src/validator/init/inventory.ts'
import { genPasswordYml } from '/lib/genPasswordYml.ts'
import { genOrReadVersions } from '/lib/genOrReadVersions.ts'
import { colors } from '@cliffy/colors'
import { Input, prompt, Select } from '@cliffy/prompt'
import { getInventoryPath } from '@cmn/constants/path.ts'
import type { SSHConnection } from '@cmn/prompt/checkSSHConnection.ts'
import { genSolvUser } from '/src/validator/init/genSolvUser.ts'
import { optimizeNode } from '/lib/optimizeNode.ts'
import type { ValidatorMainnetConfig } from '@cmn/types/config.ts'
import { DEFAULT_RPC_ADDRESS, SolanaNodeTypes } from '@cmn/constants/config.ts'
import {
  buildMainnetHostEntry,
  DEFAULT_MAINNET_VALIDATOR_TYPE,
} from '/lib/addMainnetInventory.ts'
import {
  mainnetValidatorTypes,
  refuseMainnetValidatorType,
} from '/lib/fdctlMainnetGuard.ts'
import {
  findNearestJitoRegion,
  type RegionLatency,
} from '/lib/jito/findNearestRegion.ts'
import type { SolanaNodeType } from '@cmn/types/config.ts'
import { findNearestSnapshotUrl } from '/lib/snapshot/findNearestSnapshot.ts'
import { getAllRegions } from '/lib/jito/jitoRegions.ts'
import { promptXdpConfig } from '/src/validator/init/promptXdpConfig.ts'

const initMainnetConfig = async (
  sshConnection: SSHConnection,
  isLocalhost?: boolean,
) => {
  const {
    validatorType,
  } = await prompt([
    {
      name: 'validatorType',
      message: 'Select Validator Type',
      type: Select,
      options: mainnetValidatorTypes(SolanaNodeTypes),
      default: DEFAULT_MAINNET_VALIDATOR_TYPE,
    },
  ])
  if (!validatorType) {
    return
  }
  // Alpenglow: Firedancer and Frankendancer are not supported on mainnet during
  // the migration. Stop before a key is generated or an inventory is written.
  if (refuseMainnetValidatorType(validatorType)) {
    return
  }
  let commissionBps = '1000'
  if (validatorType.includes('jito')) {
    const cmsBps = await prompt([
      {
        name: 'commission_bps',
        message: 'Enter Commission BPS (Max 1000 = 10%)',
        type: Input,
        default: '1000',
      },
    ])
    commissionBps = String(cmsBps.commission_bps)
  }

  const rpcAccount = DEFAULT_RPC_ADDRESS
  const inventoryType = 'mainnet_validators'
  const { name } = await prompt([
    {
      name: 'name',
      message: 'Enter Inventory Name',
      type: Input,
      default: 'mainnet-validator',
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

  await assertNewValidatorHost('mainnet', name)

  let getNearRegion: RegionLatency | null = null
  let snapshotUrl = ''
  if (isLocalhost) {
    const regions = getAllRegions('mainnet')
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
    const network = 'mainnet'
    getNearRegion = await findNearestJitoRegion(
      host,
      network,
      {
        user,
        keyFile,
        port: 22,
      },
    ) as RegionLatency | null
    snapshotUrl = await findNearestSnapshotUrl(host, {
      user,
      keyFile,
      port: 22,
    })
  }

  if (!getNearRegion) {
    console.log(colors.red('❌ Failed to measure latencies. Please try again.'))
    return
  }
  const blockEngineRegion = getNearRegion.info.blockEngineUrl
  const shredstream_address = getNearRegion.info.shredReceiver
  const relayer_url = getNearRegion.info.relayerUrl
  // XDP retransmit acceleration (Agave/Jito/Allnodes-Jito)
  const xdpConfig = await promptXdpConfig(
    validatorType as SolanaNodeType,
    'mainnet',
  )
  const accounts = await prepareValidatorInitAccounts('mainnet', name)
  const identityAccount = accounts.identity_account
  const configMainnet: Partial<ValidatorMainnetConfig> = {
    name,
    ...accounts,
    validator_type: validatorType as SolanaNodeType,
    region: getNearRegion.region,
    commission_bps: Number(commissionBps),
    port_rpc: 7211,
    dynamic_port_range: '8900-8930',
    relayer_url,
    block_engine_url: blockEngineRegion,
    shred_receiver_address: String(shredstream_address),
    snapshot_url: snapshotUrl,
    staked_rpc_identity_account: rpcAccount,
    ...xdpConfig,
  }
  // await updateAllowedSshIps()
  // await updateAllowedIps()
  if (!await genPasswordYml()) return
  await genOrReadVersions()
  await saveValidatorInitHost('mainnet', name, {
    ...buildMainnetHostEntry(name, identityAccount, sshConnection, isLocalhost),
    ...configMainnet,
  })
  // Create solv User on Ubuntu Server
  if (!await genSolvUser(name, inventoryType)) {
    throw new Error(
      'Inventory and verified 1Password reference were saved, but server user setup failed. Do not deploy until setup succeeds; reuse this identity instead of generating another.',
    )
  }
  console.log(
    `✔︎ Validator Mainnet Config Saved To ${inventoryPath}`,
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

$ slv v deploy -n mainnet -p ${name}
`,
    ),
  )
}

export { initMainnetConfig }
