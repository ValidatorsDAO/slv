import { Command } from '@cliffy'
import denoJson from '/deno.json' with { type: 'json' }
import { botCmd } from '@/bot/index.ts'
import { appCmd } from '@/app/index.ts'
import { validatorCmd } from '@/validator/index.ts'
import { rpcCmd } from '@/rpc/index.ts'
import { cloudCmd } from '@/cloud/index.ts'
import { swapCmd } from '@/swap/index.ts'
import { metalCmd } from '@/metal/index.ts'
import { loginCmd } from '@/login/index.ts'
import { checkCmd } from '@/check/index.ts'
import { installClientMessage, slvAA } from '/lib/slvAA.ts'
import { upgrade } from '@/upgrade.ts'
import { signupCmd } from '/src/signup/index.ts'

const program = new Command()
  .name('slv')
  .description('slv is a Toolkit for Solana Developers')
  .version(denoJson.version)
  .option('-P,--print', 'Print slv ASCII Art').action(() => {
    slvAA()
    installClientMessage(denoJson.version)
  })

program
  .command('upgrade')
  .description('Upgrade slv to the latest version')
  .action(async () => {
    await upgrade()
  })

// Subcommands
program
  .command('bot', botCmd)
  .alias('b')

program
  .command('app', appCmd)

program
  .command('validator', validatorCmd)
  .alias('v')

program
  .command('rpc', rpcCmd)
  .alias('r')

program
  .command('cloud', cloudCmd)
  .alias('c')

program
  .command('swap', swapCmd)
  .alias('s')

program
  .command('metal', metalCmd)
  .alias('m')

program
  .command('signup', signupCmd)

program
  .command('login', loginCmd)

program
  .command('check', checkCmd)

await program.parse(Deno.args)
