import { assertEquals } from '@std/assert'
import { listAllBackups } from '@/backup/listAllBackups.ts'
import type { UserApiAuth } from '/lib/userApi/auth.ts'
import type { storageList } from '/src/storage/api.ts'

Deno.test('listAllBackups collects every page and forwards the cursor', async () => {
  const auth: UserApiAuth = { kind: 'session', home: '/test-home' }
  const requests: Parameters<typeof storageList>[] = []
  const listPage: typeof storageList = (pageAuth, options) => {
    requests.push([pageAuth, options])
    const page = options?.cursor === 'next'
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

  const files = await listAllBackups(auth, {
    prefix: 'backups/backup-node-',
    region: 'asia',
  }, listPage)

  assertEquals(files.map((file) => file.path), [
    'backups/backup-node-20250101-000000.tar.zst',
    'backups/backup-node-20240101-000000.tar.zst',
  ])
  assertEquals(requests, [
    [auth, {
      prefix: 'backups/backup-node-',
      region: 'asia',
      cursor: undefined,
    }],
    [auth, {
      prefix: 'backups/backup-node-',
      region: 'asia',
      cursor: 'next',
    }],
  ])
})
