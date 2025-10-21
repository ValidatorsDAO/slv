import { Command } from '@cliffy'
import { init } from '@/rpc/init.ts'
import { colors } from '@cliffy/colors'
import { updateAllowedIps } from '/lib/config/updateAllowedIps.ts'
import { listRPCs } from '@/rpc/listRPCs.ts'
import { deployRPCMainnet } from '/src/rpc/deploy/deployRPCMainnet.ts'
import { updateDefaultVersion } from '/lib/config/updateDefaultVersion.ts'
import type { InventoryType, NetworkType } from '@cmn/types/config.ts'
import { getTemplatePath } from '/lib/getTemplatePath.ts'
import { runAnsilbe } from '/lib/runAnsible.ts'
import { deployRPCTestnet } from '/src/rpc/deploy/deployRPCTestnet.ts'
import { deployRPCDevnet } from '/src/rpc/deploy/deployRPCDevnet.ts'

// rpc Command
export const rpcCmd = new Command()
  .description('🛠️ Manage Solana RPC Nodes 🛠️')
  .action(() => {
    rpcCmd.showHelp()
  })

rpcCmd.command('init')
  .description('🚀 Initialize a new RPC node configuration')
  .action(async () => {
    await init()
  })

rpcCmd.command('deploy')
  .description('📦 Deploy RPC Nodes')
  .option(
    '-n, --network <network>',
    'Network to deploy RPC node on (mainnet/devnet/testnet)',
    {
      default: 'mainnet',
    },
  )
  .option('-p, --pubkey <pubkey>', 'Deploy RPC node for a specific pubkey')
  .action(async (options) => {
    const network = options.network || 'mainnet'
    switch (network) {
      case 'mainnet':
        await deployRPCMainnet(options.pubkey)
        break
      case 'devnet':
        await deployRPCDevnet(options.pubkey)
        break
      case 'testnet':
        await deployRPCTestnet(options.pubkey)
        break
      default:
        console.log(
          colors.red('❌ Invalid network. Use mainnet, devnet, or testnet.'),
        )
        return
    }
    return
  })

rpcCmd.command('list')
  .description('📋 List RPC Nodes')
  .option(
    '-n, --network <network:string>',
    'Network type (mainnet/devnet/testnet)',
    {
      default: 'mainnet',
    },
  )
  .option('-i, --identity <identity:string>', 'Filter by identity key')
  .action(async (options) => {
    await listRPCs(options.network as NetworkType, options.identity)
  })

rpcCmd.command('setup:firedancer')
  .description('🔥 Setup/Update Firedancer Validator')
  .option('-n, --network <network>', 'Solana Network', {
    default: 'testnet',
  })
  .option('-p, --pubkey <pubkey>', 'Public Key of Validator.')
  .action(async (options) => {
    const inventoryType = options.network + '_rpcs' as InventoryType
    const templateRoot = getTemplatePath()
    const playbook =
      `${templateRoot}/ansible/${options.network}/setup_firedancer.yml`

    const result = options.pubkey
      ? await runAnsilbe(playbook, inventoryType, options.pubkey)
      : await runAnsilbe(playbook, inventoryType)
    if (result) {
      console.log(colors.white('✅ Successfully Setup Firedancer Validator'))
      return
    }
  })

rpcCmd.command('update:version')
  .description('⬆️ Update RPC Version')
  .option('-c, --config-only', 'Update only the config file', {
    default: false,
  })
  .option('-p, --pubkey <pubkey>', 'Name of RPC')
  .option('-n, --network <network>', 'Network to deploy validators', {
    default: 'mainnet',
  })
  .action(async (options) => {
    if (options.configOnly) {
      await updateDefaultVersion()
      return
    }
    const inventoryType = options.network + '_rpcs' as InventoryType
    const templateRoot = getTemplatePath()

    const playbook =
      `${templateRoot}/ansible/${options.network}-rpc/install_solana.yml`
    if (options.pubkey) {
      await runAnsilbe(playbook, inventoryType, options.pubkey)
      return
    }
    await runAnsilbe(playbook, inventoryType)
    return
  })

rpcCmd.command('update:script')
  .description('⚙️ Update RPC Startup Config')
  .option('-p, --pubkey <pubkey>', 'Name of RPC')
  .option('-n, --network <network>', 'Network to deploy validators', {
    default: 'mainnet',
  })
  .action(async (options) => {
    const inventoryType = options.network + '_rpcs' as InventoryType
    const templateRoot = getTemplatePath()
    const playbook =
      `${templateRoot}/ansible/${options.network}-rpc/update_startup_config.yml`
    if (options.pubkey) {
      await runAnsilbe(playbook, inventoryType, options.pubkey)
      return
    }
    await runAnsilbe(playbook, inventoryType, options.pubkey)
  })

