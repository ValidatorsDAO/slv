import { Command } from '@cliffy'
import { colors } from '@cliffy/colors'
import { airdropAction } from '@/airdrop/airdropAction.ts'

export const airdropCmd = new Command()
  .description(colors.white('Request 1 Testnet SOL airdrop to your wallet'))
  .arguments('[walletAddress:string]')
  .action(async (_options: void, walletAddress?: string) => {
    await airdropAction(walletAddress)
  })
