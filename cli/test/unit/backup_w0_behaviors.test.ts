// slv overhaul W0: backup, restore and migrate. Deno.Command and fetch are
// replaced; the argument lists the code builds are asserted.

import {
  assert,
  assertEquals,
  assertFalse,
  assertMatch,
  assertStringIncludes,
} from '@std/assert'

import { backupAction } from '@/backup/backupAction.ts'
import * as cron from '@/backup/cron.ts'
import { backupCmd } from '@/backup/index.ts'
import * as excludesModule from '@/backup/excludes.ts'
import { buildExcludeList } from '@/backup/excludes.ts'
import { importAction } from '@/backup/importAction.ts'
import { resticBackup, resticSnapshots } from '@/backup/restic.ts'
import { migrateLinuxCmd } from '@/migrate/linux.ts'
import { migrateLinux } from '/lib/migrate/linuxMigrate.ts'

import {
  FAR_FUTURE,
  json,
  loggedIn,
  runCaptured,
  STORAGE_KEY_ID,
  STORAGE_SECRET,
  withFetch,
  withHome,
} from '/test/unit/_credentialFixtures.ts'

// ---------------------------------------------------------------------------
// The contract
// ---------------------------------------------------------------------------

/** Key material and credentials: in no archive, snapshot, copy or restore. */
const KEY_MATERIAL = [
  '/root/.slv/keys',
  '/home/*/.slv/keys',
  '/root/*keypair*.json',
  '/home/*/*keypair*.json',
  '/root/*identity*.json',
  '/home/*/*identity*.json',
  '/root/.slv/api.yml',
  '/home/*/.slv/api.yml',
  '/root/.slv/gateway/gateway.json',
  '/home/*/.slv/gateway/gateway.json',
  '/root/.slv/backup.env',
  '/home/*/.slv/backup.env',
  '/root/.slv/restic-password',
  '/home/*/.slv/restic-password',
  '/root/.ssh/id_*',
  '/home/*/.ssh/id_*',
  '/etc/ssh/ssh_host_*_key',
  '/etc/shadow',
  '/etc/gshadow',
  '/etc/wireguard',
  '/etc/doublezero/keys',
  '/etc/ssl/private',
  '/etc/nginx/ssl',
]

/** Files tied to one machine: a restore leaves them alone unless asked. */
const SYSTEM_IDENTITY = [
  '/etc/fstab',
  '/boot',
  '/etc/netplan',
  '/etc/machine-id',
  '/etc/ssh/ssh_host_*',
]

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** backupAction with loosely typed options and its lookups; no search of the real file system unless a test asks. */
const noFiles = { findFiles: (): string[] => [] }
const backup = (
  options: Record<string, unknown>,
  deps: {
    findFiles?: (patterns: readonly string[]) => string[] | Promise<string[]>
  } = noFiles,
): Promise<void> =>
  (backupAction as unknown as (
    options: Record<string, unknown>,
    deps: unknown,
  ) => Promise<void>)(options, deps)

/** buildExcludeList with the options this change adds (tool, resticIncludesWallets). */
const buildList = buildExcludeList as unknown as (
  options: Record<string, unknown>,
) => string[]

/** The exports this change adds to excludes.ts, reached through a loose type. */
const {
  WALLET_EXCLUDES,
  RESTIC_INCLUDES_WALLETS,
  secretExcludes,
  findExistingPaths,
} = excludesModule as unknown as {
  WALLET_EXCLUDES?: readonly string[]
  RESTIC_INCLUDES_WALLETS?: boolean
  secretExcludes?: (tool?: string, resticIncludesWallets?: boolean) => string[]
  findExistingPaths?: (
    patterns: readonly string[],
    options?: { root?: string },
  ) => Promise<string[]>
}

/** importAction with loosely typed options (otherHost and includeSystem are new). */
const restore = importAction as unknown as (
  options: Record<string, unknown>,
  file?: string,
) => Promise<void>

type Call = {
  command: string
  args: string[]
  env: Record<string, string>
  /** What was written to the process's stdin (crontab content). */
  input: string
}
type Reply = {
  success?: boolean
  code?: number
  stdout?: string
  stderr?: string
}

/**
 * Replace Deno.Command so no process starts. `handler` sees each call (it runs
 * synchronously, so it can look at the file system as the process would find
 * it) and answers it.
 */
const withProcesses = async (
  handler: (call: Call) => Reply | void,
  fn: (calls: Call[]) => Promise<void>,
): Promise<void> => {
  const original = Deno.Command
  const calls: Call[] = []
  const answer = (call: Call) => {
    calls.push(call)
    const r = handler(call) ?? {}
    const success = r.success ?? true
    return {
      success,
      code: r.code ?? (success ? 0 : 1),
      stdout: new TextEncoder().encode(r.stdout ?? ''),
      stderr: new TextEncoder().encode(r.stderr ?? ''),
    }
  }
  class FakeCommand {
    #call: Call
    constructor(command: string | URL, options?: Deno.CommandOptions) {
      this.#call = {
        command: String(command),
        args: [...(options?.args ?? [])],
        env: { ...(options?.env ?? {}) },
        input: '',
      }
    }
    output() {
      return Promise.resolve(answer(this.#call))
    }
    outputSync() {
      return answer(this.#call)
    }
    spawn() {
      const call = this.#call
      return {
        stdin: {
          getWriter: () => ({
            write: (bytes: Uint8Array) => {
              call.input += new TextDecoder().decode(bytes)
              return Promise.resolve()
            },
            close: () => Promise.resolve(),
          }),
        },
        output: () => Promise.resolve(answer(call)),
      }
    }
  }
  ;(Deno as unknown as { Command: unknown }).Command = FakeCommand
  try {
    await fn(calls)
  } finally {
    ;(Deno as unknown as { Command: unknown }).Command = original
  }
}

/**
 * A terminal that answers a prompt with Enter once and then ends. A prompt that
 * should never be reached then still cannot hang or spin the test run.
 */
const withEnterOnly = async (fn: () => Promise<void>): Promise<void> => {
  const stdin = Deno.stdin as unknown as {
    read: (buffer: Uint8Array) => Promise<number | null>
    isTerminal: () => boolean
  }
  const original = { read: stdin.read, isTerminal: stdin.isTerminal }
  let entered = false
  stdin.isTerminal = () => false
  stdin.read = (buffer: Uint8Array) => {
    if (entered) return Promise.resolve(null)
    entered = true
    buffer[0] = 13
    return Promise.resolve(1)
  }
  try {
    await fn()
  } finally {
    stdin.read = original.read
    stdin.isTerminal = original.isTerminal
  }
}

const withUid = async (uid: number, fn: () => Promise<void>): Promise<void> => {
  const original = Deno.uid
  ;(Deno as unknown as { uid: () => number }).uid = () => uid
  try {
    await fn()
  } finally {
    ;(Deno as unknown as { uid: unknown }).uid = original
  }
}

const withEnv = async (
  vars: Record<string, string | undefined>,
  fn: () => void | Promise<void>,
): Promise<void> => {
  const previous: Record<string, string | undefined> = {}
  for (const [name, value] of Object.entries(vars)) {
    previous[name] = Deno.env.get(name)
    if (value === undefined) Deno.env.delete(name)
    else Deno.env.set(name, value)
  }
  try {
    await fn()
  } finally {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) Deno.env.delete(name)
      else Deno.env.set(name, value)
    }
  }
}

/** The environment a backup runs in unless a test says otherwise. */
const cleanBackupEnv = {
  SLV_BACKUP_WEBHOOK: undefined,
  SLV_BACKUP_EXCLUDES: undefined,
}

