import { Command } from '@cliffy'

// rpc Command
export const rpcCmd = new Command()
  .description('Manage Solana RPC Nodes')

rpcCmd.command('init')
  .description('Initialize a new RPC node configuration')
  .action(() => {
    console.log('Initializing new RPC node...')
  })

rpcCmd.command('deploy')
  .description('Deploy a new RPC node')
  .action(() => {
    console.log('Deploying RPC node...')
  })
