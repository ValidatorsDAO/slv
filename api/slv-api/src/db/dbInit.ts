import mysql from 'mysql2/promise'
import { colors } from '@cliffy/colors'
import { LOCAL_DB_URL } from '@cmn/constants/config.ts'
import { schemaSql } from './schemaSql.ts'

const EXISTING_TIDB = {
  tag: 'slv-tidb',
  version: 'v8.5.4',
}

const LOCAL_DB_USER = 'solv'
const LOCAL_DB_PASSWORD = 'solvLocal'

const LAUNCHD_LABEL = 'dev.slv.tiup.playground'
const LAUNCHD_LOG = 'slv-tiup-playground.log'
const SYSTEMD_UNIT_NAME = 'slv-tiup-playground.service'

const log = (message: string) => {
  console.log(`${colors.cyan('[db:init]')} ${message}`)
}

const logOk = (message: string) => {
  console.log(`${colors.green('🟢 OK')} ${message}`)
}

const logWarn = (message: string) => {
  console.log(`${colors.yellow('[db:init][warn]')} ${message}`)
}

type DbConfig = {
  host: string
  port: number
  user: string
  password: string
  database: string
}

type RootConfig = {
  host: string
  port: number
  user: string
  password: string
}

const parseDbUrl = (dbUrl: string): DbConfig => {
  const url = new URL(dbUrl)
  const database = url.pathname.replace(/^\//, '')
  if (!database) {
    throw new Error('Database name is missing in LOCAL_DB_URL')
  }
  const rawHost = url.hostname || '127.0.0.1'
  const host = rawHost === 'localhost' ? '127.0.0.1' : rawHost
  return {
    host,
    port: url.port ? Number(url.port) : 4000,
    user: LOCAL_DB_USER,
    password: LOCAL_DB_PASSWORD,
    database,
  }
}

const getRootConfig = (dbConfig: DbConfig): RootConfig => {
  return {
    host: dbConfig.host,
    port: dbConfig.port,
    user: Deno.env.get('TIDB_ROOT_USER') ?? 'root',
    password: Deno.env.get('TIDB_ROOT_PASSWORD') ?? '',
  }
}

const getHomeDir = () => {
  const home = Deno.env.get('HOME') ?? ''
  if (!home) {
    throw new Error('HOME is not set')
  }
  return home
}

const fileExists = async (path: string): Promise<boolean> => {
  try {
    await Deno.stat(path)
    return true
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      return false
    }
    throw error
  }
}

const runCommand = async (
  cmd: string,
  args: string[],
  options: { cwd?: string } = {},
) => {
  const command = new Deno.Command(cmd, {
    args,
    stdout: 'inherit',
    stderr: 'inherit',
    cwd: options.cwd,
  })
  const child = command.spawn()
  const { code } = await child.status
  if (code !== 0) {
    throw new Error(`Command failed (${code}): ${cmd} ${args.join(' ')}`)
  }
}

const runCommandOutput = async (
  cmd: string,
  args: string[],
  options: { cwd?: string } = {},
) => {
  const command = new Deno.Command(cmd, {
    args,
    stdout: 'piped',
    stderr: 'piped',
    cwd: options.cwd,
  })
  const { code, stdout, stderr } = await command.output()
  const decoder = new TextDecoder()
  return {
    code,
    stdout: decoder.decode(stdout).trim(),
    stderr: decoder.decode(stderr).trim(),
  }
}

const runShell = async (command: string) => {
  await runCommand('sh', ['-c', command])
}

const which = async (cmd: string): Promise<string | null> => {
  const command = new Deno.Command('sh', {
    args: ['-c', `command -v ${cmd}`],
    stdout: 'piped',
    stderr: 'null',
  })
  const { code, stdout } = await command.output()
  if (code !== 0) {
    return null
  }
  const output = new TextDecoder().decode(stdout).trim()
  return output.length > 0 ? output : null
}

const isTiupInstalled = async (): Promise<boolean> => {
  if (await which('tiup')) {
    return true
  }
  const home = getHomeDir()
  return await fileExists(`${home}/.tiup/bin/tiup`)
}

const resolveTiupBin = async (): Promise<string> => {
  const inPath = await which('tiup')
  if (inPath) {
    return inPath
  }
  const home = getHomeDir()
  const fallback = `${home}/.tiup/bin/tiup`
  if (await fileExists(fallback)) {
    return fallback
  }
  return 'tiup'
}

