export type BackupFile = {
  path: string
  size: number
  lastModified: string
}

export type BackupListPage = {
  files: BackupFile[]
  cursor?: string
  truncated: boolean
}

export type BackupListFn = (
  apiKey: string,
  options: {
    prefix?: string
    region?: 'eu' | 'asia' | 'us-east' | 'us-west' | 'oc'
    cursor?: string
  },
) => Promise<BackupListPage>

export async function listAllBackups(
  apiKey: string,
  options: {
    prefix?: string
    region?: 'eu' | 'asia' | 'us-east' | 'us-west' | 'oc'
  },
  listPage: BackupListFn,
): Promise<BackupFile[]> {
  const files: BackupFile[] = []
  let cursor: string | undefined

  do {
    const page = await listPage(apiKey, {
      prefix: options.prefix ?? 'backups/',
      region: options.region,
      cursor,
    })
    files.push(...page.files)
    cursor = page.truncated ? page.cursor : undefined
  } while (cursor)

  return files
}
