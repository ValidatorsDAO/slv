import { assertEquals } from '@std/assert'
import { listAllBackups } from '@/backup/listAllBackups.ts'

Deno.test('listAllBackups collects every page and forwards the cursor', async () => {
  const requests: Array<{
    apiKey: string
    prefix?: string
    region?: string
    cursor?: string
  }> = []
  const listPage = (
    apiKey: string,
    options: {
      prefix?: string
      region?: 'eu' | 'asia' | 'us-east' | 'us-west' | 'oc'
      cursor?: string
    },
  ) => {
    requests.push({ apiKey, ...options })
    const page = options.cursor === 'next'
      ? {
        files: [{
          path: 'backups/backup-node-20240101-000000.tar.zst',
          size: 2,
          lastModified: '2024-01-01T00:00:00.000Z',
        }],
        truncated: false,
      }
      : {
        files: [{
          path: 'backups/backup-node-20250101-000000.tar.zst',
          size: 1,
          lastModified: '2025-01-01T00:00:00.000Z',
        }],
        cursor: 'next',
        truncated: true,
      }

    return Promise.resolve(page)
  }

  const files = await listAllBackups('test-api-key', {
    prefix: 'backups/backup-node-',
    region: 'asia',
  }, listPage)

  assertEquals(files.map((file) => file.path), [
    'backups/backup-node-20250101-000000.tar.zst',
    'backups/backup-node-20240101-000000.tar.zst',
  ])
  assertEquals(requests, [
    {
      apiKey: 'test-api-key',
      prefix: 'backups/backup-node-',
      region: 'asia',
      cursor: undefined,
    },
    {
      apiKey: 'test-api-key',
      prefix: 'backups/backup-node-',
      region: 'asia',
      cursor: 'next',
    },
  ])
})
