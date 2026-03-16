import { Command } from '@cliffy'
import { migrateLinux } from '/lib/migrate/linuxMigrate.ts'

export const migrateLinuxCmd = new Command()
  .description('🖥️  Migrate entire Linux disk to a new server via rsync over SSH')
  .option('-t, --to <to:string>', 'SSH destination (e.g. root@new-server)', {
    required: true,
  })
  .option('-p, --port <port:number>', 'SSH port', { default: 22 })
  .option('--skip-reboot', 'Skip automatic reboot after migration')
  .option('-y, --yes', 'Skip confirmation prompt')
  .option(
    '--exclude <exclude:string>',
    'Additional rsync exclude pattern (can be repeated)',
    { collect: true },
  )
  .action(async (options) => {
    const success = await migrateLinux({
      to: options.to,
      port: options.port,
      skipReboot: options.skipReboot,
      yes: options.yes,
      extraExcludes: options.exclude ?? [],
    })
    if (!success) {
      Deno.exit(1)
    }
  })