/** Answers `hostname`; every other process succeeds without output. */
const asHost = (host: string) => (call: Call): Reply | void => {
  if (call.command === 'hostname') return { stdout: `${host}\n` }
}

/** Every value that follows a `--exclude` in an argument list. */
const excludesIn = (args: string[]): string[] =>
  args.flatMap((arg, i) => arg === '--exclude' ? [args[i + 1]] : [])

const exists = (path: string): boolean => {
  try {
    Deno.statSync(path)
    return true
  } catch {
    return false
  }
}

const missing = (have: string[], want: readonly string[]): string[] =>
  want.filter((entry) => !have.includes(entry))

/** The call that writes the local tar archive. */
const archiveCall = (calls: Call[]): Call | undefined =>
  calls.find((c) => c.args.includes('-cf'))

/** The three spellings a tar restore excludes for one absolute path. */
const memberNames = (path: string): string[] => {
  const relative = path.replace(/^\/+/, '')
  return [relative, `./${relative}`, `/${relative}`]
}

const WEBHOOK = 'https://hooks.example.invalid/backup'

// ---------------------------------------------------------------------------
// 1. Key material is excluded from tar, restic and rsync
// ---------------------------------------------------------------------------

Deno.test('k1: buildExcludeList always carries the key-material entries, whatever --include and SLV_BACKUP_EXCLUDES say', async () => {
  for (const includeSSH of [true, false]) {
    const plain = buildExcludeList({ includeSSH })
    assertEquals(missing(plain, KEY_MATERIAL), [], `includeSSH=${includeSSH}`)

    await withEnv({ SLV_BACKUP_EXCLUDES: '/srv/cache/*, /etc/shadow' }, () => {
      const withEnvList = buildExcludeList({
        includeSSH,
        extraExcludes: ['/srv/extra'],
        // --include lifts a default exclude, and names every key-material entry too
        extraIncludes: ['/var/log/*', '/etc/shadow', ...KEY_MATERIAL],
      })
      assertEquals(missing(withEnvList, KEY_MATERIAL), [], 'with env + include')
      assert(withEnvList.includes('/srv/cache/*'))
      assert(withEnvList.includes('/srv/extra'))
      assertFalse(
        withEnvList.includes('/var/log/*'),
        '--include still lifts a default exclude',
      )
    })
  }
  // the password-hash backup copies go with the hashes themselves
  assert(buildExcludeList({}).includes('/etc/shadow-'))
  assert(buildExcludeList({}).includes('/etc/gshadow-'))
})

Deno.test('k2: the tar archive command excludes every key-material and wallet entry, with or without --include and SLV_BACKUP_EXCLUDES', async () => {
  const cases: [
    string,
    Record<string, string | undefined>,
    { include?: string[]; exclude?: string[] },
  ][] = [
    ['defaults', cleanBackupEnv, {}],
    [
      'include + env',
      { ...cleanBackupEnv, SLV_BACKUP_EXCLUDES: '/srv/cache/*,/etc/shadow' },
      {
        include: [
          '/var/log/*',
          ...KEY_MATERIAL,
          ...(WALLET_EXCLUDES ?? []),
        ],
        exclude: ['/srv/extra'],
      },
    ],
  ]
  for (const [name, env, options] of cases) {
    await withEnv(env, async () => {
      await withHome(null, async (home) => {
        const output = `${home}/out.tar.zst`
        await withProcesses((call) => {
          if (call.args.includes('-cf')) {
            Deno.writeFileSync(output, new Uint8Array(8))
          }
          return asHost('node-1')(call)
        }, async (calls) => {
          await withUid(0, async () => {
            const outcome = await runCaptured(() =>
              backup({ yes: true, output, ...options })
            )
            assertEquals(outcome.error, undefined, `${name}: ${outcome.output}`)
            assertEquals(outcome.exit, null, `${name}: ${outcome.output}`)
          })
          const tar = archiveCall(calls)
          assert(tar, `${name}: no tar call`)
          const excludes = excludesIn(tar.args)
          assertEquals(missing(excludes, KEY_MATERIAL), [], name)
          // a tar archive never carries a wallet, whatever --include says
          assert(WALLET_EXCLUDES, 'excludes.ts does not export WALLET_EXCLUDES')
          assertEquals(
            missing(excludes, WALLET_EXCLUDES),
            [],
            `${name}: wallets`,
          )
          if (options.include) {
            assertFalse(
              excludes.includes('/var/log/*'),
              `${name}: --include did not lift /var/log/*`,
            )
            assert(
              excludes.includes('/srv/cache/*') &&
                excludes.includes('/srv/extra'),
              name,
            )
          }
        })
      })
    })
  }
})

Deno.test('k3: the restic backup excludes every key-material entry, keeps wallets, and keeps the per-tool credential excludes', async () => {
  await withEnv(
    { ...cleanBackupEnv, SLV_BACKUP_EXCLUDES: '/srv/cache/*' },
    async () => {
      await withHome({
        slv: {
          ...loggedIn(FAR_FUTURE),
          storage_access_key_id: STORAGE_KEY_ID,
          storage_secret: STORAGE_SECRET,
        },
      }, async (home) => {
        await Deno.writeTextFile(
          `${home}/.slv/restic-password`,
          'test-password\n',
        )
        await withProcesses(asHost('node-1'), async (calls) => {
          await withFetch(() => json({}, 500), async () => {
            const outcome = await runCaptured(() =>
              backup({
                restic: true,
                yes: true,
                region: 'eu',
                include: [...KEY_MATERIAL],
                exclude: ['/srv/extra'],
              })
            )
            assertEquals(outcome.error, undefined, outcome.output)
            assertEquals(outcome.exit, null, outcome.output)
          })
          const backupCall = calls.find((c) =>
            c.command === 'restic' && c.args[0] === 'backup'
          )
          assert(backupCall, 'restic backup was not started')
          const excludes = excludesIn(backupCall.args)
          assertEquals(missing(excludes, KEY_MATERIAL), [])
          // wallets stay in a restic backup
          assert(WALLET_EXCLUDES, 'excludes.ts does not export WALLET_EXCLUDES')
          assertEquals(
            WALLET_EXCLUDES.filter((pattern) => excludes.includes(pattern)),
            [],
            'wallet patterns in the restic list',
          )
          assert(
            excludes.includes('/srv/cache/*') &&
              excludes.includes('/srv/extra'),
          )
          for (const own of ['restic-password', 'api.yml', 'backup.env']) {
            assert(
              excludes.includes(`${home}/.slv/${own}`),
              `${own} of this home`,
            )
          }
        })
      })
    },
  )
})

