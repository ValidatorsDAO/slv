import { Command } from '@cliffy'
import { colors } from '@cliffy/colors'
import { migrateLinux } from '/lib/migrate/linuxMigrate.ts'

export const migrateLinuxCmd = new Command()
  .description('🖥️  Migrate entire Linux disk to a new server via rsync over SSH')
  .option('-t, --to <to:string>', 'SSH destination (e.g. root@new-server)')
  .option('-p, --port <port:number>', 'SSH port', { default: 22 })
  .option('--skip-reboot', 'Skip automatic reboot after migration')
  .option('-y, --yes', 'Skip confirmation prompt')
  .option(
    '--exclude <exclude:string>',
    'Additional rsync exclude pattern (can be repeated)',
    { collect: true },
  )
  .option(
    '--include <include:string>',
    'Remove path from default excludes (can be repeated)',
    { collect: true },
  )
  .option('--list-excludes', 'Show current exclude list and exit')
  .action(async (options) => {
    if (!options.listExcludes && !options.to) {
      console.error(colors.red('Error: --to is required for migration. Use --list-excludes to view excludes.'))
      Deno.exit(1)
    }
    const success = await migrateLinux({
      to: options.to ?? '',
      port: options.port,
      skipReboot: options.skipReboot,
      yes: options.yes,
      extraExcludes: options.exclude ?? [],
      extraIncludes: options.include ?? [],
      listExcludes: options.listExcludes,
    })
    if (!success) {
      Deno.exit(1)
    }
  })
