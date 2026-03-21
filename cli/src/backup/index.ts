import { Command } from '@cliffy'
import { colors } from '@cliffy/colors'
import { backupAction } from '@/backup/backupAction.ts'
import { importAction } from '@/backup/importAction.ts'
import { listAction } from '@/backup/listAction.ts'

export const backupCmd = new Command()
  .description(colors.white('Backup and restore your node environment'))
  .action(function () {
    this.showHelp()
  })
  .command('create', 'Create a backup of the current node')
  .option('-o, --output <path:string>', 'Output file path')
  .option('--upload', 'Upload backup to cloud storage after creation')
  .option(
    '-r, --region <region:string>',
    'Storage region for upload (default: eu)',
  )
  .option(
    '--exclude <path:string>',
    'Additional paths to exclude (repeatable)',
    { collect: true },
  )
  .option(
    '--include <path:string>',
    'Remove path from default excludes (repeatable)',
    { collect: true },
  )
  .option('--list-excludes', 'Show current exclude list and exit')
  .option(
    '--retention <days:number>',
    'Delete remote backups older than N days (default: 7)',
    { default: 7 },
  )
  .option(
    '--cron <interval:string>',
    'Set up cron job (daily|weekly|monthly|off)',
  )
  .option(
    '--webhook <url:string>',
    'Discord webhook URL for notifications (overrides SLV_BACKUP_WEBHOOK)',
  )
  .option('--restic', 'Use restic for incremental backup (requires restic installed)')
  .option('-y, --yes', 'Skip confirmation prompts')
  .action(backupAction)
  .command('restore', 'Restore from a backup file or restic snapshot')
  .alias('import')
  .arguments('[file:string]')
  .option('-r, --region <region:string>', 'Storage region for download')
  .option('-y, --yes', 'Skip confirmation prompts')
  .action(importAction)
  .command('list', 'List available backups (cloud storage + restic snapshots)')
  .option('-r, --region <region:string>', 'Storage region')
  .option('--restic', 'Show restic snapshots only')
  .action(listAction)