Deno.test('k4: the migrate rsync excludes every key-material and wallet entry, --include or not', async () => {
  const remote = (command: string): Reply | void => {
    if (command === 'echo ok') return { stdout: 'ok\n' }
    if (command.startsWith('ls -1 /home')) return { stdout: '' }
    if (command.includes('/proc/uptime')) return { stdout: '60\n' }
    if (command.includes('df --output=avail')) {
      return { stdout: '999999999999\n' }
    }
  }
  const cases: [string, string[]][] = [['defaults', []], [
    'include names key material and wallets',
    [...KEY_MATERIAL, ...(WALLET_EXCLUDES ?? [])],
  ]]
  for (const [name, extraIncludes] of cases) {
    await withEnv(cleanBackupEnv, async () => {
      await withProcesses((call) => {
        if (call.command === 'ssh') {
          return remote(call.args[call.args.length - 1])
        }
        if (call.command === 'df') return { stdout: 'Used\n1000\n' }
      }, async (calls) => {
        await withUid(0, async () => {
          const outcome = await runCaptured(() =>
            migrateLinux({
              to: 'root@new-server',
              yes: true,
              skipReboot: true,
              extraExcludes: ['/srv/extra'],
              extraIncludes,
            })
          )
          assertEquals(outcome.error, undefined, `${name}: ${outcome.output}`)
        })
        const rsync = calls.find((c) => c.args.includes('-aHAXSx'))
        assert(rsync, `${name}: rsync was not started`)
        const excludes = excludesIn(rsync.args)
        assertEquals(missing(excludes, KEY_MATERIAL), [], name)
        // a migrate copy never carries a wallet either
        assert(WALLET_EXCLUDES, 'excludes.ts does not export WALLET_EXCLUDES')
        assertEquals(missing(excludes, WALLET_EXCLUDES), [], `${name}: wallets`)
        assert(excludes.includes('/srv/extra'), name)
        // migrate still keeps the destination's own SSH access
        assert(
          excludes.includes('/etc/ssh/ssh_host_*') &&
            excludes.includes('/etc/ssh/sshd_config'),
          name,
        )
      })
    })
  }
})

// ---------------------------------------------------------------------------
// 2. Plain tar archives are never uploaded or scheduled
// ---------------------------------------------------------------------------

Deno.test('p1: backup create --upload without --restic refuses before any archive is created and points to --restic; with --restic it is the encrypted backup', async () => {
  await withEnv(cleanBackupEnv, async () => {
    await withHome({ slv: loggedIn(FAR_FUTURE) }, async (home) => {
      const output = `${home}/out.tar.zst`
      await withProcesses(asHost('node-1'), async (calls) => {
        await withFetch(
          (url) =>
            url === WEBHOOK
              ? new Response(null, { status: 204 })
              : json({}, 500),
          async (requests) => {
            await withUid(0, async () => {
              const refused = await runCaptured(() =>
                backup({
                  upload: true,
                  yes: true,
                  region: 'eu',
                  output,
                  webhook: WEBHOOK,
                })
              )
              assertEquals(refused.error, undefined, refused.output)
              assertEquals(refused.exit, 1, refused.output)
              assertStringIncludes(refused.output, '--restic')
              // nothing was archived, uploaded or asked of the storage API
              assertEquals(
                archiveCall(calls),
                undefined,
                'a tar archive was started',
              )
              assertFalse(exists(output), 'an archive file exists')
              assertEquals(requests.filter((r) => r.url !== WEBHOOK).length, 0)
              // an older cron entry has nobody watching: the webhook hears about it, once
              const posts = requests.filter((r) => r.url === WEBHOOK)
              assertEquals(posts.length, 1, 'webhook posts')
              assertStringIncludes(posts[0].body ?? '', '--restic')
            })
          },
        )
      })
    })
    // --upload next to --restic asks for the encrypted backup: it is not refused
    await withHome({
      slv: {
        ...loggedIn(FAR_FUTURE),
        storage_access_key_id: STORAGE_KEY_ID,
        storage_secret: STORAGE_SECRET,
      },
    }, async (home) => {
      await Deno.writeTextFile(
        `${home}/.slv/restic-password`,
        'test-password\n',
      )
      await withProcesses(asHost('node-1'), async (calls) => {
        await withFetch(() => json({}, 500), async () => {
          const outcome = await runCaptured(() =>
            backup({ upload: true, restic: true, yes: true })
          )
          assertEquals(outcome.exit, null, outcome.output)
        })
        assert(
          calls.some((c) => c.command === 'restic' && c.args[0] === 'backup'),
        )
        assertEquals(archiveCall(calls), undefined)
      })
    })
  })
})

Deno.test('p2: --cron without --restic refuses and writes no crontab; --cron off still removes the schedule', async () => {
  await withEnv(cleanBackupEnv, async () => {
    for (const interval of ['daily', 'weekly', 'monthly']) {
      await withHome(null, async () => {
        await withProcesses(asHost('node-1'), async (calls) => {
          await withUid(0, () =>
            withEnterOnly(async () => {
              const refused = await runCaptured(() =>
                backup({ cron: interval, yes: true })
              )
              assertEquals(
                refused.error,
                undefined,
                `${interval}: ${refused.output}`,
              )
              assertEquals(refused.exit, 1, `${interval}: ${refused.output}`)
              assertStringIncludes(refused.output, '--restic')
            }))
          assertEquals(
            calls.filter((c) => c.command === 'crontab').length,
            0,
            `${interval}: crontab was touched`,
          )
          assertEquals(archiveCall(calls), undefined)
        })
      })
    }
    // --cron off schedules nothing, so it is not refused (it removes an older schedule)
    await withHome(null, async () => {
      await withProcesses((call) => {
        if (call.command === 'crontab' && call.args[0] === '-l') {
          return {
            stdout:
              '0 3 * * * /usr/local/bin/slv backup create --upload --yes\n',
          }
        }
      }, async (calls) => {
        const off = await runCaptured(() => backup({ cron: 'off', yes: true }))
        assertEquals(off.error, undefined, off.output)
        assertEquals(off.exit, null, off.output)
        assert(
          calls.some((c) => c.command === 'crontab'),
          'the crontab was not read',
        )
        // nothing is written back with an upload entry
        assertFalse(calls.some((c) => c.input.includes('--upload')))
      })
    })
  })
})

// ---------------------------------------------------------------------------
// 3. The local archive is private to its owner
// ---------------------------------------------------------------------------

Deno.test('a1: the tar invocation runs under umask 077, so a new archive has mode 0600 (zstd and gzip, with and without sudo)', async () => {
  for (const uid of [0, 1000]) {
    for (const zstd of [true, false]) {
      await withEnv(cleanBackupEnv, async () => {
        await withHome(null, async (home) => {
          const output = `${home}/out.tar.${zstd ? 'zst' : 'gz'}`
          await withProcesses((call) => {
            if (call.command === 'which' && call.args[0] === 'zstd') {
              return { success: zstd }
            }
            if (call.args.includes('-cf')) {
              Deno.writeFileSync(output, new Uint8Array(8))
            }
            return asHost('node-1')(call)
          }, async (calls) => {
            await withUid(uid, async () => {
              const outcome = await runCaptured(() =>
                backup({ yes: true, output })
              )
              assertEquals(outcome.exit, null, outcome.output)
            })
            const tar = archiveCall(calls)
            assert(tar, 'no tar call')
            // [sudo] sh -c 'umask 077 && exec tar "$@"' tar <tar arguments...>
            const argv = tar.command === 'sudo'
              ? tar.args
              : [tar.command, ...tar.args]
            assertEquals(
              tar.command === 'sudo',
              uid !== 0,
              'sudo only for a non-root user',
            )
            assertEquals(argv.slice(0, 2), ['sh', '-c'])
            assertEquals(argv[2], 'umask 077 && exec tar "$@"')
            assertEquals(argv[3], 'tar')
            assert(argv.includes(zstd ? '-I' : '--gzip'))
            assertEquals(argv[argv.indexOf('-cf') + 1], output)
          })
        })
      })
    }
  }
})