rpcCmd.command('update:geyser')
  .description('⚡️ Update Geyser Version')
  .option('-p, --pubkey <pubkey>', 'Name of RPC')
  .option('-n, --network <network>', 'Network to deploy validators', {
    default: 'mainnet',
  })
  .action(async (options) => {
    const inventoryType = options.network + '_rpcs' as InventoryType
    const templateRoot = getTemplatePath()
    const playbook =
      `${templateRoot}/ansible/${options.network}-rpc/update_geyser.yml`
    if (options.pubkey) {
      await runAnsilbe(playbook, inventoryType, options.pubkey)
      return
    }
    await runAnsilbe(playbook, inventoryType, options.pubkey)
  })

rpcCmd.command('start')
  .description('🟢 Start RPC')
  .option('-n, --network <network>', 'Solana Network', {
    default: 'mainnet',
  })
  .option('-p, --pubkey <pubkey>', 'Name of RPC')
  .action(async (options) => {
    const inventoryType = options.network + '_rpcs' as InventoryType
    const networkPath = options.network + '-rpc'
    const templateRoot = getTemplatePath()
    const playbook = `${templateRoot}/ansible/${networkPath}/start_node.yml`
    const result = options.pubkey
      ? await runAnsilbe(playbook, inventoryType, options.pubkey)
      : await runAnsilbe(playbook, inventoryType)
    if (result) {
      console.log(colors.white('✅ Successfully Started RPC'))
      return
    }
  })

rpcCmd.command('stop')
  .description('🔴 Stop RPC')
  .option('-n, --network <network>', 'Solana Network', {
    default: 'mainnet',
  })
  .option('-p, --pubkey <pubkey>', 'Name of RPC')
  .action(async (options) => {
    const inventoryType = options.network + '_rpcs' as InventoryType
    const networkPath = options.network + '-rpc'
    const templateRoot = getTemplatePath()
    const playbook = `${templateRoot}/ansible/${networkPath}/stop_node.yml`
    const result = options.pubkey
      ? await runAnsilbe(playbook, inventoryType, options.pubkey)
      : await runAnsilbe(playbook, inventoryType)
    if (result) {
      console.log(colors.white('✅ Successfully Stopped RPC'))
      return
    }
  })

rpcCmd.command('restart')
  .description('♻️ Restart RPC')
  .option('-n, --network <network>', 'Solana Network', {
    default: 'mainnet',
  })
  .option('-p, --pubkey <pubkey>', 'Name of RPC')
  .action(async (options) => {
    const inventoryType = options.network + '_rpcs' as InventoryType
    const networkPath = options.network + '-rpc'
    const templateRoot = getTemplatePath()
    const playbook = `${templateRoot}/ansible/${networkPath}/restart_node.yml`
    const result = options.pubkey
      ? await runAnsilbe(playbook, inventoryType, options.pubkey)
      : await runAnsilbe(playbook, inventoryType)
    if (result) {
      console.log(colors.white('✅ Successfully Restarted RPC'))
      return
    }
  })

rpcCmd.command('cleanup')
  .description(
    '🧹 Cleanup RPC - Remove Ledger/Snapshot Unnecessary Files',
  )
  .option('-n, --network <network>', 'Solana Network', {
    default: 'mainnet',
  })
  .option('-p, --pubkey <pubkey>', 'Name of RPC')
  .action(async (options) => {
    const inventoryType = options.network + '_rpcs' as InventoryType
    const templateRoot = getTemplatePath()
    const playbook = `${templateRoot}/ansible/cmn/rm_ledger.yml`
    const result = options.pubkey
      ? await runAnsilbe(playbook, inventoryType, options.pubkey)
      : await runAnsilbe(playbook, inventoryType)
    if (result) {
      console.log(colors.white('✅ Successfully Cleaned Up RPC'))
      return
    }
  })

rpcCmd.command('get:snapshot')
  .description('🔥 Download Snapshot with aria2c')
  .option('-n, --network <network>', 'Solana Network', {
    default: 'mainnet',
  })
  .option('-p, --pubkey <pubkey>', 'Name of RPC')
  .action(async (options) => {
    const inventoryType = options.network + '_rpcs' as InventoryType
    const networkPath = options.network + '-rpc'
    const templateRoot = getTemplatePath()
    const playbook = `${templateRoot}/ansible/${networkPath}/wget_snapshot.yml`
    const result = options.pubkey
      ? await runAnsilbe(playbook, inventoryType, options.pubkey)
      : await runAnsilbe(playbook, inventoryType)
    if (result) {
      console.log(colors.white('✅ Successfully Downloaded Snapshot'))
      return
    }
  })

rpcCmd.command('update:allowed-ips')
  .option('-n, --network <network>', 'Solana Network', {
    default: 'mainnet',
  })
  .description('🛡️ Update allowed IPs for mainnet RPC nodes')
  .action(async (options) => {
    const inventoryType = options.network + '_rpcs' as InventoryType
    await updateAllowedIps(inventoryType)
  })