export const installTiup = async () => {
  log('Installing tiup (first run may take a few minutes)')
  const os = Deno.build.os
  if (os === 'darwin') {
    if (await which('brew')) {
      log('Using brew to install tiup')
      await runCommand('brew', ['install', 'tiup'])
    } else {
      log('Using tiup install.sh')
      await runShell(
        "curl --proto '=https' --tlsv1.2 -sSf https://tiup-mirrors.pingcap.com/install.sh | sh",
      )
    }
  } else if (os === 'linux') {
    log('Using tiup install.sh')
    await runShell(
      "curl --proto '=https' --tlsv1.2 -sSf https://tiup-mirrors.pingcap.com/install.sh | sh",
    )
  } else {
    throw new Error(`Unsupported OS for tiup install: ${os}`)
  }

  const home = getHomeDir()
  const tiupBinDir = `${home}/.tiup/bin`
  const currentPath = Deno.env.get('PATH') ?? ''
  if (!currentPath.includes(tiupBinDir)) {
    Deno.env.set('PATH', `${tiupBinDir}:${currentPath}`)
  }
}

const isPortOpen = async (host: string, port: number): Promise<boolean> => {
  try {
    const conn = await Deno.connect({ hostname: host, port })
    conn.close()
    return true
  } catch {
    return false
  }
}

const waitForPort = async (host: string, port: number) => {
  const retries = 40
  const delayMs = 1500
  log(`Waiting for TiDB on ${host}:${port} (${retries} retries)`)
  for (let attempt = 0; attempt < retries; attempt += 1) {
    if (await isPortOpen(host, port)) {
      logOk(`TiDB is accepting connections on ${host}:${port}`)
      return
    }
    if ((attempt + 1) % 5 === 0) {
      log(`Still waiting for ${host}:${port} (attempt ${attempt + 1})`)
    }
    await new Promise((resolve) => setTimeout(resolve, delayMs))
  }
  throw new Error(`Timed out waiting for TiDB on ${host}:${port}`)
}

const updateTiupAll = async (tiupBin: string) => {
  log('Updating tiup components (tiup update --all)')
  await runCommand(tiupBin, ['update', '--all'])
}

const sanitizeSql = (sql: string) => {
  return sql
    .split('\n')
    .filter((line) => !line.startsWith('-->'))
    .join('\n')
}

const runCommandWithInput = async (
  cmd: string,
  args: string[],
  input: string,
  options: { cwd?: string } = {},
) => {
  const command = new Deno.Command(cmd, {
    args,
    stdin: 'piped',
    stdout: 'inherit',
    stderr: 'inherit',
    cwd: options.cwd,
  })
  const child = command.spawn()
  const writer = child.stdin.getWriter()
  await writer.write(new TextEncoder().encode(input))
  await writer.close()
  const { code } = await child.status
  if (code !== 0) {
    throw new Error(`Command failed (${code}): ${cmd} ${args.join(' ')}`)
  }
}

const runMysqlSchema = async (dbConfig: DbConfig) => {
  const mysqlBin = await which('mysql')
  if (!mysqlBin) {
    throw new Error(
      'mysql CLI not found. Please install MySQL client (mysql) to apply schema.',
    )
  }
  const sql = `${sanitizeSql(schemaSql)}\n`
  log('Applying schema via mysql CLI')
  await runCommandWithInput(mysqlBin, [
    '--host',
    dbConfig.host,
    '--port',
    String(dbConfig.port),
    '--user',
    dbConfig.user,
    `--password=${dbConfig.password}`,
    '--database',
    dbConfig.database,
  ], sql)
  logOk('Schema applied via mysql CLI')
}

const buildLaunchdPath = (tiupBin: string) => {
  const home = getHomeDir()
  const currentPath = Deno.env.get('PATH') ?? ''
  const tiupDir = tiupBin.includes('/')
    ? tiupBin.split('/').slice(0, -1).join('/')
    : `${home}/.tiup/bin`
  const parts = [
    tiupDir,
    `${home}/.tiup/bin`,
    '/opt/homebrew/bin',
    '/usr/local/bin',
    '/usr/bin',
    '/bin',
    '/usr/sbin',
    '/sbin',
    currentPath,
  ].filter((value) => value.length > 0)

  const seen = new Set<string>()
  const unique = parts.filter((value) => {
    if (seen.has(value)) {
      return false
    }
    seen.add(value)
    return true
  })

  return unique.join(':')
}

