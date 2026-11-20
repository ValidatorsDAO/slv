import type { UserApiAuth } from '/lib/userApi/auth.ts'
import type {
  StorageFile,
  storageList,
  StorageRegion,
} from '/src/storage/api.ts'

export async function listAllBackups(
  auth: UserApiAuth,
  options: {
    prefix?: string
    region?: StorageRegion
  },
  listPage: typeof storageList,
): Promise<StorageFile[]> {
  const files: StorageFile[] = []
  let cursor: string | undefined

  do {
    const page = await listPage(auth, {
      prefix: options.prefix ?? 'backups/',
      region: options.region,
      cursor,
    })
    files.push(...page.files)
    cursor = page.truncated ? page.cursor : undefined
  } while (cursor)

  return files
}