Deno.test('a2: an archive file already at the output path is brought to 0600 before tar writes into it', async () => {
  for (const before of [0o644, 0o666, 0o640, 0o600]) {
    await withEnv(cleanBackupEnv, async () => {
      await withHome(null, async (home) => {
        const output = `${home}/out.tar.zst`
        await Deno.writeFile(output, new Uint8Array([1, 2, 3]))
        await Deno.chmod(output, before)
        let modeWhenTarRuns: number | undefined
        await withProcesses((call) => {
          if (call.args.includes('-cf')) {
            modeWhenTarRuns = Deno.statSync(output).mode! & 0o777
          }
          return asHost('node-1')(call)
        }, async () => {
          await withUid(0, async () => {
            const outcome = await runCaptured(() =>
              backup({ yes: true, output })
            )
            assertEquals(outcome.exit, null, outcome.output)
          })
        })
        assertEquals(modeWhenTarRuns, 0o600, `was ${before.toString(8)}`)
      })
    })
  }
})

// ---------------------------------------------------------------------------
// 4. A restore does not write another host's archive or system identity files
// ---------------------------------------------------------------------------

/** A tar archive file named the way `slv backup create` names it. */
const writeArchive = async (
  dir: string,
  host: string,
  ext = 'tar.gz',
): Promise<string> => {
  const path = `${dir}/backup-${host}-20260101-000000.${ext}`
  await Deno.writeFile(path, new Uint8Array([1, 2, 3]))
  return path
}

const tarExtractCall = (calls: Call[]): Call | undefined =>
  calls.find((c) => c.command === 'tar' && c.args.includes('-xf'))

Deno.test('r1: restore refuses an archive taken on another host, or without a host in its name, unless --other-host is given', async () => {
  await withEnv(cleanBackupEnv, async () => {
    await withHome(null, async (home) => {
      const foreign = await writeArchive(home, 'node-2')
      const own = await writeArchive(home, 'node-1')
      const upper = await writeArchive(home, 'NODE-1', 'tar.zst')
      await withProcesses(asHost('node-1'), async (calls) => {
        await withUid(0, async () => {
          const refused = await runCaptured(() =>
            restore({ yes: true }, foreign)
          )
          assertEquals(refused.error, undefined, refused.output)
          assertEquals(refused.exit, 1, refused.output)
          assertStringIncludes(refused.output, '--other-host')
          assertStringIncludes(refused.output, 'node-2')
          assertEquals(
            tarExtractCall(calls),
            undefined,
            'tar ran for a refused archive',
          )

          // the same host (any letter case) and an explicit --other-host go through
          for (
            const [name, file, options] of [
              ['own archive', own, {}],
              ['own archive, other letter case', upper, {}],
              ['--other-host', foreign, { otherHost: true }],
            ] as const
          ) {
            const before = calls.length
            const outcome = await runCaptured(() =>
              restore({ yes: true, ...options }, file)
            )
            assertEquals(outcome.error, undefined, `${name}: ${outcome.output}`)
            assertEquals(outcome.exit, null, `${name}: ${outcome.output}`)
            assert(
              tarExtractCall(calls.slice(before)),
              `${name}: tar did not run`,
            )
          }

          // a name that carries no host cannot be checked: refused, unless --other-host
          const renamed = `${home}/my-backup.tar.gz`
          await Deno.writeFile(renamed, new Uint8Array([1]))
          const before = calls.length
          const unnamed = await runCaptured(() =>
            restore({ yes: true }, renamed)
          )
          assertEquals(unnamed.exit, 1, unnamed.output)
          assertStringIncludes(unnamed.output, 'Cannot tell which host')
          assertStringIncludes(unnamed.output, '--other-host')
          assertEquals(
            tarExtractCall(calls.slice(before)),
            undefined,
            'tar ran for an archive without a host in its name',
          )
          const allowed = await runCaptured(() =>
            restore({ yes: true, otherHost: true }, renamed)
          )
          assertEquals(allowed.exit, null, allowed.output)
          assert(
            tarExtractCall(calls.slice(before)),
            'tar did not run with --other-host',
          )
        })
      })

      // a host name with dashes and dots is everything before the timestamp
      const fqdn = await writeArchive(home, 'db-1.eu.example.com')
      for (
        const [thisHost, accepted] of [
          ['db-1.eu.example.com', true],
          ['db-1', false],
        ] as const
      ) {
        await withProcesses(asHost(thisHost), async (calls) => {
          await withUid(0, async () => {
            const outcome = await runCaptured(() =>
              restore({ yes: true }, fqdn)
            )
            assertEquals(outcome.exit, accepted ? null : 1, outcome.output)
            assertEquals(
              tarExtractCall(calls) !== undefined,
              accepted,
              thisHost,
            )
          })
        })
      }
    })
  })
})

Deno.test('r2: a remote archive of another host, or without a host in its name, is refused before anything is requested, signed in or not', async () => {
  const remotes: [string, string][] = [
    ['backups/backup-node-2-20260101-000000.tar.zst', 'node-2'],
    ['backup-node-2-20260101-000000.tar.zst', 'node-2'],
    ['backups/my-backup.tar.zst', 'Cannot tell which host'],
  ]
  for (const signedIn of [true, false]) {
    for (const [remote, mention] of remotes) {
      const name = `${remote} (${signedIn ? 'signed in' : 'not signed in'})`
      await withEnv(cleanBackupEnv, async () => {
        await withHome(
          signedIn ? { slv: loggedIn(FAR_FUTURE) } : null,
          async () => {
            await withProcesses(asHost('node-1'), async (calls) => {
              await withFetch(() => json({}, 500), async (requests) => {
                await withUid(0, async () => {
                  const refused = await runCaptured(() =>
                    restore({ yes: true, region: 'eu' }, remote)
                  )
                  assertEquals(refused.error, undefined, name)
                  assertEquals(refused.exit, 1, `${name}: ${refused.output}`)
                  assertStringIncludes(refused.output, '--other-host')
                  assertStringIncludes(refused.output, mention)
                  assertEquals(
                    requests.length,
                    0,
                    `${name}: a request was sent`,
                  )
                  assertEquals(tarExtractCall(calls), undefined, name)
                })
              })
            })
          },
        )
      })
    }
  }
})

Deno.test('r3: the extract excludes the system identity files and the key material, and --include-system lifts only the system part', async () => {
  await withEnv(cleanBackupEnv, async () => {
    await withHome(null, async (home) => {
      const archive = await writeArchive(home, 'node-1')
      await withProcesses(asHost('node-1'), async (calls) => {
        await withUid(0, async () => {
          for (const includeSystem of [false, true]) {
            const before = calls.length
            const outcome = await runCaptured(() =>
              restore({ yes: true, includeSystem }, archive)
            )
            assertEquals(
              outcome.exit,
              null,
              `includeSystem=${includeSystem}: ${outcome.output}`,
            )
            const tar = tarExtractCall(calls.slice(before))
            assert(tar, `includeSystem=${includeSystem}: tar did not run`)
            // still extracts this archive over /
            assertEquals(
              tar.args.slice(
                tar.args.indexOf('-xf'),
                tar.args.indexOf('-xf') + 4,
              ),
              ['-xf', archive, '-C', '/'],
            )
            // member names carry no leading slash, so the patterns are matched from the start
            assert(
              tar.args.indexOf('--anchored') >= 0 &&
                tar.args.indexOf('--anchored') < tar.args.indexOf('--exclude'),
            )
            const excludes = excludesIn(tar.args)
            for (const path of KEY_MATERIAL) {
              assertEquals(
                missing(excludes, memberNames(path)),
                [],
                `key material ${path} (includeSystem=${includeSystem})`,
              )
            }
            for (const path of SYSTEM_IDENTITY) {
              const names = memberNames(path)
              if (includeSystem) {
                assertEquals(
                  names.filter((n) => excludes.includes(n)),
                  [],
                  `${path} is restored with --include-system`,
                )
              } else {
                assertEquals(
                  missing(excludes, names),
                  [],
                  `system file ${path}`,
                )
              }
            }
          }
        })
      })
    })
  })
})