const buildSystemdPath = (tiupBin: string) => {
  return buildLaunchdPath(tiupBin)
}

const buildLaunchdPlist = (options: {
  tiupBin: string
  logPath: string
  workingDir: string
  pathEnv: string
}) => {
  const { tiupBin, logPath, workingDir, pathEnv } = options
  const args = [
    tiupBin,
    'playground',
    '--tag',
    EXISTING_TIDB.tag,
    EXISTING_TIDB.version,
  ]
  const argsXml = args.map((arg) => `    <string>${arg}</string>`).join('\n')
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>${LAUNCHD_LABEL}</string>
    <key>ProgramArguments</key>
    <array>
${argsXml}
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>WorkingDirectory</key>
    <string>${workingDir}</string>
    <key>StandardOutPath</key>
    <string>${logPath}</string>
    <key>StandardErrorPath</key>
    <string>${logPath}</string>
    <key>EnvironmentVariables</key>
    <dict>
      <key>PATH</key>
      <string>${pathEnv}</string>
    </dict>
  </dict>
</plist>
`
}

const buildSystemdUnit = (options: {
  tiupBin: string
  workingDir: string
  pathEnv: string
  tag: string
  version: string
  wantedBy: string
  homeEnv: string
  userEnv: string
}) => {
  const {
    tiupBin,
    workingDir,
    pathEnv,
    tag,
    version,
    wantedBy,
    homeEnv,
    userEnv,
  } = options
  return `[Unit]
Description=SLV TiUP Playground (TiDB)
After=network.target

[Service]
Type=simple
WorkingDirectory=${workingDir}
ExecStart=${tiupBin} playground --tag ${tag} ${version}
Restart=on-failure
RestartSec=5
Environment=PATH=${pathEnv}
Environment=HOME=${homeEnv}
Environment=USER=${userEnv}

[Install]
WantedBy=${wantedBy}
`
}

const ensureLaunchAgent = async (tiupBin: string) => {
  log('Configuring launchd (macOS)')
  const home = getHomeDir()
  const launchAgentsDir = `${home}/Library/LaunchAgents`
  const logsDir = `${home}/Library/Logs`
  await Deno.mkdir(launchAgentsDir, { recursive: true })
  await Deno.mkdir(logsDir, { recursive: true })

  const plistPath = `${launchAgentsDir}/${LAUNCHD_LABEL}.plist`
  const logPath = `${logsDir}/${LAUNCHD_LOG}`
  const pathEnv = buildLaunchdPath(tiupBin)
  const plistContent = buildLaunchdPlist({
    tiupBin,
    logPath,
    workingDir: Deno.cwd(),
    pathEnv,
  })

  const existing = await fileExists(plistPath)
  if (!existing || (await Deno.readTextFile(plistPath)) !== plistContent) {
    log(`Writing launchd plist: ${plistPath}`)
    await Deno.writeTextFile(plistPath, plistContent)
  }

  log(`plutil -lint ${plistPath}`)
  const lintResult = await runCommandOutput('plutil', ['-lint', plistPath])
  if (lintResult.stdout) {
    console.log(lintResult.stdout)
  }
  if (lintResult.stderr) {
    console.log(lintResult.stderr)
  }
  if (lintResult.code === 0) {
    logOk('launchd plist validated')
  }

  const uid = Deno.uid()
  const target = `gui/${uid}`
  log(`launchctl bootstrap ${target}`)
  const bootstrapResult = await runCommandOutput('launchctl', [
    'bootstrap',
    target,
    plistPath,
  ])
  if (bootstrapResult.code !== 0) {
    logWarn(
      'launchctl bootstrap returned non-zero (often OK if already loaded). Retrying with bootout.',
    )
    if (bootstrapResult.stdout) {
      console.log(bootstrapResult.stdout)
    }
    if (bootstrapResult.stderr) {
      console.log(bootstrapResult.stderr)
    }
    log(`launchctl bootout ${target}`)
    const bootoutResult = await runCommandOutput('launchctl', [
      'bootout',
      target,
      plistPath,
    ])
    if (bootoutResult.code !== 0) {
      logWarn('launchctl bootout returned non-zero (job may be absent)')
    }
    log(`launchctl bootstrap ${target}`)
    await runCommand('launchctl', ['bootstrap', target, plistPath])
  }
  log(`launchctl kickstart ${target}/${LAUNCHD_LABEL}`)
  await runCommand('launchctl', [
    'kickstart',
    '-k',
    `${target}/${LAUNCHD_LABEL}`,
  ])

  const printResult = await runCommandOutput('launchctl', [
    'print',
    `${target}/${LAUNCHD_LABEL}`,
  ])
  if (printResult.stdout || printResult.stderr) {
    logOk('launchd job is running')
  }
}

const ensureSystemdService = async (
  tiupBin: string,
  tag: string,
  version: string,
  shouldStart: boolean,
) => {
  const scopeEnv = (Deno.env.get('SLV_SYSTEMD_SCOPE') ?? '').toLowerCase()
  const useSystemScope = scopeEnv === 'system' ||
    (scopeEnv === '' && Deno.uid() === 0)
  const scopeLabel = useSystemScope ? 'system' : 'user'
  log(`Configuring systemd (${scopeLabel} scope)`)
  const systemctlBin = await which('systemctl')
  if (!systemctlBin) {
    logWarn('systemctl not found. Falling back to background start.')
    if (shouldStart) {
      await startTiupPlayground(tiupBin, tag, version)
    }
    return
  }

  const home = getHomeDir()
  const unitDir = useSystemScope
    ? '/etc/systemd/system'
    : `${home}/.config/systemd/user`
  await Deno.mkdir(unitDir, { recursive: true })
  const unitPath = `${unitDir}/${SYSTEMD_UNIT_NAME}`
  const pathEnv = buildSystemdPath(tiupBin)
  const wantedBy = useSystemScope ? 'multi-user.target' : 'default.target'
  const userEnv = Deno.env.get('USER') ??
    (Deno.uid() === 0 ? 'root' : 'slv')
  const unitContent = buildSystemdUnit({
    tiupBin,
    workingDir: Deno.cwd(),
    pathEnv,
    tag,
    version,
    wantedBy,
    homeEnv: home,
    userEnv,
  })

  const existing = await fileExists(unitPath)
  if (!existing || (await Deno.readTextFile(unitPath)) !== unitContent) {
    log(`Writing systemd unit: ${unitPath}`)
    await Deno.writeTextFile(unitPath, unitContent)
  }

  try {
    const systemctlArgs = useSystemScope ? [] : ['--user']
    await runCommand('systemctl', [...systemctlArgs, 'daemon-reload'])
    await runCommand('systemctl', [
      ...systemctlArgs,
      'enable',
      SYSTEMD_UNIT_NAME,
    ])
    if (shouldStart) {
      await runCommand('systemctl', [
        ...systemctlArgs,
        'start',
        SYSTEMD_UNIT_NAME,
      ])
    }
  } catch (error) {
    logWarn('systemctl failed. Falling back to background start.')
    if (error instanceof Error) {
      logWarn(error.message)
    }
    if (shouldStart) {
      await startTiupPlayground(tiupBin, tag, version)
    }
    return
  }

  const status = await runCommandOutput('systemctl', [
    ...(useSystemScope ? [] : ['--user']),
    'is-active',
    SYSTEMD_UNIT_NAME,
  ])
  if (status.code === 0) {
    logOk('systemd service is running')
  } else if (status.stdout || status.stderr) {
    logWarn(`systemd status: ${status.stdout || status.stderr}`)
  }
}

export const startTiupPlayground = async (
  tiupBin: string,
  tag: string,
  version: string,
  background = true,
) => {
  if (background) {
    const logPath = `./tiup-playground-${tag}.log`
    await runShell(
      `"${tiupBin}" playground --tag ${tag} ${version} > ${logPath} 2>&1 &`,
    )
    return
  }
  await runCommand(tiupBin, ['playground', '--tag', tag, version])
}

const createDatabaseAndUser = async (dbConfig: DbConfig) => {
  log(`Ensuring database and user: ${dbConfig.database}`)
  const rootConfig = getRootConfig(dbConfig)
  const connection = await mysql.createConnection({
    host: rootConfig.host,
    port: rootConfig.port,
    user: rootConfig.user,
    password: rootConfig.password,
  })

  await connection.query(
    `CREATE DATABASE IF NOT EXISTS \`${dbConfig.database}\``,
  )
  if (dbConfig.user !== rootConfig.user) {
    log(`Ensuring user '${dbConfig.user}' with configured password`)
    await connection.query(
      `CREATE USER IF NOT EXISTS '${dbConfig.user}'@'%' IDENTIFIED BY '${dbConfig.password}'`,
    )
    await connection.query(
      `ALTER USER '${dbConfig.user}'@'%' IDENTIFIED BY '${dbConfig.password}'`,
    )
    log(`Granting privileges on all databases to '${dbConfig.user}'`)
    await connection.query(
      `GRANT ALL PRIVILEGES ON *.* TO '${dbConfig.user}'@'%'`,
    )
    await connection.query('FLUSH PRIVILEGES')
    logOk(`User '${dbConfig.user}' is ready`)
  }

  await connection.end()
}

