import { colors } from '@cliffy/colors'
import Kia from 'https://deno.land/x/kia@0.4.1/mod.ts'
import { getApiKeyFromYml } from '/lib/getApiKeyFromYml.ts'
import { storageList, type StorageRegion } from '/src/storage/api.ts'
import { formatBytes } from '/src/storage/upload/uploadAction.ts'
import { hasRestic, resticSnapshots } from '@/backup/restic.ts'

interface ResticSnapshot {
  id: string
  time: string
  hostname?: string
  tags?: string[]
  paths?: string[]
  short_id?: string
}

export const listAction = async (options: {
  region?: string
  restic?: boolean
}) => {
  const apiKey = await getApiKeyFromYml()

  // Show restic snapshots if available
  if (options.restic || await hasRestic()) {
    try {
      console.log(colors.bold(colors.blue('\n📸 Restic Snapshots\n')))
      const raw = await resticSnapshots(apiKey, options.region)
      const snapshots: ResticSnapshot[] = JSON.parse(raw)

      if (snapshots.length === 0) {
        console.log(colors.dim('  No restic snapshots found.\n'))
      } else {
        // Sort by time descending
        snapshots.sort(
          (a, b) => new Date(b.time).getTime() - new Date(a.time).getTime(),
        )

        for (const snap of snapshots) {
          const shortId = snap.short_id || snap.id.slice(0, 8)
          const time = new Date(snap.time).toISOString().replace('T', ' ').slice(0, 19)
          const tags = snap.tags?.join(', ') || ''
          console.log(
            colors.white(`  ${colors.green(shortId)}  ${time}  ${colors.dim(tags)}`),
          )
        }
        console.log()
      }
    } catch (error) {
      if (options.restic) {
        // Only show error if --restic was explicitly requested
        console.log(
          colors.yellow(
            `\n⚠️  Could not list restic snapshots: ${error instanceof Error ? error.message : String(error)}\n`,
          ),
        )
      }
    }

    if (options.restic) return // restic-only mode
  }

  // Show tar backups from cloud storage
  const spinner = new Kia(colors.cyan('Fetching backup list from cloud storage...'))
  spinner.start()

  try {
    const list = await storageList(apiKey, {
      prefix: 'backups/',
      region: options.region as StorageRegion,
    })
    spinner.stop()

    if (list.files.length === 0) {
      console.log(colors.dim('\n  No tar backups found in cloud storage.\n'))
      return
    }

    console.log(colors.bold(colors.blue('\n📦 Cloud Storage Backups\n')))

    const sorted = list.files.sort(
      (a, b) =>
        new Date(b.lastModified).getTime() -
        new Date(a.lastModified).getTime(),
    )

    for (const f of sorted) {
      const filename = f.path.split('/').pop() || f.path
      const time = new Date(f.lastModified).toISOString().replace('T', ' ').slice(0, 19)
      console.log(
        colors.white(
          `  ${colors.green(filename)}  ${formatBytes(f.size)}  ${colors.dim(time)}`,
        ),
      )
    }
    console.log()
  } catch (error) {
    spinner.fail('Failed to list backups')
    console.log(
      colors.red(
        `\n${error instanceof Error ? error.message : String(error)}\n`,
      ),
    )
  }
}
