import { DEFAULT_COMMISSION_RATE } from '@cmn/constants/config.ts'
import { spawnSync } from '@elsoul/child-process'
import { colors } from '@cliffy/colors'

const createVoteAccount = async (
  identityAccount: string,
  voteAccount: string,
  authorityAccount: string,
  commissionRate: number = DEFAULT_COMMISSION_RATE,
  rpcUrl: string = 'https://api.testnet.solana.com',
) => {
  const cmd =
    `solana create-vote-account ~/.slv/keys/${voteAccount}.json ~/.slv/keys/${identityAccount}.json ${authorityAccount} --commission ${commissionRate} --url ${rpcUrl}`
  const result = await spawnSync(cmd)
  if (!result.success) {
    console.error(colors.red('❌ Failed to create vote account'))
    return false
  }
  console.log(colors.green('✔︎ Vote account created successfully'))
  return true
}

export { createVoteAccount }