/** Answers the presign request and serves the "archive" the URL points to. */
const downloadResponder = (url: string): Response => {
  if (url.endsWith('/v3/storage/presign/download')) {
    return json({
      url: 'https://files.example.invalid/get',
      method: 'GET',
      region: 'eu',
      expiresAt: '2100-01-01T00:00:00Z',
    })
  }
  if (url.startsWith('https://files.example.invalid/')) {
    return new Response('archive-bytes')
  }
  return json({}, 500)
}

/** Run `fn` with the OS temp directory pointed at a fresh directory. */
const withTmpdir = async (
  fn: (tmp: string) => Promise<void>,
): Promise<void> => {
  const tmp = await Deno.makeTempDir({ prefix: 'slv-restore-test-' })
  try {
    await withEnv({ TMPDIR: tmp }, () => fn(tmp))
  } finally {
    await Deno.remove(tmp, { recursive: true })
  }
}

const REMOTE = 'backups/backup-node-1-20260101-000000.tar.gz'

Deno.test('r4: a downloaded archive is private while it sits on disk and is removed once the extract is done', async () => {
  await withEnv(cleanBackupEnv, async () => {
    await withHome({ slv: loggedIn(FAR_FUTURE) }, async () => {
      await withTmpdir(async (tmp) => {
        let seen:
          | { path: string; mode: number; dirMode: number; size: number }
          | undefined
        await withProcesses((call) => {
          if (call.command === 'tar' && call.args.includes('-xf')) {
            const path = call.args[call.args.indexOf('-xf') + 1]
            const info = Deno.statSync(path)
            const dir = Deno.statSync(path.slice(0, path.lastIndexOf('/')))
            seen = {
              path,
              mode: info.mode! & 0o777,
              dirMode: dir.mode! & 0o777,
              size: info.size,
            }
          }
          return asHost('node-1')(call)
        }, async () => {
          await withFetch(downloadResponder, async () => {
            await withUid(0, async () => {
              try {
                const outcome = await runCaptured(() =>
                  restore({ yes: true, region: 'eu' }, REMOTE)
                )
                assertEquals(outcome.error, undefined, outcome.output)
                assertEquals(outcome.exit, null, outcome.output)
              } finally {
                // a leftover must not outlive this test, whatever it proved
                if (seen) await Deno.remove(seen.path).catch(() => {})
              }
            })
          })
        })
        assert(seen, 'tar did not run')
        assertEquals(
          seen.size,
          'archive-bytes'.length,
          'tar saw the downloaded bytes',
        )
        assertEquals(
          seen.mode & 0o077,
          0,
          `the download was ${
            seen.mode.toString(8)
          }: group or others can read it`,
        )
        assertEquals(
          seen.dirMode & 0o077,
          0,
          `its directory was ${
            seen.dirMode.toString(8)
          }: others can swap the archive`,
        )
        assertFalse(exists(seen.path), `${seen.path} was left behind`)
        assertEquals(
          [...Deno.readDirSync(tmp)].length,
          0,
          'the download directory was left behind',
        )
      })
    })
  })
})

Deno.test('r5: the downloaded archive is gone before the process exits when tar fails, the user is not root, or zstd is missing', async () => {
  const failures: [string, number, (call: Call) => Reply | void, string][] = [
    [
      'tar fails',
      0,
      (call) =>
        call.command === 'tar'
          ? { success: false, code: 2, stderr: 'tar: boom' }
          : undefined,
      REMOTE,
    ],
    ['not root', 1000, () => undefined, REMOTE],
    [
      'zstd missing',
      0,
      (call) => call.command === 'which' ? { success: false } : undefined,
      'backups/backup-node-1-20260101-000000.tar.zst',
    ],
  ]
  for (const [name, uid, handler, remote] of failures) {
    // where the download used to be written, before it got a directory of its own
    const legacy = `/tmp/${remote.split('/').pop()}`
    const legacyWasThere = exists(legacy) // not ours: leave it alone
    const legacyLeft = () => !legacyWasThere && exists(legacy)
    await withEnv(cleanBackupEnv, async () => {
      await withHome({ slv: loggedIn(FAR_FUTURE) }, async () => {
        await withTmpdir(async (tmp) => {
          let leftAtExit: boolean | undefined
          try {
            await withProcesses((call) => {
              if (call.command === 'hostname') return { stdout: 'node-1\n' }
              return handler(call)
            }, async () => {
              await withFetch(downloadResponder, async () => {
                await withUid(uid, async () => {
                  const outcome = await runCaptured(async () => {
                    // Deno.exit does not run finally blocks: look at the disk at the moment it is called
                    const inner = Deno.exit
                    ;(Deno as unknown as { exit: unknown }).exit = (
                      code?: number,
                    ) => {
                      leftAtExit = legacyLeft() ||
                        [...Deno.readDirSync(tmp)].length > 0
                      return inner(code)
                    }
                    await restore({ yes: true, region: 'eu' }, remote)
                  })
                  assertEquals(
                    outcome.error,
                    undefined,
                    `${name}: ${outcome.output}`,
                  )
                  assertEquals(outcome.exit, 1, `${name}: ${outcome.output}`)
                })
              })
            })
            assertEquals(
              leftAtExit,
              false,
              `${name}: the download was still on disk when the process exited`,
            )
            assertFalse(legacyLeft(), `${name}: ${legacy} was left behind`)
            assertEquals(
              [...Deno.readDirSync(tmp)].length,
              0,
              `${name}: the download directory was left behind`,
            )
          } finally {
            if (!legacyWasThere) await Deno.remove(legacy).catch(() => {})
          }
        })
      })
    })
  }
})

// ---------------------------------------------------------------------------
// 5. A schedule only ever runs the encrypted backup
// ---------------------------------------------------------------------------

Deno.test('s1: the crontab line of a schedule runs the restic backup and never an upload', () => {
  // buildCronEntry is new: reached through a loose type
  const { buildCronEntry } = cron as unknown as {
    buildCronEntry?: (parts: {
      schedule: string
      homeDir: string
      backupEnvFile: string
      slvPath: string
      retention: number
    }) => string
  }
  assert(buildCronEntry, 'cron.ts does not export buildCronEntry')
  const entry = buildCronEntry({
    schedule: '0 3 * * *',
    homeDir: '/root',
    backupEnvFile: '/root/.slv/backup.env',
    slvPath: '/usr/local/bin/slv',
    retention: 14,
  })
  assertEquals(
    entry,
    '0 3 * * * HOME="/root" . /root/.slv/backup.env 2>/dev/null; /usr/local/bin/slv backup create --restic --yes --retention 14 >> /var/log/slv-backup.log 2>&1',
  )
  assertFalse(entry.includes('--upload'))
})

Deno.test('s2: setupCron itself refuses a schedule without restic and never writes a plain upload entry', async () => {
  await withEnv(cleanBackupEnv, async () => {
    await withHome(null, async () => {
      for (const interval of ['daily', 'weekly', 'monthly']) {
        await withProcesses(asHost('node-1'), async (calls) => {
          await withEnterOnly(async () => {
            const refused = await runCaptured(() =>
              cron.setupCron(interval, 7, false)
            )
            assertEquals(
              refused.error,
              undefined,
              `${interval}: ${refused.output}`,
            )
            assertEquals(refused.exit, 1, `${interval}: ${refused.output}`)
            assertStringIncludes(refused.output, '--restic')
          })
          assertFalse(
            calls.some((c) => c.input.includes('--upload')),
            `${interval}: wrote an upload entry`,
          )
          assertEquals(
            calls.filter((c) => c.command === 'crontab').length,
            0,
            `${interval}: crontab was touched`,
          )
        })
      }
    })
  })
})

