import { Command } from '@cliffy'
import { colors } from '@cliffy/colors'
import { ApiYmlUnreadableError } from '/lib/userApi/session.ts'
import denoJson from '/deno.json' with { type: 'json' }
import { botCmd } from '@/bot/index.ts'
import { skillsCmd } from '@/skills/index.ts'
import { appCmd } from '@/app/index.ts'
import { validatorCmd } from '@/validator/index.ts'
import { rpcCmd } from '@/rpc/index.ts'
import { hermesCmd } from '@/hermes/index.ts'
import { pythnetCmd } from '@/pythnet/index.ts'
import { metalCmd } from '@/metal/index.ts'
import { loginCmd } from '@/login/index.ts'
import { logoutCmd } from '@/login/logout.ts'
import { checkCmd } from '@/check/index.ts'
import { installClientMessage, slvAA } from '/lib/slvAA.ts'
import { upgrade } from '@/upgrade.ts'
import { signupCmd } from '/src/signup/index.ts'
import { copyTemplateDirs } from '/src/rpc/init.ts'
import { migrateVersionsYml } from '/lib/migrate/migrateVersionsYml.ts'
import { noticeBelowFloorPins } from '/lib/versionFloor.ts'
import { installCmd } from '/src/install/index.ts'
import { migrateCmd } from '@/migrate/index.ts'
import { storageCmd } from '@/storage/index.ts'
import { backupCmd } from '@/backup/index.ts'
import { aiCmd, onboardCmd } from '@/ai/index.ts'
import { authCmd } from '@/auth/index.ts'
import { disableCmd } from '@/disable/index.ts'
import { addSshCmd } from '@/addSsh/index.ts'
import { gatewayCmd } from '@/gateway/index.ts'
import { dnsCmd } from '@/dns/index.ts'
import { doctorCmd } from '@/doctor/index.ts'
import { printEmbeddedLicenses } from '/lib/release/licenses.ts'

const program = new Command()
  .name('slv')
  .description('slv is a Toolkit for Solana Developers')
  .version(denoJson.version)
  .option('-P,--print', 'Print slv ASCII Art').action(() => {
    slvAA(denoJson.version)
    installClientMessage()
  })

program
  .command('upgrade')
  .description('Upgrade slv to the latest version')
  .action(async () => {
    await upgrade()
  })

program
  .command('licenses')
  .description('Print the third-party notices embedded in this executable')
  .action(async () => {
    await printEmbeddedLicenses()
  })

program
  .command('upgrade:settings')
  .description('Upgrade Default Settings Files')
  .action(async () => {
    const migrated = await migrateVersionsYml()
    if (!migrated) {
      throw new Error(
        'Failed to migrate versions.yml; settings templates were not updated',
      )
    }
    await copyTemplateDirs()
    // The pins in versions.yml are kept; say which ones Alpenglow cannot run on.
    await noticeBelowFloorPins()
  })

// Subcommands
program
  .command('bot', botCmd)
  .alias('b')

program
  .command('skills', skillsCmd)

program
  .command('app', appCmd)

program
  .command('validator', validatorCmd)
  .alias('v')

program
  .command('rpc', rpcCmd)
  .alias('r')

program
  .command('hermes', hermesCmd)
  .alias('h')

program
  .command('pythnet', pythnetCmd)

program
  .command('install', installCmd)
  .alias('i')

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
  .command('storage', storageCmd)
  .alias('st')

program
  .command('backup', backupCmd)

program
  .command('migrate', migrateCmd)

program
  .command('check', checkCmd)

program
  .command('doctor', doctorCmd)

program
  .command('ai', aiCmd)
  .alias('c')

program
  .command('onboard', onboardCmd)

program
  .command('auth', authCmd)

program
  .command('disable', disableCmd)

program
  .command('add:ssh', addSshCmd)

program
  .command('gateway', gatewayCmd)
  .command('dns', dnsCmd)

try {
  await program.parse(Deno.args)
} catch (error) {
  // A command that could not read ~/.slv/api.yml left it unchanged.
  if (error instanceof ApiYmlUnreadableError) {
    console.error(colors.red(`❌ ${error.message}`))
    Deno.exit(1)
  }
  throw error
}
