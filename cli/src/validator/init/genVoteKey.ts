import { Confirm, Input, prompt } from '@cliffy/prompt'
import { exec, spawnSync } from '@elsoul/child-process'
import { colors } from '@cliffy/colors'
import { join } from '@std/path'
import { configRoot } from '@cmn/constants/path.ts'
import { createVoteAccount } from '/src/validator/init/createVoteAccount.ts'

const genVoteKey = async (identityAccount: string): Promise<{
  voteAccount: string
  authAccount: string
}> => {
  const { isNewVoteAccount } = await prompt([{
    name: 'isNewVoteAccount',
    message: 'Do you want to create a new vote account key now?',
    type: Confirm,
    default: true,
  }])

  let voteAccount = ''

  if (isNewVoteAccount) {
    console.log(colors.white('🔑 Generating new vote account key...'))
    const command = `solana-keygen grind --ends-with SLV:1`
    const process = await exec(command)
    if (!process.success) {
      console.error(colors.red('❌ Failed to generate vote account key'))
      throw new Error('Failed to generate vote account key')
    }
    const output = process.message
    const match = output.match(/Wrote keypair to (\S+)\.json/)

    if (match && match[1]) {
      const keyValue = match[1]
      voteAccount = keyValue
      console.log('✨ Generated Key:', keyValue)
      const dest = join(configRoot, 'keys', `${keyValue}.json`)
      await Deno.rename(`${keyValue}.json`, dest)
      console.log('✨ Moved Key to:', dest)
    } else {
      console.error('❌ Failed to parse key value from output')
    }
  } else {
    const res = await prompt([{
      name: 'voteAccount',
      message: 'Please Enter Your Vote Account Public Key',
      type: Input,
    }])

    console.log(colors.yellow(`⚠️ Please place your voteAccount pubkey in 
        
  ~/.slv/keys/${res.voteAccount}.json`))
    voteAccount = res.voteAccount || ''
  }
  const authAccount = `authAccount`

  if (isNewVoteAccount) {
    // Airdrop to the Identity Account
    const home = Deno.env.get('HOME')
    const result = await spawnSync(
      `solana airdrop 1 --url https://api.testnet.solana.com --keypair ${home}/.slv/keys/${identityAccount}.json`,
    )
    if (!result.success) {
      // Get 1 SOL to Validators DAO's Discord Channel if airdrop fails
      const msg = `Failed to airdrop to identity account: ${identityAccount}
Add Some SOL to Your Identity Account: ${identityAccount}

And Then, Create a Vote Account with the command:

${colors.white('$ slv v gen:vote-account')}

If you don't have SOL, ask for it in the Validators DAO's Discord Channel: https://discord.gg/VX38HynP7Y`
      console.log(colors.yellow(msg))
      return { voteAccount, authAccount }
    }
    await createVoteAccount(identityAccount, voteAccount, authAccount)
  }

  return { voteAccount, authAccount }
}

export { genVoteKey }