// ---------------------------------------------------------------------------
// 6. The CLI offers the new flags
// ---------------------------------------------------------------------------

Deno.test('c1: backup restore registers --other-host and --include-system', () => {
  const restore = backupCmd.getCommand('restore')
  assert(restore, 'no restore command')
  const flags = restore.getOptions().flatMap((o) => o.flags)
  assert(flags.includes('--other-host'), flags.join(' '))
  assert(flags.includes('--include-system'), flags.join(' '))
})

// ---------------------------------------------------------------------------
// 7. Wallets: out of tar archives and migrate copies, in restic backups
// ---------------------------------------------------------------------------

/** Wallet files as `slv bot init`, its rescue store and the Solana CLI lay them out. */
const WALLET_FILES = [
  '/home/solv/slv/wallet.json',
  '/home/solv/slv/bot/wallet.json',
  '/root/slv/bot/sub/wallet-2.json',
  '/home/solv/slv/bot/wallet.json.bak.1700000000',
  '/home/solv/.slv/wallet-rescue/1700000000-bot/wallet.json',
  '/home/solv/.slv/wallet-rescue/1700000000-bot/wallet.json.bak.3',
  '/home/solv/.config/solana/id.json',
  '/root/.config/solana/id.json',
]

/** Files beside the wallets that are not wallets. */
const NOT_WALLETS = [
  '/home/solv/slv/bot/src/main.rs',
  '/home/solv/slv/bot/.env',
  '/home/solv/notes.json',
  '/home/solv/.config/solana/cli/config.yml',
]

const escapeRegExp = (text: string): string =>
  text.replace(/[.+^${}()|[\]\\?]/g, '\\$&')

/** Whether an exclude pattern reaches a path (and what lies below it). In tar a `*` also crosses `/`. */
const covers = (pattern: string, path: string, tar: boolean): boolean => {
  const star = tar ? '.*' : '[^/]*'
  const source = pattern
    .split('**')
    .map((part) => part.split('*').map(escapeRegExp).join(star))
    .join('.*')
  return new RegExp(`^${source}(/.*)?$`).test(path)
}

const coveredBy = (
  list: readonly string[],
  path: string,
  tar: boolean,
): boolean => list.some((pattern) => covers(pattern, path, tar))

Deno.test('w1: the tar and rsync lists carry every wallet pattern; the restic list does not while RESTIC_INCLUDES_WALLETS holds, and does when it is false', () => {
  assert(WALLET_EXCLUDES, 'excludes.ts does not export WALLET_EXCLUDES')
  assertEquals(RESTIC_INCLUDES_WALLETS, true)

  for (const tool of ['tar', 'rsync']) {
    const list = buildList({ tool, includeSSH: tool === 'tar' })
    assertEquals(missing(list, WALLET_EXCLUDES), [], tool)
    for (const path of WALLET_FILES) {
      assert(coveredBy(list, path, tool === 'tar'), `${tool} list: ${path}`)
    }
    for (const path of NOT_WALLETS) {
      assertFalse(
        coveredBy(list, path, tool === 'tar'),
        `${tool} list: ${path}`,
      )
    }
    // --include cannot take a wallet out of it
    const lifted = buildList({
      tool,
      includeSSH: tool === 'tar',
      extraIncludes: [...WALLET_EXCLUDES],
    })
    assertEquals(missing(lifted, WALLET_EXCLUDES), [], `${tool} with --include`)
  }

  // restic keeps wallets, and still leaves key material out
  const restic = buildList({ tool: 'restic', includeSSH: true })
  assertEquals(WALLET_EXCLUDES.filter((p) => restic.includes(p)), [])
  for (const path of WALLET_FILES) {
    assertFalse(coveredBy(restic, path, false), `restic list keeps ${path}`)
  }
  assertEquals(missing(restic, KEY_MATERIAL), [])

  // one constant decides it: false puts the wallet patterns in restic's list too
  const strict = buildList({
    tool: 'restic',
    includeSSH: true,
    resticIncludesWallets: false,
  })
  assertEquals(missing(strict, WALLET_EXCLUDES), [])
  for (const path of WALLET_FILES) {
    assert(coveredBy(strict, path, false), `strict restic list: ${path}`)
  }

  // what each tool leaves out is the same rule
  assert(secretExcludes, 'excludes.ts does not export secretExcludes')
  assertEquals(
    missing(secretExcludes('tar'), [...KEY_MATERIAL, ...WALLET_EXCLUDES]),
    [],
  )
  assertEquals(
    WALLET_EXCLUDES.filter((p) => secretExcludes('restic').includes(p)),
    [],
  )
  assertEquals(missing(secretExcludes('restic', false), WALLET_EXCLUDES), [])
})

Deno.test('w2: with the restic switch off the restic backup leaves wallets out too', async () => {
  await withEnv(cleanBackupEnv, async () => {
    await withHome(null, async (home) => {
      await Deno.writeTextFile(
        `${home}/.slv/restic-password`,
        'test-password\n',
      )
      await withProcesses(asHost('node-1'), async (calls) => {
        const outcome = await runCaptured(() =>
          (resticBackup as unknown as (
            key: unknown,
            options: unknown,
          ) => Promise<void>)(
            { id: STORAGE_KEY_ID, secret: STORAGE_SECRET },
            { resticIncludesWallets: false },
          )
        )
        assertEquals(outcome.error, undefined, outcome.output)
        const call = calls.find((c) =>
          c.command === 'restic' && c.args[0] === 'backup'
        )
        assert(call, 'restic backup was not started')
        const excludes = excludesIn(call.args)
        assert(WALLET_EXCLUDES, 'excludes.ts does not export WALLET_EXCLUDES')
        assertEquals(missing(excludes, WALLET_EXCLUDES), [])
        assertEquals(missing(excludes, KEY_MATERIAL), [])
      })
    })
  })
})

Deno.test('h1: every exclude list carries /etc/ssh/ssh_host_*_key, and none of its entries reaches the .pub host keys', () => {
  const privateKeys = '/etc/ssh/ssh_host_*_key'
  for (const tool of ['tar', 'restic']) {
    const list = buildList({ tool, includeSSH: true })
    assert(list.includes(privateKeys), `${tool} list lacks ${privateKeys}`)
    assert(coveredBy(list, '/etc/ssh/ssh_host_ed25519_key', tool === 'tar'))
    assertFalse(
      coveredBy(list, '/etc/ssh/ssh_host_ed25519_key.pub', tool === 'tar'),
      `${tool} list reaches the .pub host key`,
    )
  }
  // migrate also leaves every host key alone (SSH_EXCLUDES), and carries the entry too
  assert(buildList({ tool: 'rsync', includeSSH: false }).includes(privateKeys))
})

// ---------------------------------------------------------------------------
// 8. What a backup leaves out is listed
// ---------------------------------------------------------------------------

/** A HOME with a saved storage key and a restic password, as a restic restore needs. */
const withResticHome = (fn: (home: string) => Promise<void>): Promise<void> =>
  withEnv(cleanBackupEnv, () =>
    withHome({
      slv: {
        ...loggedIn(FAR_FUTURE),
        storage_access_key_id: STORAGE_KEY_ID,
        storage_secret: STORAGE_SECRET,
      },
    }, async (home) => {
      await Deno.writeTextFile(
        `${home}/.slv/restic-password`,
        'test-password\n',
      )
      await fn(home)
    }))