const migrateSchema = async (dbConfig: DbConfig) => {
  await runMysqlSchema(dbConfig)
}

export const ensureDatabaseAndMigrate = async (dbUrl = LOCAL_DB_URL) => {
  const dbConfig = parseDbUrl(dbUrl)
  await createDatabaseAndUser(dbConfig)
  await migrateSchema(dbConfig)
  logOk('Schema migration completed')
}

export const prepareLocalDb = async () => {
  log('Starting local DB preparation (safe to re-run)')
  const dbConfig = parseDbUrl(LOCAL_DB_URL)
  const os = Deno.build.os
  const skipLaunchd = Deno.env.get('SLV_SKIP_LAUNCHD') === '1' ||
    Deno.env.get('CI') === 'true'
  const skipSystemd = Deno.env.get('SLV_SKIP_SYSTEMD') === '1' ||
    Deno.env.get('CI') === 'true'

  if (os === 'darwin') {
    log('Detected macOS')
    const hadTiup = await isTiupInstalled()
    if (!hadTiup) {
      await installTiup()
    }
    const tiupBin = await resolveTiupBin()
    log(`tiup binary: ${tiupBin}`)
    await updateTiupAll(tiupBin)
    logOk('tiup components up to date')
    const isRunning = await isPortOpen(dbConfig.host, dbConfig.port)
    if (isRunning) {
      logOk(
        `TiDB already running at ${dbConfig.host}:${dbConfig.port} (skip start)`,
      )
    } else {
      if (skipLaunchd) {
        log('Skipping launchd (CI or SLV_SKIP_LAUNCHD)')
        await startTiupPlayground(
          tiupBin,
          EXISTING_TIDB.tag,
          EXISTING_TIDB.version,
        )
      } else {
        await ensureLaunchAgent(tiupBin)
      }
      await waitForPort(dbConfig.host, dbConfig.port)
    }
    await ensureDatabaseAndMigrate(LOCAL_DB_URL)
    logOk(`Local DB ready at ${dbConfig.host}:${dbConfig.port}`)
    return
  }

  log('Detected non-macOS')
  const hadTiup = await isTiupInstalled()
  if (!hadTiup) {
    await installTiup()
  }
  const tiupBin = await resolveTiupBin()
  log(`tiup binary: ${tiupBin}`)
  await updateTiupAll(tiupBin)
  logOk('tiup components up to date')
  const isRunning = await isPortOpen(dbConfig.host, dbConfig.port)
  if (!isRunning) {
    const { tag, version } = EXISTING_TIDB
    log(`Starting tiup playground (${tag} ${version})`)
    if (skipSystemd) {
      log('Skipping systemd (CI or SLV_SKIP_SYSTEMD)')
      await startTiupPlayground(tiupBin, tag, version)
    } else {
      await ensureSystemdService(tiupBin, tag, version, true)
    }
    await waitForPort(dbConfig.host, dbConfig.port)
  } else {
    logOk(
      `TiDB already running at ${dbConfig.host}:${dbConfig.port} (skip start)`,
    )
    if (!skipSystemd) {
      const { tag, version } = EXISTING_TIDB
      await ensureSystemdService(tiupBin, tag, version, false)
    }
  }
  await ensureDatabaseAndMigrate(LOCAL_DB_URL)
  logOk(`Local DB ready at ${dbConfig.host}:${dbConfig.port}`)
}

if (import.meta.main) {
  await prepareLocalDb()
}
