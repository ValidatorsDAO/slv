// slv overhaul W0: backup, restore and migrate. Deno.Command and fetch are
// replaced; the argument lists the code builds are asserted.

import {
  assert,
  assertEquals,
  assertFalse,
  assertMatch,
  assertRejects,
  assertStringIncludes,
  assertThrows,
} from '@std/assert'

import { backupAction } from '@/backup/backupAction.ts'
import * as cron from '@/backup/cron.ts'
import { backupCmd } from '@/backup/index.ts'
import * as excludesModule from '@/backup/excludes.ts'
import {
  buildExcludeList,
  DEFAULT_EXCLUDES,
  FilterSyntaxError,
  perComponentPatterns,
  SSH_EXCLUDES,
  TAR_PER_COMPONENT,
} from '@/backup/excludes.ts'
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

/** The lookups of a backup or migrate run: they find nothing unless a test says otherwise, so no test searches this host. */
const nothing = {
  findFiles: (): string[] => [],
  findPrivateKeys: (): string[] => [],
  findPrivateKeysAsRoot: (): string[] => [],
  findUnlistedSshDirs: (): string[] => [],
}

/** backupAction with loosely typed options and lookups (the lookups are new). */
const backup = (
  options: Record<string, unknown>,
  deps: {
    findFiles?: (patterns: readonly string[]) => string[] | Promise<string[]>
    findPrivateKeys?: () => string[] | Promise<string[]>
    findPrivateKeysAsRoot?: () => string[] | Promise<string[]>
    findUnlistedSshDirs?: () => string[] | Promise<string[]>
  } = {},
): Promise<void> =>
  (backupAction as unknown as (
    options: Record<string, unknown>,
    deps: unknown,
  ) => Promise<void>)(options, { ...nothing, ...deps })