const resticCall = (calls: Call[], verb: string): Call | undefined =>
  calls.find((c) => c.command === 'restic' && c.args[0] === verb)

/** A tar archive run: the fake tar writes the archive, so the backup completes. */
const archivingHost = (output: string) => (call: Call): Reply | void => {
  if (call.args.includes('-cf')) Deno.writeFileSync(output, new Uint8Array(8))
  return asHost('node-1')(call)
}

/** The messages posted to the webhook, as the text Discord would show. */
const posted = (requests: { url: string; body: string | null }[]): string[] =>
  requests
    .filter((r) => r.url === WEBHOOK)
    .map((r) => String(JSON.parse(r.body ?? '{}').content))

const toWebhook = (url: string): Response =>
  url === WEBHOOK ? new Response(null, { status: 204 }) : json({}, 500)

Deno.test('l1: a tar backup prints and posts the key material and wallet files it left out, and tells the operator to keep a copy', async () => {
  const left = [
    '/etc/shadow',
    '/home/solv/identity.json',
    '/home/solv/slv/bot/wallet.json',
  ]
  for (const uid of [0, 1000]) {
    await withEnv(cleanBackupEnv, async () => {
      await withHome(null, async (home) => {
        const output = `${home}/out.tar.zst`
        let asked: readonly string[] = []
        await withProcesses(archivingHost(output), async () => {
          await withFetch(toWebhook, async (requests) => {
            await withUid(uid, async () => {
              const outcome = await runCaptured(() =>
                backup({ yes: true, output, webhook: WEBHOOK }, {
                  findFiles: (patterns) => {
                    asked = patterns
                    return left
                  },
                })
              )
              assertEquals(outcome.error, undefined, outcome.output)
              assertEquals(outcome.exit, null, outcome.output)
              for (const file of left) {
                assertStringIncludes(outcome.output, file)
              }
              assertStringIncludes(outcome.output, 'Left out of this backup')
              assertStringIncludes(outcome.output, 'Keep an offline copy')
              // the search runs as the user, so a non-root user is told it may be short
              assertEquals(
                outcome.output.includes('run as root to list them'),
                uid !== 0,
                `uid ${uid}`,
              )

              const text = posted(requests).join('\n')
              for (const file of left) assertStringIncludes(text, file)
              assertStringIncludes(text, 'offline copy')
            })
          })
        })
        // a tar archive leaves out key material and wallets
        assert(WALLET_EXCLUDES, 'excludes.ts does not export WALLET_EXCLUDES')
        assertEquals(missing([...asked], KEY_MATERIAL), [])
        assertEquals(missing([...asked], WALLET_EXCLUDES), [])
      })
    })
  }
})

Deno.test('l2: a restic backup lists the key material it left out, not the wallets it kept', async () => {
  const left = ['/home/solv/identity.json', '/etc/ssh/ssh_host_ed25519_key']
  await withResticHome(async () => {
    let asked: readonly string[] = []
    await withProcesses(asHost('node-1'), async () => {
      await withFetch(toWebhook, async (requests) => {
        const outcome = await runCaptured(() =>
          backup({ restic: true, yes: true, webhook: WEBHOOK }, {
            findFiles: (patterns) => {
              asked = patterns
              return left
            },
          })
        )
        assertEquals(outcome.error, undefined, outcome.output)
        assertEquals(outcome.exit, null, outcome.output)
        for (const file of left) assertStringIncludes(outcome.output, file)
        assertStringIncludes(outcome.output, 'Keep an offline copy')
        const text = posted(requests).join('\n')
        for (const file of left) assertStringIncludes(text, file)
      })
    })
    assertEquals(missing([...asked], KEY_MATERIAL), [])
    assert(WALLET_EXCLUDES, 'excludes.ts does not export WALLET_EXCLUDES')
    assertEquals(
      WALLET_EXCLUDES.filter((pattern) => asked.includes(pattern)),
      [],
      'the restic backup keeps wallets, so they are not listed as left out',
    )
  })
})

Deno.test('l3: nothing left out means no list and no extra post; a long list is posted in full, in messages Discord accepts', async () => {
  await withEnv(cleanBackupEnv, async () => {
    await withHome(null, async (home) => {
      const output = `${home}/out.tar.zst`
      await withProcesses(archivingHost(output), async () => {
        await withFetch(toWebhook, async (requests) => {
          await withUid(0, async () => {
            // nothing found
            const none = await runCaptured(() =>
              backup({ yes: true, output, webhook: WEBHOOK }, {
                findFiles: () => [],
              })
            )
            assertEquals(none.exit, null, none.output)
            assertFalse(none.output.includes('Left out of this backup'))
            assertEquals(posted(requests).length, 1, 'only the completion post')

            // a long list
            const many = Array.from(
              { length: 120 },
              (_, i) =>
                `/home/solv/keys/validator-${i}-keypair-backup-copy.json`,
            )
            const before = requests.length
            const long = await runCaptured(() =>
              backup({ yes: true, output, webhook: WEBHOOK }, {
                findFiles: () => many,
              })
            )
            assertEquals(long.exit, null, long.output)
            const messages = posted(requests.slice(before))
            assert(messages.length > 2, 'the list needed more than one message')
            for (const message of messages) {
              assert(
                message.length <= 2000,
                `message of ${message.length} characters`,
              )
            }
            const text = messages.join('\n')
            for (const file of many) assertStringIncludes(text, file)
          })
        })
      })
    })
  })
})

Deno.test('l4: the search finds the key material and wallet files that exist on a host, and only those', async () => {
  assert(findExistingPaths, 'excludes.ts does not export findExistingPaths')
  assert(secretExcludes, 'excludes.ts does not export secretExcludes')
  const root = await Deno.makeTempDir({ prefix: 'slv-left-out-' })
  try {
    for (
      const file of [
        '/home/alice/.slv/keys/main.json',
        '/home/alice/identity.json',
        '/home/alice/notes.json',
        '/home/alice/slv/bot/wallet.json',
        '/home/alice/slv/bot/src/main.rs',
        '/home/alice/slv/bot/target/debug/wallet-x.json',
        '/home/alice/slv/bot/node_modules/pkg/wallet-y.json',
        '/home/alice/.slv/wallet-rescue/1700-bot/wallet.json',
        '/home/bob/.config/solana/id.json',
        '/home/bob/.ssh/id_ed25519',
        '/home/bob/.ssh/authorized_keys',
        '/root/slv/wallet.json',
        '/etc/shadow',
        '/etc/hosts',
        '/etc/ssh/ssh_host_ed25519_key',
        '/etc/ssh/ssh_host_ed25519_key.pub',
      ]
    ) {
      await Deno.mkdir(`${root}${file.slice(0, file.lastIndexOf('/'))}`, {
        recursive: true,
      })
      await Deno.writeTextFile(`${root}${file}`, 'x')
    }
    const keyMaterial = [
      '/etc/shadow',
      '/etc/ssh/ssh_host_ed25519_key',
      '/home/alice/.slv/keys',
      '/home/alice/identity.json',
      '/home/bob/.ssh/id_ed25519',
    ]
    const wallets = [
      '/home/alice/.slv/wallet-rescue',
      '/home/alice/slv/bot/wallet.json',
      '/home/bob/.config/solana/id.json',
      '/root/slv/wallet.json',
    ]
    // a tar archive leaves out both; a restic backup keeps the wallets
    assertEquals(
      await findExistingPaths(secretExcludes('tar'), { root }),
      [...keyMaterial, ...wallets].sort(),
    )
    assertEquals(
      await findExistingPaths(secretExcludes('restic'), { root }),
      [...keyMaterial].sort(),
    )
    // a host with none of them
    const empty = await Deno.makeTempDir({ prefix: 'slv-left-out-empty-' })
    try {
      assertEquals(
        await findExistingPaths(secretExcludes('tar'), { root: empty }),
        [],
      )
    } finally {
      await Deno.remove(empty, { recursive: true })
    }
  } finally {
    await Deno.remove(root, { recursive: true })
  }
})

