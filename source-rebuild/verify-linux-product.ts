/**
 * Linux source-built runtime compatibility gate for the official SLV product.
 *
 * It verifies the baseline runtime transported by a passed native proof, then
 * compiles a small crypto/subprocess/loopback-TLS smoke executable through
 * that runtime and executes the product artifacts and smoke through the exact
 * Deno 2.27 loader and libraries prepared from the checksum-pinned sysroot.
 */
import { createHash } from 'node:crypto'

const SHA256 = /^[a-f0-9]{64}$/
const SYSROOTS: Record<string, {
  archive_sha256: string
  env_sha256: string
  arch: string
}> = {
  'x86_64-unknown-linux-gnu': {
    archive_sha256:
      '64513b04d8a38da6f47c0a9c4cb47b2ce7bcb735250b10eb10751aec6afe46ee',
    env_sha256:
      '8dd1d28a69afcd7790a4f9871c02992553ad348b3855aab4e465a263e298c81a',
    arch: 'x86_64-linux-gnu',
  },
  'aarch64-unknown-linux-gnu': {
    archive_sha256:
      '0a29c63c52cc1e59228686602cf3cf41080a809655afc29d1b8a27af4b20cedb',
    env_sha256:
      '11c9a31f2303e448eb68ff5de9f0359ff202a2f25e5f4fa9001d8c332ea2d80e',
    arch: 'aarch64-linux-gnu',
  },
}
const decoder = new TextDecoder()
type Args = Record<string, string>
type CommandReceipt = {
  command: string[]
  cwd: string
  started_at: string
  finished_at: string
  exit_code: number
  log: string
  log_sha256: string
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`)
  }
  return value as Record<string, unknown>
}
function text(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value) {
    throw new Error(`${label} is required`)
  }
  return value
}
function sha(value: unknown, label: string): string {
  const digest = text(value, label)
  if (!SHA256.test(digest)) throw new Error(`${label} must be a SHA-256`)
  return digest
}
function parseArgs(argv: string[]): Args {
  const args: Args = {}
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index]
    const value = argv[index + 1]
    if (
      !flag?.startsWith('--') || !value || value.startsWith('--') || args[flag]
    ) {
      throw new Error('arguments must be unique --flag VALUE pairs')
    }
    args[flag] = value
  }
  for (
    const required of [
      '--target',
      '--build-receipt',
      '--native-proof',
      '--runtime-dir',
      '--tools-receipt',
      '--executable',
      '--bridge',
      '--out',
    ]
  ) {
    if (!args[required]) throw new Error(`missing ${required}`)
  }
  if (!SYSROOTS[args['--target']]) {
    throw new Error('Linux target must be x86_64 or aarch64 GNU')
  }
  return args
}
async function sha256(path: string): Promise<string> {
  const file = await Deno.open(path)
  const hash = createHash('sha256')
  try {
    const chunk = new Uint8Array(1024 * 1024)
    for (;;) {
      const read = await file.read(chunk)
      if (read === null) break
      hash.update(chunk.subarray(0, read))
    }
  } finally {
    file.close()
  }
  return hash.digest('hex')
}
async function regular(path: string, label: string): Promise<void> {
  const info = await Deno.lstat(path).catch(() => undefined)
  if (!info?.isFile || info.isSymlink || info.size <= 0) {
    throw new Error(`${label} must be a non-empty regular file: ${path}`)
  }
}
async function emptyDirectory(path: string, label: string): Promise<string> {
  const info = await Deno.lstat(path).catch(() => undefined)
  if (info && (!info.isDirectory || info.isSymlink)) {
    throw new Error(`${label} must be a real directory: ${path}`)
  }
  if (!info) await Deno.mkdir(path, { recursive: true })
  for await (const _ of Deno.readDir(path)) {
    throw new Error(`${label} must be empty: ${path}`)
  }
  return await Deno.realPath(path)
}
async function command(
  executable: string,
  args: string[],
  cwd: string,
  log: string,
  env: Record<string, string> = {},
): Promise<CommandReceipt> {
  const started_at = new Date().toISOString()
  const result = await new Deno.Command(executable, {
    args,
    cwd,
    clearEnv: true,
    env: {
      PATH: '/usr/bin:/bin',
      HOME: `${cwd}/private-home`,
      DENO_DIR: `${cwd}/deno-cache`,
      LANG: 'C',
      LC_ALL: 'C',
      TZ: 'UTC',
      ...env,
    },
    stdout: 'piped',
    stderr: 'piped',
  }).output()
  await Deno.writeFile(
    log,
    new Uint8Array([
      ...result.stdout,
      ...result.stderr,
    ]),
  )
  return {
    command: [executable, ...args],
    cwd,
    started_at,
    finished_at: new Date().toISOString(),
    exit_code: result.code,
    log,
    log_sha256: await sha256(log),
  }
}
function passed(receipt: CommandReceipt, label: string): void {
  if (receipt.exit_code !== 0) {
    throw new Error(`${label} failed: ${receipt.log}`)
  }
}

function portableCommandReceipt(
  receipt: CommandReceipt,
  outputDirectory: string,
): CommandReceipt {
  if (
    receipt.cwd !== outputDirectory ||
    !receipt.log.startsWith(`${outputDirectory}/`)
  ) {
    throw new Error(
      'compatibility command escaped the declared output directory',
    )
  }
  const log = receipt.log.slice(receipt.log.lastIndexOf('/') + 1)
  if (
    !log || log === '.' || log === '..' || log.includes('/') ||
    log.includes('\\')
  ) {
    throw new Error('compatibility command has an unsafe log path')
  }
  return { ...receipt, cwd: '.', log }
}

export function portableReceiptValue(
  value: unknown,
  outputDirectory: string,
): unknown {
  if (Array.isArray(value)) {
    return value.map((child) => portableReceiptValue(child, outputDirectory))
  }
  if (!value || typeof value !== 'object') return value
  const record = value as Record<string, unknown>
  if (
    Array.isArray(record.command) && typeof record.cwd === 'string' &&
    typeof record.log === 'string' && typeof record.log_sha256 === 'string' &&
    typeof record.exit_code === 'number'
  ) {
    return portableCommandReceipt(
      record as unknown as CommandReceipt,
      outputDirectory,
    )
  }
  return Object.fromEntries(
    Object.entries(record).map((
      [key, child],
    ) => [key, portableReceiptValue(child, outputDirectory)]),
  )
}

export function parseGlibcVersions(report: string): string[] {
  if (report.includes('GLIBC_PRIVATE')) {
    throw new Error('GLIBC_PRIVATE is forbidden')
  }
  const seen = new Set<string>()
  for (const match of report.matchAll(/GLIBC_(\d+)\.(\d+)/g)) {
    const major = Number(match[1])
    const minor = Number(match[2])
    if (!Number.isSafeInteger(major) || !Number.isSafeInteger(minor)) {
      throw new Error('invalid GLIBC version in ELF report')
    }
    if (major > 2 || (major === 2 && minor > 27)) {
      throw new Error(`GLIBC requirement above 2.27: ${major}.${minor}`)
    }
    seen.add(`${major}.${minor}`)
  }
  return [...seen].sort((left, right) => {
    const [lm, ln] = left.split('.').map(Number)
    const [rm, rn] = right.split('.').map(Number)
    return lm - rm || ln - rn
  })
}

function dynamicDependencies(report: string): string[] {
  if (/\((?:RPATH|RUNPATH)\)/.test(report)) {
    throw new Error('ELF RPATH/RUNPATH is forbidden')
  }
  return [...report.matchAll(/Shared library: \[([^\]]+)\]/g)].map((match) =>
    match[1]
  )
}

function verifyNativeBinding(
  proof: Record<string, unknown>,
  buildReceiptSha256: string,
  target: string,
): {
  runtime_sha256: string
  derived_lock_sha256: string
  notice_sha256: string
} {
  if (
    proof.schema_version !== 1 || proof.kind !== 'slv-source-target-proof' ||
    proof.status !== 'passed' || proof.target !== target ||
    proof.build_receipt_sha256 !== buildReceiptSha256
  ) throw new Error('native proof does not bind this target build receipt')
  const artifacts = object(proof.artifacts, 'native proof artifacts')
  const baseline = object(artifacts.baseline, 'native proof baseline artifacts')
  const checks = object(proof.checks, 'native proof checks')
  const licenses = object(checks.licenses, 'native proof licenses check')
  if (licenses.passed !== true) {
    throw new Error('native proof licenses check is not passed')
  }
  return {
    runtime_sha256: sha(baseline.denort_sha256, 'baseline denort digest'),
    derived_lock_sha256: sha(
      baseline.derived_relink_cargo_lock_sha256,
      'baseline derived lock digest',
    ),
    notice_sha256: sha(
      licenses.canonical_notice_sha256,
      'native proof canonical notice digest',
    ),
  }
}

async function readExecutionTools(
  receiptPath: string,
  target: string,
): Promise<{ frontend: string; sysroot: string }> {
  const receipt = object(
    JSON.parse(await Deno.readTextFile(receiptPath)),
    'tools receipt',
  )
  if (
    receipt.schema_version !== 1 || receipt.kind !== 'slv-native-toolchain' ||
    receipt.target !== target || receipt.purpose !== 'execution' ||
    receipt.build_host !== target
  ) throw new Error('execution tools receipt does not match Linux target')
  const archive = object(
    object(receipt.archives, 'tools archives')['deno-sysroot'],
    'Deno sysroot archive',
  )
  if (
    sha(archive.sha256, 'Deno sysroot archive digest') !==
      SYSROOTS[target].archive_sha256
  ) {
    throw new Error(
      'execution receipt does not use the pinned Deno ABI sysroot archive',
    )
  }
  const environment = object(receipt.environment, 'execution tools environment')
  const frontend = text(environment.DENO_FRONTEND, 'execution Deno frontend')
  const sysroot = text(environment.DENO_SYSROOT, 'execution Deno ABI sysroot')
  await regular(frontend, 'execution Deno frontend')
  const sysrootEnv = `${sysroot}/.env`
  await regular(sysrootEnv, 'Deno ABI sysroot environment')
  if (await sha256(sysrootEnv) !== SYSROOTS[target].env_sha256) {
    throw new Error(
      'Deno ABI sysroot environment bytes differ from pinned release',
    )
  }
  return { frontend, sysroot }
}

async function elfReceipt(
  executable: string,
  directory: string,
  label: string,
): Promise<
  {
    versions: string[]
    needed: string[]
    version: CommandReceipt
    dynamic: CommandReceipt
  }
> {
  const version = await command(
    '/usr/bin/readelf',
    ['--version-info', executable],
    directory,
    `${directory}/${label}-version-info.log`,
  )
  passed(version, `${label} ELF version inspection`)
  const dynamic = await command(
    '/usr/bin/readelf',
    ['-d', executable],
    directory,
    `${directory}/${label}-dynamic.log`,
  )
  passed(dynamic, `${label} ELF dynamic inspection`)
  return {
    versions: parseGlibcVersions(await Deno.readTextFile(version.log)),
    needed: dynamicDependencies(await Deno.readTextFile(dynamic.log)),
    version,
    dynamic,
  }
}

export function loaderResolvedPaths(report: string): string[] {
  if (/\bnot found\b/.test(report)) {
    throw new Error('older loader could not resolve a required shared library')
  }
  const paths = new Set<string>()
  for (const line of report.split('\n')) {
    // glibc `ld.so --list` writes either `libx.so => /path (0x...)` or a
    // direct interpreter line `/path/ld-linux... (0x...)`. Parse complete
    // path tokens only; a lazy slash regex incorrectly turned `/tmp/...`
    // into `/t`, `/m`, and so on.
    const match = /=>\s+(\/[^\s(]+)|^\s*(\/[^\s(]+)\s+\(/.exec(line)
    const path = match?.[1] ?? match?.[2]
    if (path) paths.add(path)
  }
  return [...paths]
}

async function loaderList(
  loader: string,
  libraryPath: string,
  executable: string,
  directory: string,
  label: string,
  sysroot: string,
): Promise<CommandReceipt> {
  const receipt = await command(
    loader,
    ['--library-path', libraryPath, '--list', executable],
    directory,
    `${directory}/${label}-loader-list.log`,
  )
  passed(receipt, `${label} loader closure listing`)
  // The list is evidence only; acceptance still executes every program below.
  // Reject absolute library resolutions outside the pinned sysroot so a host
  // library cannot silently satisfy a missing compatibility dependency.
  for (
    const path of loaderResolvedPaths(await Deno.readTextFile(receipt.log))
  ) {
    if (!path.startsWith(`${sysroot}/`)) {
      throw new Error(
        `${label} loader closure resolved outside pinned sysroot: ${path}`,
      )
    }
  }
  return receipt
}

async function compileSmoke(
  frontend: string,
  runtime: string,
  target: string,
  cert: string,
  key: string,
  rootCA: string,
  directory: string,
): Promise<{ executable: string; compile: CommandReceipt }> {
  const source = `${directory}/runtime-smoke.ts`
  const executable = `${directory}/runtime-smoke`
  await Deno.writeTextFile(
    source,
    `
const [certPath, keyPath, rootCAPath] = Deno.args;
const cert = await Deno.readTextFile(certPath);
const key = await Deno.readTextFile(keyPath);
const rootCA = await Deno.readTextFile(rootCAPath);
const digest = Array.from(new Uint8Array(
  await crypto.subtle.digest('SHA-256', new TextEncoder().encode('slv-source-built-runtime')),
)).map((byte) => byte.toString(16).padStart(2, '0')).join('');
if (digest !== 'd93272af405396365d08e6bef5380b980ffae5daffeefeb03366dcbc1d0c9697') {
  throw new Error('crypto SHA-256 known-answer mismatch');
}
const subprocess = await new Deno.Command('/bin/true').output();
if (!subprocess.success) throw new Error('subprocess failed');
const within = async <T>(promise: Promise<T>, label: string): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => { timer = setTimeout(() => reject(new Error(label + ' timed out')), 10_000); }),
    ]);
  } finally { if (timer !== undefined) clearTimeout(timer); }
};
const listener = Deno.listenTls({ hostname: '127.0.0.1', port: 0, cert, key });
const port = (listener.addr as Deno.NetAddr).port;
const acceptOnce = async (allowHandshakeFailure: boolean, exchange: boolean) => {
  const conn = await within(listener.accept() as Promise<Deno.TlsConn>, 'TLS accept');
  try {
    await within(conn.handshake(), 'TLS server handshake');
    if (exchange) {
      const request = new Uint8Array(1);
      const count = await within(conn.read(request), 'TLS server read');
      if (count !== 1 || request[0] !== 0x73) throw new Error('TLS server data exchange failed');
      await within(conn.write(new Uint8Array([0x6c])), 'TLS server write');
    }
  } catch (error) {
    if (!allowHandshakeFailure) throw error;
  } finally { conn.close(); }
};
try {
  const rejectedServer = acceptOnce(true, false);
  let untrustedRejected = false;
  try {
    const untrusted = await within(Deno.connectTls({ hostname: 'localhost', port }), 'untrusted TLS connect');
    try { await within(untrusted.handshake(), 'untrusted TLS handshake'); }
    finally { untrusted.close(); }
  } catch { untrustedRejected = true; }
  await rejectedServer;
  if (!untrustedRejected) throw new Error('untrusted TLS connection unexpectedly succeeded');
  const trustedServer = acceptOnce(false, true);
  const client = await within(Deno.connectTls({ hostname: 'localhost', port, caCerts: [rootCA] }), 'trusted TLS connect');
  try {
    await within(client.handshake(), 'trusted TLS handshake');
    await within(client.write(new Uint8Array([0x73])), 'TLS client write');
    const response = new Uint8Array(1);
    const count = await within(client.read(response), 'TLS client read');
    if (count !== 1 || response[0] !== 0x6c) throw new Error('TLS client data exchange failed');
  } finally { client.close(); }
  await trustedServer;
} finally { listener.close(); }
console.log(JSON.stringify({ crypto: 'passed', subprocess: 'passed', loopback_tls: 'passed', untrusted_tls_rejected: 'passed' }));
`,
  )
  const compile = await command(
    frontend,
    [
      'compile',
      '--cached-only',
      '--no-prompt',
      '-A',
      '--target',
      target,
      '--output',
      executable,
      source,
    ],
    directory,
    `${directory}/runtime-smoke-compile.log`,
    {
      DENORT_BIN: runtime,
    },
  )
  passed(compile, 'source-built runtime smoke compilation')
  await regular(executable, 'compiled runtime smoke')
  return { executable, compile }
}

export async function verifyLinuxProduct(args: Args): Promise<void> {
  const target = args['--target']
  if (
    Deno.build.os !== 'linux' ||
    (target.startsWith('x86_64')
      ? Deno.build.arch !== 'x86_64'
      : Deno.build.arch !== 'aarch64')
  ) {
    throw new Error(
      'Linux product compatibility execution must run on its target architecture',
    )
  }
  const out = await emptyDirectory(args['--out'], 'Linux compatibility output')
  for (
    const [label, path] of Object.entries({
      executable: args['--executable'],
      bridge: args['--bridge'],
    })
  ) await regular(path, label)
  // The official product row may pass artifact-relative paths. Resolve once
  // before subprocesses switch cwd to the isolated compatibility output.
  const executable = await Deno.realPath(args['--executable'])
  const bridgeExecutable = await Deno.realPath(args['--bridge'])
  const buildReceiptSha256 = await sha256(args['--build-receipt'])
  const build = object(
    JSON.parse(await Deno.readTextFile(args['--build-receipt'])),
    'build receipt',
  )
  if (build.target !== target || build.kind !== 'slv-source-build-receipt') {
    throw new Error('build receipt does not match Linux target')
  }
  const proof = object(
    JSON.parse(await Deno.readTextFile(args['--native-proof'])),
    'native proof',
  )
  const binding = verifyNativeBinding(proof, buildReceiptSha256, target)
  const tools = await readExecutionTools(args['--tools-receipt'], target)
  const runtimeDir = await Deno.realPath(args['--runtime-dir'])
  const runtime = `${runtimeDir}/baseline-denort`
  const derivedLock = `${runtimeDir}/baseline-derived-relink-Cargo.lock`
  const manifest = `${runtimeDir}/manifest.json`
  for (
    const [label, path] of Object.entries({ runtime, derivedLock, manifest })
  ) await regular(path, label)
  if (
    await sha256(runtime) !== binding.runtime_sha256 ||
    await sha256(derivedLock) !== binding.derived_lock_sha256
  ) {
    throw new Error('runtime transport differs from the passed native proof')
  }
  const transport = object(
    JSON.parse(await Deno.readTextFile(manifest)),
    'runtime transport manifest',
  )
  const entries = object(transport.entries, 'runtime transport entries')
  const cert = `${runtimeDir}/tls-localhost.crt`
  const key = `${runtimeDir}/tls-localhost.key`
  const rootCA = `${runtimeDir}/tls-root-ca.pem`
  for (
    const [name, digest, path] of [
      ['baseline-denort', binding.runtime_sha256, runtime],
      [
        'baseline-derived-relink-Cargo.lock',
        binding.derived_lock_sha256,
        derivedLock,
      ],
      ['tls-localhost.crt', await sha256(cert), cert],
      ['tls-localhost.key', await sha256(key), key],
      ['tls-root-ca.pem', await sha256(rootCA), rootCA],
    ]
  ) {
    await regular(path, `runtime transport ${name}`)
    const entry = object(entries[name], `runtime transport ${name}`)
    if (
      sha(entry.sha256, `runtime transport ${name} digest`) !== digest ||
      entry.size !== (await Deno.stat(path)).size
    ) {
      throw new Error(`runtime transport manifest does not bind ${name}`)
    }
  }
  const sysroot = SYSROOTS[target]
  const loader = `${tools.sysroot}/lib/${sysroot.arch}/ld-2.27.so`
  await regular(loader, 'pinned glibc 2.27 loader')
  const libraryPath =
    `${tools.sysroot}/lib/${sysroot.arch}:${tools.sysroot}/usr/lib/${sysroot.arch}`
  const smoke = await compileSmoke(
    tools.frontend,
    runtime,
    target,
    cert,
    key,
    rootCA,
    out,
  )
  const inspected: Record<string, unknown> = {}
  for (
    const [label, inspectedExecutable] of Object.entries({
      runtime,
      executable,
      bridge: bridgeExecutable,
      smoke: smoke.executable,
    })
  ) {
    inspected[label] = {
      ...(await elfReceipt(inspectedExecutable, out, label)),
      loader_list: await loaderList(
        loader,
        libraryPath,
        inspectedExecutable,
        out,
        label,
        tools.sysroot,
      ),
    }
  }
  const run = (label: string, executable: string, executableArgs: string[]) =>
    command(
      loader,
      ['--library-path', libraryPath, executable, ...executableArgs],
      out,
      `${out}/${label}.log`,
    )
  const startup = await run('product-version', executable, [
    '--version',
  ])
  const licenses = await run('product-licenses', executable, [
    'licenses',
  ])
  const bridge = await run('product-bridge', bridgeExecutable, [])
  const smokeRun = await run('runtime-smoke', smoke.executable, [
    cert,
    key,
    rootCA,
  ])
  for (
    const [label, receipt] of Object.entries({
      startup,
      licenses,
      bridge,
      smoke: smokeRun,
    })
  ) passed(receipt, label)
  if (licenses.log_sha256 !== binding.notice_sha256) {
    throw new Error(
      'older-loader product licenses bytes differ from passed native proof notice',
    )
  }
  await Deno.writeTextFile(
    `${out}/linux-compatibility-receipt.json`,
    JSON.stringify(
      {
        schema_version: 1,
        kind: 'slv-linux-product-compatibility',
        target,
        native_proof_sha256: await sha256(args['--native-proof']),
        build_receipt_sha256: buildReceiptSha256,
        runtime: {
          baseline_denort_sha256: binding.runtime_sha256,
          derived_relink_cargo_lock_sha256: binding.derived_lock_sha256,
          path: runtime,
        },
        product: {
          executable_sha256: await sha256(executable),
          bridge_sha256: await sha256(bridgeExecutable),
        },
        toolchain: {
          deno_sysroot_archive_sha256: sysroot.archive_sha256,
          deno_sysroot_env_sha256: sysroot.env_sha256,
          loader,
          library_path: libraryPath,
          frontend_sha256: await sha256(tools.frontend),
        },
        checks: portableReceiptValue({
          elf_glibc_ceiling_and_no_private_or_rpath: inspected,
          older_loader_startup: startup,
          older_loader_licenses: {
            ...licenses,
            canonical_notice_sha256: binding.notice_sha256,
          },
          older_loader_bridge: bridge,
          source_built_runtime_crypto_subprocess_loopback_tls: {
            compile: smoke.compile,
            execute: smokeRun,
            executable_sha256: await sha256(smoke.executable),
          },
        }, out),
        status: 'passed',
      },
      null,
      2,
    ) + '\n',
  )
}

if (import.meta.main) {
  try {
    await verifyLinuxProduct(parseArgs(Deno.args))
  } catch (error) {
    console.error(error instanceof Error ? error.message : error)
    Deno.exit(1)
  }
}