/** migrateLinux with loosely typed options (the lookups are new). */
const migrate = (options: Record<string, unknown>): Promise<boolean> =>
  (migrateLinux as unknown as (
    options: Record<string, unknown>,
  ) => Promise<boolean>)({
    findPrivateKeys: nothing.findPrivateKeys,
    findPrivateKeysAsRoot: nothing.findPrivateKeysAsRoot,
    findUnlistedSshDirs: nothing.findUnlistedSshDirs,
    ...options,
  })

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
          // a tar archive never carries a wallet, whatever --include says (tar
          // reads an entry that reaches any depth as one pattern per number of directories)
          assert(WALLET_EXCLUDES, 'excludes.ts does not export WALLET_EXCLUDES')
          assertEquals(
            missing(excludes, WALLET_EXCLUDES.flatMap(perComponentPatterns)),
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

/** The processes of a migrate run: a fresh destination that answers ssh, and a local df. */
const migrationHost = (call: Call): Reply | void => {
  if (call.command === 'df') return { stdout: 'Used\n1000\n' }
  if (call.command !== 'ssh') return
  const command = call.args[call.args.length - 1]
  if (command === 'echo ok') return { stdout: 'ok\n' }
  if (command.startsWith('ls -1 /home')) return { stdout: '' }
  if (command.includes('/proc/uptime')) return { stdout: '60\n' }
  if (command.includes('df --output=avail')) {
    return { stdout: '999999999999\n' }
  }
}

Deno.test('k4: the migrate rsync excludes every key-material and wallet entry, --include or not', async () => {
  const cases: [string, string[]][] = [['defaults', []], [
    'include names key material and wallets',
    [...KEY_MATERIAL, ...(WALLET_EXCLUDES ?? [])],
  ]]
  for (const [name, extraIncludes] of cases) {
    await withEnv(cleanBackupEnv, async () => {
      await withProcesses(migrationHost, async (calls) => {
        await withUid(0, async () => {
          const outcome = await runCaptured(() =>
            migrate({
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
            { resticIncludesWallets: false, findPrivateKeys: () => [] },
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

// ---------------------------------------------------------------------------
// 11. SSH private keys are found by what they hold, not by their name
// ---------------------------------------------------------------------------

/** The exports that find private keys, reached through a loose type. */
const {
  findPrivateKeys,
  findPrivateKeysAsRoot,
  findUnlistedSshDirs,
  searchSshKeys,
  exactExclude,
} = excludesModule as unknown as {
  findPrivateKeysAsRoot?: (
    options?: { root?: string; sudo?: readonly string[] },
  ) => Promise<string[]>
  findUnlistedSshDirs?: (options?: { root?: string }) => Promise<string[]>
  searchSshKeys?: (options: {
    underSudo: boolean
    find?: () => string[] | Promise<string[]>
    findAsRoot?: () => string[] | Promise<string[]>
    findUnlisted?: () => string[] | Promise<string[]>
  }) => Promise<{
    keys: string[]
    wholeDirs: string[]
    rootSearchFailed: boolean
  }>
  findPrivateKeys?: (
    options?: {
      root?: string
      readHead?: (path: string) => Promise<Uint8Array>
    },
  ) => Promise<string[]>
  exactExclude?: (path: string) => string
}

const OPENSSH_KEY =
  '-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gtZW\n-----END OPENSSH PRIVATE KEY-----\n'
const PUBLIC_KEY = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExample alice@laptop\n'

/**
 * A fake file system root with the .ssh directories of three users. Files named
 * in `sealed` cannot be read: chmod 000, or (as root, who reads anything) a
 * reader that refuses them.
 */
const withSshHomes = async (
  fn: (setup: {
    root: string
    find: () => Promise<string[]>
    readHead?: (path: string) => Promise<Uint8Array>
  }) => Promise<void>,
): Promise<void> => {
  const root = await Deno.makeTempDir({ prefix: 'slv-ssh-keys-' })
  const sealed = new Set<string>()
  try {
    const put = async (path: string, text: string, locked = false) => {
      await Deno.mkdir(`${root}${path.slice(0, path.lastIndexOf('/'))}`, {
        recursive: true,
      })
      await Deno.writeTextFile(`${root}${path}`, text)
      if (locked) {
        await Deno.chmod(`${root}${path}`, 0o000)
        sealed.add(`${root}${path}`)
      }
    }
    // alice: the files of the acceptance example, and a few other key formats
    const alice = '/home/alice/.ssh'
    await put(`${alice}/id_ed25519`, OPENSSH_KEY)
    await put(`${alice}/mykey`, OPENSSH_KEY)
    await put(`${alice}/mykey.pub`, PUBLIC_KEY)
    await put(`${alice}/authorized_keys`, PUBLIC_KEY)
    await put(`${alice}/known_hosts`, 'github.com ssh-ed25519 AAAAC3Example\n')
    await put(`${alice}/config`, 'Host *\n  ServerAliveInterval 60\n')
    await put(`${alice}/locked`, 'cannot be read', true)
    await put(
      `${alice}/old.pem`,
      'Bag Attributes\n    friendlyName: deploy\n-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA\n-----END RSA PRIVATE KEY-----\n',
    )
    await put(`${alice}/pkcs8`, '-----BEGIN PRIVATE KEY-----\nMIIEvQ\n')
    await put(`${alice}/enc`, '-----BEGIN ENCRYPTED PRIVATE KEY-----\nMIIFH\n')
    await put(`${alice}/ec`, '-----BEGIN EC PRIVATE KEY-----\nMHcCAQ\n')
    await put(
      `${alice}/deploy.ppk`,
      'PuTTY-User-Key-File-3: ssh-ed25519\nEncryption: none\n',
    )
    await put(`${alice}/server.crt`, '-----BEGIN CERTIFICATE-----\nMIIDdz\n')
    await put(`${alice}/notes.txt`, 'my keys are in a safe place\n')
    // not regular files directly in .ssh: a symlink, and a directory
    await Deno.symlink('mykey', `${root}${alice}/link`)
    await put(`${alice}/keys/prod`, OPENSSH_KEY)
    // bob: unreadable files, which are keys unless their name says they are not
    const bob = '/home/bob/.ssh'
    await put(`${bob}/mykey2`, OPENSSH_KEY)
    await put(`${bob}/secret_notes`, 'unreadable', true)
    await put(`${bob}/known_hosts`, 'unreadable', true)
    await put(`${bob}/config`, 'unreadable', true)
    await put(`${bob}/authorized_keys`, 'unreadable', true)
    await put(`${bob}/laptop.pub`, 'unreadable', true)
    // root; carol has no .ssh at all
    await put('/root/.ssh/rootkey', OPENSSH_KEY)
    await Deno.mkdir(`${root}/home/carol`, { recursive: true })

    const readHead = Deno.uid() === 0
      ? async (path: string): Promise<Uint8Array> => {
        if (sealed.has(path)) throw new Deno.errors.PermissionDenied(path)
        return (await Deno.readFile(path)).subarray(0, 8192)
      }
      : undefined
    assert(findPrivateKeys, 'excludes.ts does not export findPrivateKeys')
    await fn({
      root,
      readHead,
      find: () => findPrivateKeys({ root, readHead }),
    })
  } finally {
    // the sealed files cannot be removed with the rest
    for (const path of sealed) await Deno.chmod(path, 0o600).catch(() => {})
    await Deno.remove(root, { recursive: true })
  }
}

/** What the example directory holds that is a private key, by path. */
const PRIVATE_KEYS = [
  '/home/alice/.ssh/deploy.ppk',
  '/home/alice/.ssh/ec',
  '/home/alice/.ssh/enc',
  '/home/alice/.ssh/id_ed25519',
  '/home/alice/.ssh/locked',
  '/home/alice/.ssh/mykey',
  '/home/alice/.ssh/old.pem',
  '/home/alice/.ssh/pkcs8',
  '/home/bob/.ssh/mykey2',
  '/home/bob/.ssh/secret_notes',
  '/root/.ssh/rootkey',
]

/** Files beside the keys that must not be counted as keys. */
const NOT_PRIVATE_KEYS = [
  '/home/alice/.ssh/mykey.pub',
  '/home/alice/.ssh/authorized_keys',
  '/home/alice/.ssh/known_hosts',
  '/home/alice/.ssh/config',
  '/home/alice/.ssh/server.crt',
  '/home/alice/.ssh/notes.txt',
  '/home/alice/.ssh/link',
  '/home/alice/.ssh/keys/prod',
  '/home/bob/.ssh/known_hosts',
  '/home/bob/.ssh/config',
  '/home/bob/.ssh/authorized_keys',
  '/home/bob/.ssh/laptop.pub',
]

Deno.test('n1: a private key is found by its header whatever its name, and a file that cannot be read counts unless its name says it is not a key', async () => {
  await withSshHomes(async ({ find }) => {
    assertEquals(await find(), PRIVATE_KEYS)
  })
})

Deno.test('n2: the tar, restic and rsync exclude lists carry id_* and every private key found, and not the public key, authorized_keys or known_hosts', async () => {
  await withSshHomes(async ({ find }) => {
    const carries = (list: string[], name: string, tar: boolean) => {
      // the patterns that were always there, and the keys that were found
      assert(list.includes('/home/*/.ssh/id_*'), `${name}: id_*`)
      for (const key of PRIVATE_KEYS) {
        assert(list.includes(key), `${name}: ${key}`)
      }
      for (const path of NOT_PRIVATE_KEYS) {
        assertFalse(list.includes(path), `${name} lists ${path}`)
      }
      // and nothing in the list reaches the public key or the ssh files
      if (name !== 'rsync') {
        for (const path of NOT_PRIVATE_KEYS) {
          assertFalse(coveredBy(list, path, tar), `${name}: ${path} is covered`)
        }
      }
    }

    // tar: the command backupAction starts
    await withEnv(cleanBackupEnv, async () => {
      await withHome(null, async (home) => {
        const output = `${home}/out.tar.zst`
        await withProcesses(archivingHost(output), async (calls) => {
          await withUid(0, async () => {
            const outcome = await runCaptured(() =>
              backup({ yes: true, output }, { findPrivateKeys: find })
            )
            assertEquals(outcome.exit, null, outcome.output)
          })
          const tar = archiveCall(calls)
          assert(tar, 'no tar call')
          carries(excludesIn(tar.args), 'tar', true)
        })
      })
    })

    // restic: through backupAction, and on its own
    await withResticHome(async () => {
      await withProcesses(asHost('node-1'), async (calls) => {
        await withUid(0, async () => {
          const outcome = await runCaptured(() =>
            backup({ restic: true, yes: true }, { findPrivateKeys: find })
          )
          assertEquals(outcome.exit, null, outcome.output)
          const direct = await runCaptured(() =>
            (resticBackup as unknown as (
              key: unknown,
              options: unknown,
            ) => Promise<void>)(
              { id: STORAGE_KEY_ID, secret: STORAGE_SECRET },
              { findPrivateKeys: find },
            )
          )
          assertEquals(direct.error, undefined, direct.output)
        })
        const backups = calls.filter((c) =>
          c.command === 'restic' && c.args[0] === 'backup'
        )
        assertEquals(backups.length, 2, 'restic backup calls')
        for (const call of backups) {
          carries(excludesIn(call.args), 'restic', false)
        }
      })
    })

    // rsync: slv migrate linux
    await withEnv(cleanBackupEnv, async () => {
      await withProcesses(migrationHost, async (calls) => {
        await withUid(0, async () => {
          const outcome = await runCaptured(() =>
            migrate({
              to: 'root@new-server',
              yes: true,
              skipReboot: true,
              findPrivateKeys: find,
            })
          )
          assertEquals(outcome.error, undefined, outcome.output)
        })
        const rsync = calls.find((c) => c.args.includes('-aHAXSx'))
        assert(rsync, 'rsync was not started')
        carries(excludesIn(rsync.args), 'rsync', false)
      })
    })
  })
})

Deno.test('n3: --include cannot lift a private key found, and a name with glob characters is still matched', () => {
  assert(exactExclude, 'excludes.ts does not export exactExclude')
  const keys = [
    '/home/alice/.ssh/mykey',
    '/home/alice/.ssh/key[1]',
    '/home/alice/.ssh/a*b',
    '/home/alice/.ssh/c?d',
    '/home/alice/.ssh/e\\f',
  ]
  for (const tool of ['tar', 'restic', 'rsync']) {
    const list = buildList({
      tool,
      includeSSH: tool !== 'rsync',
      privateKeys: keys,
      extraIncludes: [...keys, ...keys.map(exactExclude)],
    })
    for (const key of keys) {
      assert(list.includes(exactExclude(key)), `${tool}: ${key}`)
    }
  }
  // a plain name stays as it is; glob syntax and escapes become `?`, which tar, restic and rsync read alike
  assertEquals(exactExclude('/home/alice/.ssh/mykey'), '/home/alice/.ssh/mykey')
  assertEquals(
    exactExclude('/home/alice/.ssh/key[1]'),
    '/home/alice/.ssh/key?1]',
  )
  assertEquals(exactExclude('/home/alice/.ssh/a*b'), '/home/alice/.ssh/a?b')
  assertEquals(exactExclude('/home/alice/.ssh/c?d'), '/home/alice/.ssh/c?d')
  assertEquals(exactExclude('/home/alice/.ssh/e\\f'), '/home/alice/.ssh/e?f')
  // a name that is not valid UTF-8 arrives with U+FFFD in it: any run of characters
  assertEquals(exactExclude('/home/alice/.ssh/k�y'), '/home/alice/.ssh/k*y')
})

Deno.test('n4: the private keys found are listed with the files a backup left out, and posted to the webhook', async () => {
  await withSshHomes(async ({ find }) => {
    // the file search finds nothing: the keys come from the scan alone
    const deps = { findPrivateKeys: find, findFiles: () => [] }
    for (const restic of [false, true]) {
      const name = restic ? 'restic' : 'tar'
      const check = async (home: string) => {
        const output = `${home}/out.tar.zst`
        await withProcesses(
          restic ? asHost('node-1') : archivingHost(output),
          async () => {
            await withFetch(toWebhook, async (requests) => {
              await withUid(0, async () => {
                const outcome = await runCaptured(() =>
                  backup({ yes: true, restic, output, webhook: WEBHOOK }, deps)
                )
                assertEquals(outcome.exit, null, `${name}: ${outcome.output}`)
                const text = posted(requests).join('\n')
                for (const key of PRIVATE_KEYS) {
                  assertStringIncludes(outcome.output, key)
                  assertStringIncludes(text, key)
                }
                for (const path of NOT_PRIVATE_KEYS) {
                  assertFalse(outcome.output.includes(path), `${name}: ${path}`)
                  assertFalse(text.includes(path), `${name}: ${path} (webhook)`)
                }
              })
            })
          },
        )
      }
      if (restic) await withResticHome(check)
      else await withEnv(cleanBackupEnv, () => withHome(null, check))
    }
  })
})

Deno.test('n5: --list-excludes shows the private keys found, for backup and for migrate', async () => {
  await withSshHomes(async ({ find }) => {
    await withEnv(cleanBackupEnv, async () => {
      const backups = await runCaptured(() =>
        backup({ listExcludes: true }, { findPrivateKeys: find })
      )
      assertEquals(backups.exit, null, backups.output)
      const migration = await runCaptured(() =>
        migrate({ to: '', listExcludes: true, findPrivateKeys: find })
      )
      assertEquals(migration.error, undefined, migration.output)
      for (const key of PRIVATE_KEYS) {
        assertStringIncludes(backups.output, key)
        assertStringIncludes(migration.output, key)
      }
    })
  })
})

/** Counts the three searches of a run, and answers them. */
const countedSearches = (
  answers: {
    asUser?: string[]
    asRoot?: string[] | Error
    unlisted?: string[]
  } = {},
) => {
  const seen = { asUser: 0, asRoot: 0, unlisted: 0 }
  return {
    seen,
    deps: {
      findPrivateKeys: () => {
        seen.asUser += 1
        return answers.asUser ?? []
      },
      findPrivateKeysAsRoot: () => {
        seen.asRoot += 1
        if (answers.asRoot instanceof Error) throw answers.asRoot
        return answers.asRoot ?? []
      },
      findUnlistedSshDirs: () => {
        seen.unlisted += 1
        return answers.unlisted ?? []
      },
    },
  }
}

const MINE = '/home/alice/.ssh/mykey'
const ONLY_ROOT_SEES = ['/root/.ssh/rootkey', '/home/bob/.ssh/bobkey']

Deno.test('n6: when tar or rsync run under sudo, the search for private keys runs as root too and what it finds is excluded', async () => {
  for (const uid of [0, 1000]) {
    const sudo = uid !== 0
    const searches = () =>
      countedSearches({ asUser: [MINE], asRoot: ONLY_ROOT_SEES })

    // tar: under sudo for a user who is not root
    await withEnv(cleanBackupEnv, () =>
      withHome(null, async (home) => {
        const output = `${home}/out.tar.zst`
        const { seen, deps } = searches()
        await withProcesses(archivingHost(output), async (calls) => {
          await withUid(uid, async () => {
            const outcome = await runCaptured(() =>
              backup({ yes: true, output }, deps)
            )
            assertEquals(outcome.exit, null, outcome.output)
            const tar = archiveCall(calls)
            assert(tar, 'no tar call')
            const excludes = excludesIn(tar.args)
            assert(excludes.includes(MINE), `tar, uid ${uid}: ${MINE}`)
            for (const key of ONLY_ROOT_SEES) {
              assertEquals(
                excludes.includes(key),
                sudo,
                `tar, uid ${uid}: ${key}`,
              )
            }
            // it is listed with what the backup left out, and nothing needed a fallback
            assertEquals(outcome.output.includes(ONLY_ROOT_SEES[0]), sudo)
            assertFalse(outcome.output.includes('could not run as root'))
          })
        })
        assertEquals(
          seen,
          { asUser: 1, asRoot: sudo ? 1 : 0, unlisted: 0 },
          `tar, uid ${uid}`,
        )
      }))

    // restic runs as the user: it reads what the search as the user could read
    await withResticHome(async () => {
      const { seen, deps } = searches()
      await withProcesses(asHost('node-1'), async (calls) => {
        await withUid(uid, async () => {
          const outcome = await runCaptured(() =>
            backup({ restic: true, yes: true }, deps)
          )
          assertEquals(outcome.exit, null, outcome.output)
        })
        const restic = calls.find((c) =>
          c.command === 'restic' && c.args[0] === 'backup'
        )
        assert(restic, 'restic backup was not started')
        const excludes = excludesIn(restic.args)
        assert(excludes.includes(MINE))
        for (const key of ONLY_ROOT_SEES) {
          assertFalse(excludes.includes(key), `restic, uid ${uid}: ${key}`)
        }
      })
      assertEquals(
        seen,
        { asUser: 1, asRoot: 0, unlisted: 0 },
        `restic, uid ${uid}`,
      )
    })

    // rsync: under sudo for a user who is not root
    await withEnv(cleanBackupEnv, async () => {
      const { seen, deps } = searches()
      await withProcesses(migrationHost, async (calls) => {
        await withUid(uid, async () => {
          const outcome = await runCaptured(() =>
            migrate({
              to: 'root@new-server',
              yes: true,
              skipReboot: true,
              ...deps,
            })
          )
          assertEquals(outcome.error, undefined, outcome.output)
          assertEquals(outcome.output.includes('found as root'), sudo)
          assertFalse(outcome.output.includes('could not run as root'))
        })
        const rsync = calls.find((c) => c.args.includes('-aHAXSx'))
        assert(rsync, 'rsync was not started')
        const excludes = excludesIn(rsync.args)
        assert(excludes.includes(MINE), `rsync, uid ${uid}: ${MINE}`)
        for (const key of ONLY_ROOT_SEES) {
          assertEquals(
            excludes.includes(key),
            sudo,
            `rsync, uid ${uid}: ${key}`,
          )
        }
      })
      assertEquals(seen.asRoot, sudo ? 1 : 0, `rsync, uid ${uid}`)
    })
  }
})

Deno.test('n7: the search for private keys runs once per backup, and not at all when the backup is refused', async () => {
  let scans = 0
  const counted = () => {
    scans += 1
    return [] as string[]
  }
  await withEnv(cleanBackupEnv, async () => {
    // refused before anything is read
    const refused = await runCaptured(() =>
      backup({ upload: true, yes: true }, { findPrivateKeys: counted })
    )
    assertEquals(refused.exit, 1, refused.output)
    assertEquals(scans, 0, 'a refused backup read the .ssh directories')

    // a tar backup
    await withHome(null, async (home) => {
      const output = `${home}/out.tar.zst`
      await withProcesses(archivingHost(output), async () => {
        await withUid(0, async () => {
          const outcome = await runCaptured(() =>
            backup({ yes: true, output }, { findPrivateKeys: counted })
          )
          assertEquals(outcome.exit, null, outcome.output)
        })
      })
    })
    assertEquals(scans, 1, 'tar backup')

    // a restic backup builds two lists and lists what it left out: one search
    scans = 0
    await withResticHome(async () => {
      await withProcesses(asHost('node-1'), async () => {
        await withUid(0, async () => {
          const outcome = await runCaptured(() =>
            backup({ restic: true, yes: true }, { findPrivateKeys: counted })
          )
          assertEquals(outcome.exit, null, outcome.output)
        })
      })
    })
    assertEquals(scans, 1, 'restic backup')
  })
})

Deno.test('n8: when the search as root fails, the .ssh directories this user cannot list are excluded as a whole, and reported', async () => {
  const unlisted = ['/home/bob/.ssh', '/root/.ssh']
  const failing = () =>
    countedSearches({
      asUser: [MINE],
      asRoot: new Error('sudo: a password is required'),
      unlisted,
    })

  // tar under sudo: excluded, said in the output, listed with what was left out, posted
  await withEnv(cleanBackupEnv, () =>
    withHome(null, async (home) => {
      const output = `${home}/out.tar.zst`
      const { seen, deps } = failing()
      await withProcesses(archivingHost(output), async (calls) => {
        await withFetch(toWebhook, async (requests) => {
          await withUid(1000, async () => {
            const outcome = await runCaptured(() =>
              backup({ yes: true, output, webhook: WEBHOOK }, deps)
            )
            assertEquals(outcome.exit, null, outcome.output)
            const tar = archiveCall(calls)
            assert(tar, 'no tar call')
            const excludes = excludesIn(tar.args)
            assert(excludes.includes(MINE), 'the keys found as the user stay')
            for (const dir of unlisted) {
              assert(excludes.includes(dir), `tar: ${dir} is excluded whole`)
            }
            assertStringIncludes(outcome.output, 'could not run as root')
            const report = outcome.output.slice(
              outcome.output.indexOf('Left out of this backup'),
            )
            const text = posted(requests).join('\n')
            for (const dir of unlisted) {
              assertStringIncludes(outcome.output, dir)
              assertStringIncludes(report, `${dir}  (the whole directory`)
              assertStringIncludes(text, `${dir}  (the whole directory`)
            }
          })
        })
      })
      assertEquals(seen, { asUser: 1, asRoot: 1, unlisted: 1 })
    }))

  // rsync under sudo: the same
  await withEnv(cleanBackupEnv, async () => {
    const { seen, deps } = failing()
    await withProcesses(migrationHost, async (calls) => {
      await withUid(1000, async () => {
        const outcome = await runCaptured(() =>
          migrate({
            to: 'root@new-server',
            yes: true,
            skipReboot: true,
            ...deps,
          })
        )
        assertEquals(outcome.error, undefined, outcome.output)
        assertStringIncludes(outcome.output, 'could not run as root')
        for (const dir of unlisted) assertStringIncludes(outcome.output, dir)
      })
      const rsync = calls.find((c) => c.args.includes('-aHAXSx'))
      assert(rsync, 'rsync was not started')
      const excludes = excludesIn(rsync.args)
      assert(excludes.includes(MINE))
      for (const dir of unlisted) {
        assert(excludes.includes(dir), `rsync: ${dir} is excluded whole`)
      }
    })
    assertEquals(seen, { asUser: 1, asRoot: 1, unlisted: 1 })
  })

  // no sudo, no fallback: tar and rsync run as the user, who cannot read those directories either
  await withEnv(cleanBackupEnv, () =>
    withHome(null, async (home) => {
      const output = `${home}/out.tar.zst`
      const { seen, deps } = failing()
      await withProcesses(archivingHost(output), async (calls) => {
        await withUid(0, async () => {
          const outcome = await runCaptured(() =>
            backup({ yes: true, output }, deps)
          )
          assertEquals(outcome.exit, null, outcome.output)
          const tar = archiveCall(calls)
          assert(tar)
          for (const dir of unlisted) {
            assertFalse(excludesIn(tar.args).includes(dir), `uid 0: ${dir}`)
          }
        })
      })
      assertEquals(seen, { asUser: 1, asRoot: 0, unlisted: 0 })
    }))
})

Deno.test('n9: the search runs as the user always, and as root only under sudo; when root fails the unlisted directories are the fallback', async () => {
  assert(searchSshKeys, 'excludes.ts does not export searchSshKeys')
  const fail = new Error('sudo: a password is required')

  // not under sudo: the user's keys alone
  const plain = countedSearches({
    asUser: ['/b', '/a', '/a'],
    asRoot: ['/root'],
  })
  assertEquals(
    await searchSshKeys({
      underSudo: false,
      find: plain.deps.findPrivateKeys,
      findAsRoot: plain.deps.findPrivateKeysAsRoot,
      findUnlisted: plain.deps.findUnlistedSshDirs,
    }),
    { keys: ['/a', '/b'], wholeDirs: [], rootSearchFailed: false },
  )
  assertEquals(plain.seen, { asUser: 1, asRoot: 0, unlisted: 0 })

  // under sudo: both, together
  const both = countedSearches({
    asUser: ['/b', '/a'],
    asRoot: ['/a', '/root'],
  })
  assertEquals(
    await searchSshKeys({
      underSudo: true,
      find: both.deps.findPrivateKeys,
      findAsRoot: both.deps.findPrivateKeysAsRoot,
      findUnlisted: both.deps.findUnlistedSshDirs,
    }),
    { keys: ['/a', '/b', '/root'], wholeDirs: [], rootSearchFailed: false },
  )
  assertEquals(both.seen, { asUser: 1, asRoot: 1, unlisted: 0 })

  // under sudo, root fails (thrown, or rejected): the unlisted directories
  for (const rejected of [false, true]) {
    const failed = countedSearches({
      asUser: ['/a'],
      asRoot: fail,
      unlisted: ['/home/bob/.ssh', '/home/bob/.ssh', '/root/.ssh'],
    })
    const search = await searchSshKeys({
      underSudo: true,
      find: failed.deps.findPrivateKeys,
      findAsRoot: rejected
        ? () => Promise.reject(fail)
        : failed.deps.findPrivateKeysAsRoot,
      findUnlisted: failed.deps.findUnlistedSshDirs,
    })
    assertEquals(search, {
      keys: ['/a'],
      wholeDirs: ['/home/bob/.ssh', '/root/.ssh'],
      rootSearchFailed: true,
    }, `rejected=${rejected}`)
    assertEquals(failed.seen.unlisted, 1)
  }
})

Deno.test('n10: the search as root finds what the search as the user finds: one classification, run through sh, find and head', async () => {
  assert(
    findPrivateKeysAsRoot,
    'excludes.ts does not export findPrivateKeysAsRoot',
  )
  assert(findPrivateKeys, 'excludes.ts does not export findPrivateKeys')
  const root = await Deno.makeTempDir({ prefix: 'slv-ssh-root-' })
  const locked = `${root}/home/alice/.ssh/locked`
  try {
    const put = async (path: string, text: string) => {
      await Deno.mkdir(`${root}${path.slice(0, path.lastIndexOf('/'))}`, {
        recursive: true,
      })
      await Deno.writeTextFile(`${root}${path}`, text)
    }
    const alice = '/home/alice/.ssh'
    await put(`${alice}/mykey`, OPENSSH_KEY)
    await put(`${alice}/id_ed25519`, OPENSSH_KEY)
    await put(`${alice}/sp ace`, OPENSSH_KEY)
    await put(`${alice}/odd\nname key`, OPENSSH_KEY)
    await put(
      `${alice}/old.pem`,
      'Bag Attributes\n-----BEGIN RSA PRIVATE KEY-----\nMIIEow\n',
    )
    await put(`${alice}/deploy.ppk`, 'PuTTY-User-Key-File-3: ssh-ed25519\n')
    await put(`${alice}/mykey.pub`, PUBLIC_KEY)
    await put(`${alice}/authorized_keys`, PUBLIC_KEY)
    await put(`${alice}/known_hosts`, 'github.com ssh-ed25519 AAAAC3Example\n')
    await put(`${alice}/server.crt`, '-----BEGIN CERTIFICATE-----\nMIIDdz\n')
    await put(`${alice}/keys/prod`, OPENSSH_KEY)
    await Deno.symlink('mykey', `${root}${alice}/link`)
    await put('/root/.ssh/rootkey', OPENSSH_KEY)
    await Deno.mkdir(`${root}/home/carol`, { recursive: true })
    const expected = [
      `${alice}/deploy.ppk`,
      `${alice}/id_ed25519`,
      `${alice}/mykey`,
      `${alice}/odd\nname key`,
      `${alice}/old.pem`,
      `${alice}/sp ace`,
      '/root/.ssh/rootkey',
    ]
    // a file nobody here can read: a key to both searches (root reads anything)
    if (Deno.uid() !== 0) {
      await put(`${alice}/locked`, 'cannot be read')
      await Deno.chmod(locked, 0o000)
      expected.push(`${alice}/locked`)
    }
    expected.sort()

    // the real processes, with no sudo in front of them
    assertEquals(await findPrivateKeysAsRoot({ root, sudo: [] }), expected)
    assertEquals(await findPrivateKeys({ root }), expected)
  } finally {
    await Deno.chmod(locked, 0o600).catch(() => {})
    await Deno.remove(root, { recursive: true })
  }
})

Deno.test('n11: the search as root runs through sudo -n, lists with one command, and reads only the first bytes of each file', async () => {
  assert(
    findPrivateKeysAsRoot,
    'excludes.ts does not export findPrivateKeysAsRoot',
  )
  const files = [
    '/home/alice/.ssh/mykey',
    '/home/alice/.ssh/mykey.pub',
    '/home/alice/.ssh/known_hosts',
    '/home/alice/.ssh/locked',
    '/home/alice/.ssh/notes',
  ]
  await withProcesses((call) => {
    if (call.args[1] === 'sh') {
      return { stdout: files.map((file) => `${file}\0`).join('') }
    }
    const path = call.args[call.args.length - 1]
    if (path.endsWith('/locked') || path.endsWith('/known_hosts')) {
      return { success: false, stderr: 'head: cannot open: Permission denied' }
    }
    return {
      stdout: path.endsWith('/mykey')
        ? OPENSSH_KEY
        : path.endsWith('.pub')
        ? PUBLIC_KEY
        : 'only text\n',
    }
  }, async (calls) => {
    assertEquals(await findPrivateKeysAsRoot(), [
      '/home/alice/.ssh/locked',
      '/home/alice/.ssh/mykey',
    ])
    // every command is `sudo -n ...`: it never asks for a password
    for (const call of calls) {
      assertEquals(call.command, 'sudo')
      assertEquals(call.args[0], '-n')
    }
    // one listing, then one read per file, of 8192 bytes at most
    assertEquals(calls[0].args.slice(0, 3), ['-n', 'sh', '-c'])
    assertEquals(calls.length, 1 + files.length)
    for (const [i, file] of files.entries()) {
      assertEquals(calls[i + 1].args, ['-n', 'head', '-c', '8192', '--', file])
    }
  })

  // sudo refused: the search rejects, which is what makes a run fall back
  await withProcesses(
    () => ({ success: false, stderr: 'sudo: a password is required' }),
    async () => {
      await assertRejects(
        () => findPrivateKeysAsRoot(),
        Error,
        'a password is required',
      )
    },
  )
})

Deno.test('n12: .ssh directories this user cannot list are found, and one that does not exist is not', async () => {
  assert(findUnlistedSshDirs, 'excludes.ts does not export findUnlistedSshDirs')
  if (Deno.uid() === 0) return // root lists every directory
  const root = await Deno.makeTempDir({ prefix: 'slv-ssh-unlisted-' })
  try {
    await Deno.mkdir(`${root}/home/alice/.ssh`, { recursive: true })
    await Deno.mkdir(`${root}/home/bob/.ssh`, { recursive: true })
    await Deno.chmod(`${root}/home/bob/.ssh`, 0o000)
    await Deno.mkdir(`${root}/home/carol`, { recursive: true })
    assertEquals(await findUnlistedSshDirs({ root }), ['/home/bob/.ssh'])
  } finally {
    await Deno.chmod(`${root}/home/bob/.ssh`, 0o700).catch(() => {})
    await Deno.remove(root, { recursive: true })
  }
})

// ---------------------------------------------------------------------------
// 12. An exclude value is a path, rsync reads the secret entries first, and
//     tar reads them per path component
// ---------------------------------------------------------------------------

/** The program runner as it is before a test replaces Deno.Command. */
const RealCommand = Deno.Command

/** The first line a program prints for --version, or null if it is not installed or not the one asked for. */
const versionOf = async (
  name: string,
  banner: RegExp,
): Promise<string | null> => {
  try {
    const result = await new RealCommand(name, {
      args: ['--version'],
      stdout: 'piped',
      stderr: 'null',
    }).output()
    const first = new TextDecoder().decode(result.stdout).split('\n')[0]
    return result.success && banner.test(first) ? first : null
  } catch {
    return null
  }
}

/** Run a program for real, from inside the handler of a replaced Deno.Command. */
const runReal = (command: string, args: string[]): Reply => {
  const result = new RealCommand(command, {
    args,
    stdout: 'piped',
    stderr: 'piped',
  }).outputSync()
  return {
    success: result.success,
    code: result.code,
    stdout: new TextDecoder().decode(result.stdout),
    stderr: new TextDecoder().decode(result.stderr),
  }
}

/** Text without the colour codes of the terminal. */
const withoutColors = (text: string): string =>
  text.replace(new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g'), '')

/** Values that rsync reads as a filter rule, or that start like one. */
const FILTER_RULES = [
  '+ /home/*/.ssh/id_*',
  '+ **',
  '!',
  '- foo',
  '-x',
  '+x',
  ' + /home/*/*keypair*.json',
  '!/srv/a',
]

/** Paths and globs that are not filter rules, however they look. */
const PLAIN_PATTERNS = [
  '.cache',
  '*.log',
  '/var/cache/**',
  './-name',
  'a+b',
  'a-b',
  'a!b',
  '/srv/data/-x',
]

Deno.test('x1: backup refuses an exclude or include value that starts with +, - or !, from the options and from SLV_BACKUP_EXCLUDES, before anything runs, for every tool', async () => {
  const channels: [string, (v: string) => Record<string, unknown>][] = [
    ['--exclude', (v) => ({ exclude: [v] })],
    ['--include', (v) => ({ include: [v] })],
    ['SLV_BACKUP_EXCLUDES', () => ({})],
  ]
  const modes: [string, Record<string, unknown>][] = [
    ['tar', {}],
    ['restic', { restic: true }],
    ['--list-excludes', { listExcludes: true }],
    ['--cron with restic', { cron: 'daily', restic: true }],
  ]
  for (const value of FILTER_RULES) {
    for (const [source, options] of channels) {
      for (const [mode, modeOptions] of modes) {
        const label = `${source} ${JSON.stringify(value)}, ${mode}`
        const env = source === 'SLV_BACKUP_EXCLUDES'
          ? { ...cleanBackupEnv, SLV_BACKUP_EXCLUDES: `/srv/a, ${value}` }
          : cleanBackupEnv
        await withEnv(env, async () => {
          await withHome(null, async () => {
            await withProcesses(asHost('node-1'), async (calls) => {
              await withFetch(() => json({}, 500), async (requests) => {
                await withUid(0, async () => {
                  const outcome = await runCaptured(() =>
                    backup({ yes: true, ...modeOptions, ...options(value) })
                  )
                  assertEquals(outcome.error, undefined, label)
                  assertEquals(outcome.exit, 1, `${label}: ${outcome.output}`)
                  const shown = source === 'SLV_BACKUP_EXCLUDES'
                    ? value.trim()
                    : value
                  assertStringIncludes(outcome.output, source)
                  assertStringIncludes(outcome.output, JSON.stringify(shown))
                  assertStringIncludes(outcome.output, 'refused')
                })
                // no process started, nothing requested, nothing archived
                assertEquals(calls.length, 0, `${label}: a process started`)
                assertEquals(requests.length, 0, `${label}: a request`)
              })
            })
          })
        })
      }
    }
  }

  // an unattended run has nobody watching its output: the webhook hears about it, once
  await withEnv(cleanBackupEnv, async () => {
    await withHome(null, async () => {
      await withProcesses(asHost('node-1'), async (calls) => {
        await withFetch(toWebhook, async (requests) => {
          await withUid(0, async () => {
            const outcome = await runCaptured(() =>
              backup({
                yes: true,
                restic: true,
                exclude: ['+ /home/*/.ssh/id_*'],
                webhook: WEBHOOK,
              })
            )
            assertEquals(outcome.exit, 1, outcome.output)
          })
          const messages = posted(requests)
          assertEquals(messages.length, 1, 'webhook posts')
          assertStringIncludes(messages[0], 'Refused')
          assertStringIncludes(messages[0], '--exclude')
          assertEquals(requests.filter((r) => r.url !== WEBHOOK).length, 0)
        })
        assertEquals(
          calls.filter((c) => c.command !== 'hostname').length,
          0,
          'a process other than hostname started',
        )
      })
    })
  })

  // the command line reaches the same refusal
  await withEnv(cleanBackupEnv, async () => {
    await withProcesses(asHost('node-1'), async (calls) => {
      const outcome = await runCaptured(() =>
        backupCmd.parse(['create', '--yes', '--exclude', '!'])
      )
      assertEquals(outcome.exit, 1, outcome.output)
      assertEquals(calls.length, 0)
    })
  })
})

Deno.test('x1: paths and globs are not refused, whatever characters they hold, and reach the tar command', async () => {
  for (const value of PLAIN_PATTERNS) {
    for (
      const [source, options] of [
        ['--exclude', { exclude: [value] }],
        ['--include', { include: [value] }],
        ['SLV_BACKUP_EXCLUDES', {}],
      ] as const
    ) {
      const label = `${source} ${JSON.stringify(value)}`
      const env = source === 'SLV_BACKUP_EXCLUDES'
        ? { ...cleanBackupEnv, SLV_BACKUP_EXCLUDES: value }
        : cleanBackupEnv
      await withEnv(env, async () => {
        await withHome(null, async (home) => {
          const output = `${home}/out.tar.gz`
          await withProcesses(archivingHost(output), async (calls) => {
            await withUid(0, async () => {
              const outcome = await runCaptured(() =>
                backup({ yes: true, output, ...options })
              )
              assertEquals(outcome.error, undefined, label)
              assertEquals(outcome.exit, null, `${label}: ${outcome.output}`)
            })
            const tar = archiveCall(calls)
            assert(tar, `${label}: no tar call`)
            // an exclude is kept; an include only lifts what the defaults hold
            assertEquals(
              excludesIn(tar.args).includes(value),
              source !== '--include',
              label,
            )
          })
        })
      })
    }
  }
})

Deno.test('x2: slv migrate linux refuses an exclude or include value that starts with +, - or !, through the function and the command, before anything runs', async () => {
  const channels: [string, (v: string) => Record<string, unknown>][] = [
    ['--exclude', (v) => ({ extraExcludes: [v] })],
    ['--include', (v) => ({ extraIncludes: [v] })],
    ['SLV_BACKUP_EXCLUDES', () => ({})],
  ]
  for (const value of FILTER_RULES) {
    for (const [source, options] of channels) {
      const label = `${source} ${JSON.stringify(value)}`
      const env = source === 'SLV_BACKUP_EXCLUDES'
        ? { ...cleanBackupEnv, SLV_BACKUP_EXCLUDES: `/srv/a, ${value}` }
        : cleanBackupEnv
      const shown = source === 'SLV_BACKUP_EXCLUDES' ? value.trim() : value
      await withEnv(env, async () => {
        await withProcesses(migrationHost, async (calls) => {
          await withUid(0, async () => {
            let result: boolean | undefined
            const outcome = await runCaptured(async () => {
              result = await migrate({
                to: 'root@new-server',
                yes: true,
                skipReboot: true,
                ...options(value),
              })
            })
            assertEquals(outcome.error, undefined, label)
            assertEquals(result, false, `${label}: ${outcome.output}`)
            assertStringIncludes(outcome.output, source)
            assertStringIncludes(outcome.output, JSON.stringify(shown))
            assertEquals(calls.length, 0, `${label}: a process started`)

            // --list-excludes shows nothing for such a value either
            const listing = await runCaptured(async () => {
              result = await migrate({ listExcludes: true, ...options(value) })
            })
            assertEquals(result, false, `${label}: --list-excludes`)
            assertFalse(listing.output.includes('Current exclude list'))

            // the command: refused before it asks where to migrate to
            const flags = source === '--exclude'
              ? ['--exclude', value]
              : source === '--include'
              ? ['--include', value]
              : []
            const command = await runCaptured(() =>
              migrateLinuxCmd.parse(['--yes', ...flags])
            )
            assertEquals(command.exit, 1, `${label}: ${command.output}`)
            assertStringIncludes(command.output, JSON.stringify(shown))
            assertEquals(calls.length, 0, `${label}: the command started one`)
          })
        })
      })
    }
  }
})

Deno.test('x2: slv migrate linux takes paths and globs for --exclude, and its help says what is refused', async () => {
  await withEnv(
    { ...cleanBackupEnv, SLV_BACKUP_EXCLUDES: '/var/cache/**' },
    async () => {
      await withProcesses(migrationHost, async (calls) => {
        await withUid(0, async () => {
          const outcome = await runCaptured(() =>
            migrate({
              to: 'root@new-server',
              yes: true,
              skipReboot: true,
              extraExcludes: PLAIN_PATTERNS,
            })
          )
          assertEquals(outcome.error, undefined, outcome.output)
          const rsync = calls.find((c) => c.args.includes('-aHAXSx'))
          assert(rsync, `rsync was not started: ${outcome.output}`)
          const excludes = excludesIn(rsync.args)
          assertEquals(
            missing(excludes, [...PLAIN_PATTERNS, '/var/cache/**']),
            [],
          )
        })
      })
    },
  )
  for (const command of [migrateLinuxCmd, backupCmd.getCommand('create')!]) {
    const help = command.getOptions().filter((o) =>
      o.name === 'exclude' || o.name === 'include'
    )
    assertEquals(help.length, 2)
    for (const option of help) {
      assertMatch(
        option.description,
        /starts with \+, - or !.*refused/,
        `${command.getName()} --${option.name}`,
      )
    }
  }
})

Deno.test('x3: the lists are not built from a value that is a filter rule, and the plain values are kept', () => {
  for (const value of FILTER_RULES) {
    for (
      const options of [
        { extraExcludes: [value] },
        { extraIncludes: [value] },
      ]
    ) {
      for (const tool of ['tar', 'restic', 'rsync']) {
        assertThrows(
          () => buildList({ tool, ...options }),
          FilterSyntaxError,
          'refused',
        )
      }
    }
  }
  const plain = buildExcludeList({
    tool: 'rsync',
    extraExcludes: PLAIN_PATTERNS,
  })
  assertEquals(missing(plain, PLAIN_PATTERNS), [])
})

/** The key-material entries of the backup lists before the shared definition, in order. */
const KEY_MATERIAL_LIST = [
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
  '/etc/shadow-',
  '/etc/gshadow',
  '/etc/gshadow-',
  '/etc/wireguard',
  '/etc/doublezero/keys',
  '/etc/ssl/private',
  '/etc/nginx/ssl',
]

/** The wallet entries of those lists, in order. */
const WALLET_LIST = [
  '/root/slv/wallet*.json*',
  '/root/slv/**/wallet*.json*',
  '/home/*/slv/wallet*.json*',
  '/home/*/slv/**/wallet*.json*',
  '/root/.slv/wallet-rescue',
  '/home/*/.slv/wallet-rescue',
  '/root/.config/solana/id.json',
  '/home/*/.config/solana/id.json',
]

/** The entries a tool leaves secrets out with, for a run that found nothing else. */
const secretsOf = (tool: string): string[] => secretExcludes!(tool)

Deno.test('x4: in the rsync list every secret entry comes before every other entry; the tar and restic lists are the ones they were', async () => {
  assert(secretExcludes, 'excludes.ts does not export secretExcludes')
  const found = ['/home/alice/.ssh/deploy_key']
  const whole = ['/home/bob/.ssh']
  await withEnv(
    { ...cleanBackupEnv, SLV_BACKUP_EXCLUDES: '/srv/cache/*' },
    () => {
      const rsync = buildList({
        tool: 'rsync',
        includeSSH: false,
        extraExcludes: ['/srv/extra', '*.log'],
        privateKeys: found,
        unlistedSshDirs: whole,
      })
      const secrets = [...secretsOf('rsync'), ...found, ...whole]
      // rsync applies the first rule that matches
      assertEquals(rsync.slice(0, secrets.length), secrets)
      const rest = rsync.slice(secrets.length)
      assertEquals(
        rest.filter((e) => secrets.includes(e)),
        [],
        'a secret entry after the others',
      )
      for (
        const entry of [
          ...DEFAULT_EXCLUDES,
          ...SSH_EXCLUDES,
          '/srv/cache/*',
          '/srv/extra',
          '*.log',
        ]
      ) {
        assert(rest.includes(entry), `rsync list lacks ${entry}`)
      }

      // tar and restic: the defaults, the operator's entries, then the secret ones, as before
      for (const tool of ['tar', 'restic']) {
        const list = buildList({
          tool,
          includeSSH: true,
          extraExcludes: ['/srv/extra', '*.log'],
          privateKeys: found,
          unlistedSshDirs: whole,
        })
        assertEquals(list, [
          ...DEFAULT_EXCLUDES,
          '/srv/cache/*',
          '/srv/extra',
          '*.log',
          ...KEY_MATERIAL_LIST,
          ...(tool === 'tar' ? WALLET_LIST : []),
          ...found,
          ...whole,
        ], tool)
      }
    },
  )

  // nothing from the operator
  assertEquals(buildList({ tool: 'tar', includeSSH: true }), [
    ...DEFAULT_EXCLUDES,
    ...KEY_MATERIAL_LIST,
    ...WALLET_LIST,
  ])
  assertEquals(buildList({ tool: 'restic', includeSSH: true }), [
    ...DEFAULT_EXCLUDES,
    ...KEY_MATERIAL_LIST,
  ])
  assertEquals(buildList({ tool: 'rsync', includeSSH: false }), [
    ...KEY_MATERIAL_LIST,
    ...WALLET_LIST,
    ...DEFAULT_EXCLUDES,
    ...SSH_EXCLUDES,
  ])

  // slv migrate linux hands rsync that order
  await withEnv(cleanBackupEnv, async () => {
    await withProcesses(migrationHost, async (calls) => {
      await withUid(0, async () => {
        const outcome = await runCaptured(() =>
          migrate({
            to: 'root@new-server',
            yes: true,
            skipReboot: true,
            extraExcludes: ['/srv/extra', '*.log'],
          })
        )
        assertEquals(outcome.error, undefined, outcome.output)
      })
      const rsync = calls.find((c) => c.args.includes('-aHAXSx'))
      assert(rsync, 'rsync was not started')
      const excludes = excludesIn(rsync.args)
      const secrets = secretsOf('rsync')
      assertEquals(excludes.slice(0, secrets.length), secrets)
      assert(excludes.indexOf('/srv/extra') >= secrets.length)
    })
  })
})

// The tree of a host that holds key material, wallets and files that only look like them

const HOST_KEYS = [
  '/home/alice/validator-keypair.json',
  '/home/alice/identity.json',
  '/home/alice/.slv/keys/main.json',
  '/home/alice/.slv/api.yml',
  '/home/alice/.ssh/id_ed25519',
  '/home/alice/.ssh/id_ed25519.pub',
  '/root/.ssh/id_rsa',
  '/etc/shadow',
  '/etc/ssh/ssh_host_ed25519_key',
  '/etc/wireguard/wg0.conf',
  '/etc/ssl/private/site.key',
  '/etc/nginx/ssl/site.key',
]

/** A private key whose name says nothing: only its header does. */
const HOST_CUSTOM_KEY = '/home/alice/.ssh/deploy_key'

const HOST_WALLETS = [
  '/home/alice/slv/wallet.json',
  '/home/alice/slv/wallet.json.bak.1710000000',
  '/home/alice/slv/bot/x/wallet.json',
  '/home/alice/slv/a/b/c/wallet-2.json',
  '/home/alice/.slv/wallet-rescue/1700-bot/wallet.json',
  '/home/alice/.config/solana/id.json',
  '/root/slv/bot/wallet.json',
]

/** Files that are not key material and not wallets, some of them named like them. */
const HOST_ORDINARY = [
  '/home/alice/notes.txt',
  '/home/alice/.ssh/authorized_keys',
  '/home/alice/.ssh/known_hosts',
  '/home/alice/.config/identity-svc/settings.json',
  '/home/alice/app/node_modules/@azure/identity/package.json',
  '/home/alice/slv/walletapp/config.json',
  '/home/alice/slv/bot/config.json',
  '/home/alice/keys/nested-validator-keypair.json',
  '/home/alice/projects/p1/other/keep',
  '/etc/hostname',
  '/etc/ssh/ssh_host_ed25519_key.pub',
  '/root/notes.txt',
]

// Files the operator leaves out of a tar archive with an --exclude that holds a `**` (see x7)
const HOST_OPERATOR_EXCLUDED = ['/home/alice/projects/p1/sub/target/obj']

/** Files the operator leaves out of a migrate copy with the entries of the test. */
const HOST_MIGRATE_EXCLUDED = [
  '/home/alice/.cache/blob',
  '/home/alice/app/debug.log',
  '/srv/cache/blob',
  '/var/cache/blob',
]

/** A tree of stand-ins that stands for the root of a host. */
const makeHost = async (
  root: string,
  paths: readonly string[],
): Promise<void> => {
  for (const path of paths) {
    await Deno.mkdir(`${root}${path.slice(0, path.lastIndexOf('/'))}`, {
      recursive: true,
    })
    await Deno.writeTextFile(
      `${root}${path}`,
      path === HOST_CUSTOM_KEY ? OPENSSH_KEY : `stand-in for ${path}\n`,
    )
  }
}

/** The files under a directory, from its root, sorted. */
const filesUnder = async (dir: string, prefix = ''): Promise<string[]> => {
  const files: string[] = []
  for await (const entry of Deno.readDir(`${dir}${prefix}`)) {
    const path = `${prefix}/${entry.name}`
    if (entry.isDirectory) files.push(...await filesUnder(dir, path))
    else files.push(path)
  }
  return files.sort()
}

/** Whether `path` is one of `entries` or lies below one. */
const isOrBelow = (path: string, entries: readonly string[]): boolean =>
  entries.some((entry) => path === entry || path.startsWith(`${entry}/`))

Deno.test('x5: the real rsync, run on a tree of stand-ins with the list migrate builds, copies none of the key material and wallets', async () => {
  const version = await versionOf('rsync', /^rsync\s+version/)
  if (!version) {
    console.log('x5 skipped: rsync is not installed')
    return
  }
  const dir = await Deno.makeTempDir({ prefix: 'slv-rsync-' })
  try {
    const standIns = [...HOST_KEYS, HOST_CUSTOM_KEY, ...HOST_WALLETS]
    const src = `${dir}/src`
    await makeHost(src, [
      ...standIns,
      ...HOST_ORDINARY,
      ...HOST_MIGRATE_EXCLUDED,
    ])

    /** The files rsync copies with these exclude entries, as given. */
    const copyOf = async (excludes: readonly string[]): Promise<string[]> => {
      const dst = await Deno.makeTempDir({ dir, prefix: 'copy-' })
      const result = runReal('rsync', [
        '-a',
        ...excludes.flatMap((e) => ['--exclude', e]),
        `${src}/`,
        `${dst}/`,
      ])
      assert(result.success, `rsync: ${result.stderr}`)
      return await filesUnder(dst)
    }
    const carried = (copied: string[]): string[] =>
      copied.filter((f) => standIns.includes(f))

    // The sandbox sees a leak: a rule ahead of the secret entries lets a key through,
    const secrets = secretsOf('rsync')
    assert(
      carried(await copyOf(['+ /home/*/.ssh/id_*', ...secrets])).includes(
        '/home/alice/.ssh/id_ed25519',
      ),
      'control: an include ahead of the secret entries did not copy the key',
    )
    // and so does a rule that clears the list, even after them
    assert(
      carried(await copyOf([...secrets, '!'])).includes(
        '/home/alice/.ssh/id_ed25519',
      ),
      'control: a clear-list rule after the secret entries did not copy the key',
    )
    // an include after the secret entries lifts nothing they name; the key no entry names is copied
    assertEquals(carried(await copyOf([...secrets, '+ /home/*/.ssh/id_*'])), [
      HOST_CUSTOM_KEY,
    ])

    // Through slv migrate linux, with the entries an operator may give
    const cases: [string, Record<string, unknown>, string | undefined][] = [
      ['no entries', {}, undefined],
      [
        'plain entries',
        { extraExcludes: ['.cache', '*.log', '/srv/cache/**'] },
        '/var/cache/**',
      ],
      [
        '--include of key material and wallets',
        { extraIncludes: [...KEY_MATERIAL_LIST, ...WALLET_LIST] },
        undefined,
      ],
    ]
    const migrated = async (
      options: Record<string, unknown>,
      env: string | undefined,
    ): Promise<{ copied: string[]; result: boolean | undefined }> => {
      const dst = await Deno.makeTempDir({ dir, prefix: 'migrated-' })
      let result: boolean | undefined
      await withEnv(
        { ...cleanBackupEnv, SLV_BACKUP_EXCLUDES: env },
        async () => {
          await withProcesses((call) => {
            if (call.args.includes('-aHAXSx')) {
              return runReal('rsync', [
                '-a',
                ...excludesIn(call.args).flatMap((e) => ['--exclude', e]),
                `${src}/`,
                `${dst}/`,
              ])
            }
            return migrationHost(call)
          }, async () => {
            await withUid(0, async () => {
              const outcome = await runCaptured(async () => {
                result = await migrate({
                  to: 'root@new-server',
                  yes: true,
                  skipReboot: true,
                  // the keys the search finds on this tree
                  findPrivateKeys: () => [HOST_CUSTOM_KEY],
                  ...options,
                })
              })
              assertEquals(outcome.error, undefined, outcome.output)
            })
          })
        },
      )
      return { copied: await filesUnder(dst), result }
    }
    const sshAccess = (f: string) =>
      f.endsWith('/authorized_keys') || f.startsWith('/etc/ssh/ssh_host_')
    for (const [name, options, env] of cases) {
      const { copied, result } = await migrated(options, env)
      assertEquals(result, true, name)
      assertEquals(carried(copied), [], `${name}: stand-ins were copied`)
      // everything else is copied, less the operator's entries and the destination's own SSH access
      const expected = [
        ...HOST_ORDINARY.filter((f) => !sshAccess(f)),
        ...(name === 'plain entries' ? [] : HOST_MIGRATE_EXCLUDED),
      ].sort()
      assertEquals(copied, expected, name)
    }

    // A value that is a filter rule never reaches rsync: migrate refuses it
    for (const value of FILTER_RULES) {
      const { copied, result } = await migrated(
        { extraExcludes: [value] },
        undefined,
      )
      assertEquals(result, false, JSON.stringify(value))
      assertEquals(
        copied,
        [],
        `${JSON.stringify(value)}: rsync copied something`,
      )
    }
  } finally {
    await Deno.remove(dir, { recursive: true })
  }
})

Deno.test('x6: the tar command reads the secret entries per path component and the other entries as tar reads them; the restore reads its entries per path component', async () => {
  await withEnv(cleanBackupEnv, async () => {
    await withHome(null, async (home) => {
      const output = `${home}/out.tar.gz`
      await withProcesses(archivingHost(output), async (calls) => {
        await withUid(0, async () => {
          const outcome = await runCaptured(() =>
            backup({
              yes: true,
              output,
              exclude: ['/srv/extra', '/home/*/projects/**/target'],
            }, { findPrivateKeys: () => ['/home/alice/.ssh/deploy_key'] })
          )
          assertEquals(outcome.exit, null, outcome.output)
        })
        const tar = archiveCall(calls)
        assert(tar, 'no tar call')
        const at = tar.args.indexOf(TAR_PER_COMPONENT)
        assert(at > 0, 'the option is missing')
        assertEquals(tar.args.lastIndexOf(TAR_PER_COMPONENT), at, 'once')
        // before the option: the defaults and the operator's entries, read as tar reads them
        assertEquals(excludesIn(tar.args.slice(0, at)), [
          ...DEFAULT_EXCLUDES,
          '/srv/extra',
          '/home/*/projects/**/target',
        ])
        // after it: each secret entry, an entry that reaches any depth as one pattern per number of directories, then the archive itself
        const secrets = [...secretsOf('tar'), '/home/alice/.ssh/deploy_key']
        const patterns = [...new Set(secrets.flatMap(perComponentPatterns))]
        assertEquals(excludesIn(tar.args.slice(at)), [...patterns, output])
        assertEquals(patterns.filter((p) => p.includes('**')), [])
        assertEquals(
          missing(patterns, KEY_MATERIAL_LIST),
          [],
          'a key-material entry is gone',
        )
        for (const entry of WALLET_LIST.filter((e) => !e.includes('**'))) {
          assert(patterns.includes(entry), entry)
        }
        // the option comes before the file that is archived
        assert(at < tar.args.indexOf('-cf'))
      })
    })
  })

  // the restore: the option follows --anchored and comes before every pattern
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
            assertEquals(outcome.exit, null, outcome.output)
            const tar = tarExtractCall(calls.slice(before))
            assert(tar, 'tar did not run')
            const anchored = tar.args.indexOf('--anchored')
            assertEquals(tar.args[anchored + 1], TAR_PER_COMPONENT)
            assert(anchored + 1 < tar.args.indexOf('--exclude'))
            assertEquals(
              excludesIn(tar.args).filter((e) => e.includes('**')),
              [],
              'a pattern that reaches any depth',
            )
          }
        })
      })
    })
  })
})

/** The tar arguments of a backup, aimed at a tree that stands for `/`: patterns and paths start at `root`, and the members are named from the root of the tree, as an archive of `/` names them. */
const aimedAtTree = (tarArgs: string[], root: string): string[] => {
  const args: string[] = []
  for (let i = 0; i < tarArgs.length; i++) {
    if (tarArgs[i] === '--exclude') {
      const pattern = tarArgs[++i]
      args.push(
        '--exclude',
        pattern.startsWith('/') ? `${root}${pattern}` : pattern,
      )
    } else {
      args.push(tarArgs[i])
    }
  }
  assertEquals(args.pop(), '/', 'the backup archives /')
  const prefix = `${root.slice(1)}/`.replace(/[.[\]*^$\\,]/g, '\\$&')
  const top = [...Deno.readDirSync(root)].map((e) => `${root}/${e.name}`)
  return [...args, `--transform=s,^${prefix},,`, ...top]
}

/** What a run of backupAction did with the real tar on the tree under `root`. */
const tarBackupOf = async (
  root: string,
  archive: string,
  options: Record<string, unknown> = {},
): Promise<Awaited<ReturnType<typeof runCaptured>>> => {
  let outcome: Awaited<ReturnType<typeof runCaptured>> | undefined
  await withEnv(cleanBackupEnv, async () => {
    await withHome(null, async () => {
      await withProcesses((call) => {
        if (call.command === 'which') return { success: false } // no zstd: a gzip archive
        if (call.command === 'hostname') return { stdout: 'node-1\n' }
        if (call.args.includes('-cf')) {
          // sh -c 'umask 077 && exec tar "$@"' tar <tar arguments>
          return runReal('sh', [
            '-c',
            call.args[1],
            'tar',
            ...aimedAtTree(call.args.slice(3), root),
          ])
        }
      }, async () => {
        await withUid(0, async () => {
          outcome = await runCaptured(() =>
            backup({ yes: true, output: archive, ...options }, {
              findFiles: (patterns) => findExistingPaths!(patterns, { root }),
              findPrivateKeys: () => findPrivateKeys!({ root }),
            })
          )
        })
      })
    })
  })
  assert(outcome, 'backup did not run')
  return outcome
}

/** What a run of the restore did with the real tar, extracting into `target` and not over `/`. */
const restoreInto = async (
  archive: string,
  target: string,
  options: Record<string, unknown> = {},
): Promise<Awaited<ReturnType<typeof runCaptured>>> => {
  let outcome: Awaited<ReturnType<typeof runCaptured>> | undefined
  await withEnv(cleanBackupEnv, async () => {
    await withHome(null, async () => {
      await withProcesses((call) => {
        if (call.command === 'hostname') return { stdout: 'node-1\n' }
        if (call.command === 'tar' && call.args.includes('-xf')) {
          const args = [...call.args]
          const at = args.indexOf('-C')
          assertEquals(args[at + 1], '/', 'the restore extracts over /')
          args[at + 1] = target
          return runReal('tar', args)
        }
      }, async () => {
        await withUid(0, async () => {
          outcome = await runCaptured(() =>
            restore({ yes: true, ...options }, archive)
          )
        })
      })
    })
  })
  assert(outcome, 'restore did not run')
  return outcome
}

/** The files an archive holds, from the root. */
const archiveFiles = (archive: string): string[] =>
  (runReal('tar', ['-tzf', archive]).stdout ?? '').split('\n')
    .filter((name) => name !== '' && !name.endsWith('/'))
    .map((name) => `/${name}`).sort()

/** The files a backup said it left out, from its output. */
const leftOutReport = (output: string): string[] => {
  const lines = output.split('\n').map((line) => withoutColors(line).trim())
  const start = lines.findIndex((line) =>
    line.includes('Left out of this backup')
  )
  if (start < 0) return []
  const end = lines.findIndex((line, i) =>
    i > start && line.includes('Keep an offline copy')
  )
  return lines.slice(start + 1, end).filter((line) => line !== '')
}

Deno.test('x7: real tar leaves out the key material and wallets and keeps every other file, and the list of files left out is the files tar left out', async () => {
  const version = await versionOf('tar', /GNU tar/)
  if (!version) {
    console.log('x7 skipped: GNU tar is not installed')
    return
  }
  const dir = await Deno.makeTempDir({ prefix: 'slv-tar-' })
  try {
    const root = `${dir}/host`
    const standIns = [...HOST_KEYS, HOST_CUSTOM_KEY, ...HOST_WALLETS]
    await makeHost(root, [
      ...standIns,
      ...HOST_ORDINARY,
      ...HOST_OPERATOR_EXCLUDED,
    ])
    await Deno.mkdir(`${dir}/out`)
    const archive = `${dir}/out/backup-node-1-20260101-000000.tar.gz`
    const run = await tarBackupOf(root, archive, {
      exclude: ['/home/*/projects/**/target'],
    })
    assertEquals(run.error, undefined, run.output)
    assertEquals(run.exit, null, run.output)

    const archived = archiveFiles(archive)
    // every file that is not key material and not a wallet is in the archive
    assertEquals(HOST_ORDINARY.filter((f) => !archived.includes(f)), [])
    // no key and no wallet is
    assertEquals(archived.filter((f) => standIns.includes(f)), [])
    // a pattern of the operator is read as tar reads it: a ** crosses directories
    assertEquals(HOST_OPERATOR_EXCLUDED.filter((f) => archived.includes(f)), [])

    // the list of files left out names exactly the files tar left out
    const everything = await filesUnder(root)
    const reported = leftOutReport(run.output)
    assert(reported.length > 0, `no list of files left out: ${run.output}`)
    assertEquals(
      everything.filter((f) => isOrBelow(f, reported)),
      everything.filter((f) =>
        !archived.includes(f) && !HOST_OPERATOR_EXCLUDED.includes(f)
      ),
    )
    for (const file of standIns) {
      assert(isOrBelow(file, reported), `${file} is not in the list`)
    }
  } finally {
    await Deno.remove(dir, { recursive: true })
  }
})

Deno.test('x8: real tar restores every file an archive holds except the key material, and a file that only looks like key material comes back', async () => {
  const version = await versionOf('tar', /GNU tar/)
  if (!version) {
    console.log('x8 skipped: GNU tar is not installed')
    return
  }
  const dir = await Deno.makeTempDir({ prefix: 'slv-tar-restore-' })
  try {
    const root = `${dir}/host`
    const standIns = [...HOST_KEYS, HOST_CUSTOM_KEY, ...HOST_WALLETS]
    await makeHost(root, [...standIns, ...HOST_ORDINARY])
    await Deno.mkdir(`${dir}/out`)

    // the archive this version makes comes back whole, but for the system identity files
    const made = `${dir}/out/backup-node-1-20260101-000000.tar.gz`
    const run = await tarBackupOf(root, made)
    assertEquals(run.exit, null, run.output)
    const archived = archiveFiles(made)
    const systemIdentity = (f: string) => f.startsWith('/etc/ssh/ssh_host_')
    const first = `${dir}/restored-1`
    await Deno.mkdir(first)
    const restored = await restoreInto(made, first)
    assertEquals(restored.exit, null, restored.output)
    assertEquals(
      await filesUnder(first),
      archived.filter((f) => !systemIdentity(f)),
    )
    for (const file of HOST_ORDINARY.filter((f) => !systemIdentity(f))) {
      assert(archived.includes(file), `${file} is not in the archive`)
    }

    // an archive that holds everything (made by an older version or by hand): the key material stays out
    const full = `${dir}/out/backup-node-1-20260101-000001.tar.gz`
    assert(
      runReal('tar', ['-czf', full, '-C', root, 'home', 'root', 'etc']).success,
    )
    const second = `${dir}/restored-2`
    await Deno.mkdir(second)
    const again = await restoreInto(full, second)
    assertEquals(again.exit, null, again.output)
    // the restore leaves out key material only, so wallets and a key named by its header alone are not asserted
    const notAsserted = (f: string) =>
      HOST_WALLETS.includes(f) || f === HOST_CUSTOM_KEY
    const keyMaterial = HOST_KEYS
    const everything = await filesUnder(root)
    assertEquals(
      (await filesUnder(second)).filter((f) => !notAsserted(f)),
      everything.filter((f) =>
        !notAsserted(f) && !keyMaterial.includes(f) && !systemIdentity(f)
      ),
    )
  } finally {
    await Deno.remove(dir, { recursive: true })
  }
})

Deno.test('x9: tar reads an entry that reaches any depth as one pattern for each number of directories the search goes down', async () => {
  const wallets = perComponentPatterns('/home/*/slv/**/wallet*.json*')
  assertEquals(wallets.length, 9)
  assertEquals(wallets[0], '/home/*/slv/wallet*.json*')
  assertEquals(wallets[1], '/home/*/slv/*/wallet*.json*')
  assertEquals(wallets[8], '/home/*/slv/*/*/*/*/*/*/*/*/wallet*.json*')
  // a ** that ends an entry stands for one directory at least
  assertEquals(perComponentPatterns('/x/**').slice(0, 2), ['/x/*', '/x/*/*'])
  // any other entry is itself
  for (
    const entry of [...KEY_MATERIAL_LIST, ...WALLET_LIST].filter((e) =>
      !e.includes('**')
    )
  ) {
    assertEquals(perComponentPatterns(entry), [entry])
  }

  // the search goes down as far: a wallet 8 directories below ~/slv is found, one 9 below is not
  assert(findExistingPaths, 'excludes.ts does not export findExistingPaths')
  const root = await Deno.makeTempDir({ prefix: 'slv-depth-' })
  try {
    await makeHost(root, [
      `/root/slv${'/d'.repeat(8)}/wallet.json`,
      `/root/slv${'/d'.repeat(9)}/wallet.json`,
    ])
    assertEquals(
      await findExistingPaths(['/root/slv/**/wallet*.json*'], { root }),
      [`/root/slv${'/d'.repeat(8)}/wallet.json`],
    )
  } finally {
    await Deno.remove(root, { recursive: true })
  }
})