// ---------------------------------------------------------------------------
// 9. A restic restore: this host's snapshots, the same exclusions
// ---------------------------------------------------------------------------

Deno.test("t1: a restic restore excludes the system files and the key material, takes this host's snapshot, and restores wallets", async () => {
  const cases: [string, Record<string, unknown>, boolean, boolean][] = [
    ['default', {}, true, true],
    ['--other-host', { otherHost: true }, false, true],
    ['--include-system', { includeSystem: true }, true, false],
    ['both', { otherHost: true, includeSystem: true }, false, false],
  ]
  for (const [name, flags, hostFilter, systemExcluded] of cases) {
    await withResticHome(async () => {
      await withProcesses(asHost('node-1'), async (calls) => {
        await withUid(0, async () => {
          const outcome = await runCaptured(() =>
            restore({ yes: true, region: 'eu', ...flags }, 'latest')
          )
          assertEquals(outcome.error, undefined, `${name}: ${outcome.output}`)
          assertEquals(outcome.exit, null, `${name}: ${outcome.output}`)
          assertFalse(
            outcome.output.includes('apply to tar archives'),
            `${name}: the tar-only note is gone`,
          )
          assertStringIncludes(
            outcome.output,
            hostFilter ? 'this host only' : 'any host',
          )
        })
        const call = resticCall(calls, 'restore')
        assert(call, `${name}: restic restore was not started`)
        assertEquals(call.args.slice(0, 4), [
          'restore',
          'latest',
          '--target',
          '/',
        ], name)
        // "latest" is this host's latest, unless --other-host
        const hostAt = call.args.indexOf('--host')
        if (hostFilter) {
          assertEquals(call.args[hostAt + 1], 'node-1', `${name}: --host`)
        } else {
          assertEquals(hostAt, -1, `${name}: --host`)
        }
        // "latest" needs no look at the snapshot first
        assertEquals(resticCall(calls, 'snapshots'), undefined, name)

        const excludes = excludesIn(call.args)
        assertEquals(
          missing(excludes, KEY_MATERIAL),
          [],
          `${name}: key material`,
        )
        if (systemExcluded) {
          assertEquals(
            missing(excludes, SYSTEM_IDENTITY),
            [],
            `${name}: system`,
          )
        } else {
          assertEquals(
            SYSTEM_IDENTITY.filter((p) => excludes.includes(p)),
            [],
            `${name}: --include-system lifts the system part`,
          )
        }
        // wallets are restored
        assert(WALLET_EXCLUDES, 'excludes.ts does not export WALLET_EXCLUDES')
        assertEquals(
          WALLET_EXCLUDES.filter((p) => excludes.includes(p)),
          [],
          `${name}: wallets`,
        )
      })
    })
  }
})

Deno.test('t2: a named snapshot of another host is refused unless --other-host, because --host only picks "latest"', async () => {
  const cases: [string, unknown, Record<string, unknown>, boolean][] = [
    ['this host', [{ id: 'abc', hostname: 'node-1' }], {}, true],
    [
      'this host, other letter case',
      [{ id: 'abc', hostname: 'NODE-1' }],
      {},
      true,
    ],
    [
      'grouped answer',
      [{ group_key: {}, snapshots: [{ id: 'abc', hostname: 'node-1' }] }],
      {},
      true,
    ],
    ['another host', [{ id: 'abc', hostname: 'node-2' }], {}, false],
    ['no host named', [], {}, false],
    [
      'another host, --other-host',
      [{ id: 'abc', hostname: 'node-2' }],
      { otherHost: true },
      true,
    ],
  ]
  for (const [name, answer, flags, restored] of cases) {
    await withResticHome(async () => {
      await withProcesses((call) => {
        if (call.command === 'restic' && call.args[0] === 'snapshots') {
          return { stdout: JSON.stringify(answer) }
        }
        return asHost('node-1')(call)
      }, async (calls) => {
        await withUid(0, async () => {
          const outcome = await runCaptured(() =>
            restore({ yes: true, region: 'eu', ...flags }, 'abc12345')
          )
          assertEquals(outcome.error, undefined, name)
          assertEquals(
            outcome.exit,
            restored ? null : 1,
            `${name}: ${outcome.output}`,
          )
          if (!restored) assertStringIncludes(outcome.output, '--other-host')
        })
        const call = resticCall(calls, 'restore')
        assertEquals(call !== undefined, restored, `${name}: restic restore`)
        if (call) assertEquals(call.args[1], 'abc12345', name)
        // with --other-host nothing is asked about the snapshot's host
        const asked = resticCall(calls, 'snapshots')
        assertEquals(
          asked !== undefined,
          !flags.otherHost,
          `${name}: snapshots`,
        )
        if (asked) {
          assertEquals(asked.args.slice(0, 3), [
            'snapshots',
            '--json',
            'abc12345',
          ])
        }
      })
    })
  }

  // restic cannot read the snapshot: nothing is restored
  await withResticHome(async () => {
    await withProcesses((call) => {
      if (call.command === 'restic' && call.args[0] === 'snapshots') {
        return { success: false, stderr: 'Fatal: no matching ID found' }
      }
      return asHost('node-1')(call)
    }, async (calls) => {
      await withUid(0, async () => {
        const outcome = await runCaptured(() =>
          restore({ yes: true, region: 'eu' }, 'nosuchid')
        )
        assertEquals(outcome.exit, 1, outcome.output)
        assertStringIncludes(outcome.output, 'no matching ID')
      })
      assertEquals(resticCall(calls, 'restore'), undefined)
    })
  })
})

Deno.test('t3: a snapshot listing can be limited to one host', async () => {
  await withResticHome(async () => {
    await withProcesses((call) => {
      if (call.command === 'restic' && call.args[0] === 'snapshots') {
        return { stdout: '[]' }
      }
      return asHost('node-1')(call)
    }, async (calls) => {
      const list = resticSnapshots as unknown as (
        key: unknown,
        region?: string,
        options?: { host?: string },
      ) => Promise<string>
      const key = { id: STORAGE_KEY_ID, secret: STORAGE_SECRET }
      await list(key, 'eu', { host: 'node-1' })
      await list(key, 'eu')
      const [limited, all] = calls.filter((c) =>
        c.command === 'restic' && c.args[0] === 'snapshots'
      )
      assertEquals(limited.args, ['snapshots', '--json', '--host', 'node-1'])
      assertEquals(all.args, ['snapshots', '--json'])
    })
  })
})

// ---------------------------------------------------------------------------
// 10. The migrate help says what is not copied
// ---------------------------------------------------------------------------

Deno.test('m1: slv migrate linux says in its help that key material is not copied', () => {
  const description = migrateLinuxCmd.getDescription()
  assertMatch(description, /key material/i)
  assertMatch(description, /not copied/i)
})
