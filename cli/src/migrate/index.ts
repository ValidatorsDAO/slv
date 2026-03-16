import { Command } from '@cliffy'
import { migrateLinuxCmd } from '@/migrate/linux.ts'

export const migrateCmd = new Command()
  .description('🚚 Server migration tools')
  .action(() => {
    migrateCmd.showHelp()
  })

migrateCmd.command('linux', migrateLinuxCmd)
