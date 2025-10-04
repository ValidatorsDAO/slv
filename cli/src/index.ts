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
import { logoutCmd } from '@/login/logout.ts'
import { checkCmd } from '@/check/index.ts'
import { installClientMessage, slvAA } from '/lib/slvAA.ts'
import { upgrade } from '@/upgrade.ts'
import { signupCmd } from '/src/signup/index.ts'
import { serverCmd } from '/src/server/index.ts'
import { getCmd } from '/src/get/index.ts'
import {
  findNearestJitoRegion,
  displayLatencyResults,
  measureRegionLatencies,
} from '/lib/jito/findNearestRegion.ts'

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

// Test Command
program
  .command('test')
  .description('Test command for development')
  .action(async () => {
    console.log('Test command executed')

    // Configuration for SSH connection
    const serverIp = '82.27.98.6' // Example server IP
    const sshOptions = {
      user: 'solv',
      keyFile: '~/.ssh/id_rsa',
      port: 22,
    }

    console.log('\n=== Finding Nearest Jito Region ===')
    console.log(`Server IP: ${serverIp}`)
    
    // Test with only mainnet and limited regions for faster testing
    console.log('\n🌐 Testing Mainnet Regions (limited for demo):')
    
    // Just find the nearest region without duplicate measurement
    const nearestMainnet = await findNearestJitoRegion(
      serverIp,
      'mainnet',
      sshOptions
    )
    
    if (nearestMainnet) {
      console.log(`\n✨ Best Mainnet Region Found!`)
    } else {
      console.log(`\n❌ Could not find reachable mainnet region`)
    }
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

program
  .command('metal', metalCmd)
  .alias('m')

program
  .command('signup', signupCmd)

program
  .command('login', loginCmd)

program
  .command('logout', logoutCmd)

program
  .command('check', checkCmd)

program
  .command('get', getCmd)

program
  .command('server', serverCmd)
  .alias('s')
  .description('🔮 Open SLV UI')

await program.parse(Deno.args)
