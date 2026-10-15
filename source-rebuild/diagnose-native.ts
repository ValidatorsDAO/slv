/**
 * Bounded acquisition of native ARM startup evidence from one stored,
 * previously failed source-build artifact.  This is deliberately separate
 * from verify-native: it emits diagnostic records only and never emits a
 * release proof, receipt, or rebuilt artifact.
 */
import { createHash } from 'node:crypto'
import { relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const decoder = new TextDecoder()
const encoder = new TextEncoder()
const SHA256 = /^[a-f0-9]{64}$/
const SHA40 = /^[a-f0-9]{40}$/
const POSITIVE_DECIMAL = /^[1-9][0-9]*$/
const MAX_SUMMARY_BYTES = 64 * 1024
const MAX_TOTAL_LOG_BYTES = 2 * 1024 * 1024
const DIRECT_OUTPUT_BYTES = 128 * 1024
const DEBUGGER_OUTPUT_BYTES = 256 * 1024
const DIRECT_TIMEOUT_MS = 60_000
const DEBUGGER_TIMEOUT_MS = 180_000
const GLOBAL_TIMEOUT_MS = 12 * 60_000
const EXPECTED_TRANSPORT_NAMES = [
  'baseline-denort',
  'baseline-v8-archive',
  'baseline-ninja',
  'baseline-probe',
  'baseline-derived-relink-Cargo.lock',
  'baseline-slv',
  'baseline-bridge',
  'tls-localhost.crt',
  'tls-localhost.key',
  'tls-root-ca.pem',
  'modified-denort',
  'modified-v8-archive',
  'modified-ninja',
  'modified-probe',
] as const

export const DIAGNOSTIC_PROTOCOL = {
  repository: 'ValidatorsDAO/slv',
  workflowRef:
    'ValidatorsDAO/slv/.github/workflows/slv-remote-build.yml@refs/heads/codex/slv-eu-oss-delivery',
  oldRunId: '38628703267',
  oldRunAttempt: '1',
  oldArtifactId: '11935008486',
  oldSourceCommit: '65f20c1220729edf43403cf88d825c086b9b6cab',
  rawBuildReceiptSha256:
    '34524b1002ce72fa2b6fc80f66fc71f1e2e7faed82d427ccd34ed8cc7ada2ffc',
  rawTransportManifestSha256:
    '2b28871df5038a92e0c5e4e35f0857cbb2268d0bbc0787a9581f392183bcdf8c',
  target: 'aarch64-unknown-linux-gnu',
  baselineDenort: {
    name: 'baseline-denort',
    sha256: '47363a1e9bef08e4bd46cc0513e4d0789aa05e758a3ba9c9a481f787f30582eb',
    size: 194115912,
  },
  baselineProbe: {
    name: 'baseline-probe',
    sha256: '577602a291ec683389794d7b0197a6adad24ba18aab91f02901f87f64fb8ba9c',
    size: 194123800,
  },
} as const

type Args = {
  '--artifact-root': string
  '--out': string
  '--diagnostic-context': string
  '--reviewed-sha': string
}
type Entry = { path: string; sha256: string; size: number }
type ProgramIdentity = { name: string; sha256: string; size: number }
export type ArtifactExpectation = {
  buildReceiptSha256: string
  manifestSha256: string
  sourceCommit: string
  target: string
  programs: { denort: ProgramIdentity; probe: ProgramIdentity }
}
export type ArtifactValidation = {
  artifactRoot: string
  buildReceipt: string
  manifest: string
  denort: string
  probe: string
  buildReceiptSha256: string
  manifestSha256: string
  programMeasurements: Record<string, { sha256: string; size: number }>
}
export type DiagnosticContext = {
  schema_version: 1
  kind: 'slv-native-diagnostic-context'
  repository: 'ValidatorsDAO/slv'
  workflow_ref: string
  workflow_sha: string
  diagnostic_source_commit: string
  run_id: string
  run_attempt: string
}
export type ChildResult = {
  argv: string[]
  started_at: string
  finished_at: string
  exit_code: number | null
  signal: string | null
  timed_out: boolean
  deadline_expired?: boolean
  acquisition_error?: string
  stdout: {
    bytes: number
    retained_bytes: number
    truncated: boolean
    data: Uint8Array
  }
  stderr: {
    bytes: number
    retained_bytes: number
    truncated: boolean
    data: Uint8Array
  }
}
type ControlRecord = ChildResult & {
  name: 'baseline-denort' | 'baseline-probe'
  target_argv: string[]
  expected_bare_result?: boolean
}
type LogBudget = { retained: number; limit: number }
export type DiagnosticDeadline = {
  expiresAt: number
  expired: boolean
  activeChildren: Set<Deno.ChildProcess>
}

class DeadlineExceeded extends Error {
  constructor(message = 'global diagnostic deadline expired') {
    super(message)
    this.name = 'DeadlineExceeded'
  }
}

function deadlineExpired(deadline: DiagnosticDeadline | undefined): boolean {
  return !!deadline && (deadline.expired || Date.now() >= deadline.expiresAt)
}

function deadlineRemaining(deadline: DiagnosticDeadline | undefined): number {
  return deadline ? Math.max(0, deadline.expiresAt - Date.now()) : Infinity
}

export function startDiagnosticDeadline(timeoutMs = GLOBAL_TIMEOUT_MS): {
  deadline: DiagnosticDeadline
  stop: () => void
} {
  const deadline: DiagnosticDeadline = {
    expiresAt: Date.now() + timeoutMs,
    expired: false,
    activeChildren: new Set(),
  }
  const timer = setTimeout(() => {
    deadline.expired = true
    for (const child of deadline.activeChildren) {
      try {
        child.kill('SIGKILL')
      } catch {
        // The status promise below reaps children that exited concurrently.
      }
    }
  }, timeoutMs)
  return {
    deadline,
    stop: () => clearTimeout(timer),
  }
}

function zeroOutput(): ChildResult['stdout'] {
  return {
    bytes: 0,
    retained_bytes: 0,
    truncated: false,
    data: new Uint8Array(),
  }
}

function acquisitionFailure(
  executable: string,
  args: string[],
  error: unknown,
  expired = false,
): ChildResult {
  const now = new Date().toISOString()
  return {
    argv: [executable, ...args],
    started_at: now,
    finished_at: now,
    exit_code: null,
    signal: null,
    timed_out: expired,
    deadline_expired: expired || undefined,
    acquisition_error: error instanceof Error ? error.message : String(error),
    stdout: zeroOutput(),
    stderr: zeroOutput(),
  }
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`)
  }
  return value as Record<string, unknown>
}

function text(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value) {
    throw new Error(`${label} must be a non-empty string`)
  }
  return value
}

function sha(value: unknown, label: string): string {
  const result = text(value, label)
  if (!SHA256.test(result)) {
    throw new Error(`${label} must be a lower-case SHA-256`)
  }
  return result
}

function exactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
  label: string,
): void {
  if (
    Object.keys(value).length !== keys.length ||
    keys.some((key) => !(key in value))
  ) {
    throw new Error(`${label} has an unexpected key set`)
  }
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>
    return `{${
      Object.keys(record).sort().map((key) =>
        `${JSON.stringify(key)}:${stableJson(record[key])}`
      ).join(',')
    }}`
  }
  return JSON.stringify(value)
}

function equalJson(left: unknown, right: unknown): boolean {
  return stableJson(left) === stableJson(right)
}

async function sha256(
  path: string,
  deadline?: DiagnosticDeadline,
): Promise<string> {
  if (deadlineExpired(deadline)) throw new DeadlineExceeded()
  const file = await Deno.open(path)
  const hash = createHash('sha256')
  try {
    const buffer = new Uint8Array(1024 * 1024)
    for (;;) {
      if (deadlineExpired(deadline)) throw new DeadlineExceeded()
      const read = await file.read(buffer)
      if (read === null) break
      hash.update(buffer.subarray(0, read))
    }
  } finally {
    file.close()
  }
  return hash.digest('hex')
}

function absolute(path: string): string {
  return resolve(path)
}

async function regularFile(
  path: string,
  label: string,
): Promise<Deno.FileInfo> {
  const info = await Deno.lstat(path).catch(() => undefined)
  if (!info?.isFile || info.isSymlink) {
    throw new Error(`${label} must be a regular non-symlink file`)
  }
  return info
}

async function realDirectory(path: string, label: string): Promise<string> {
  const checked = absolute(path)
  const info = await Deno.lstat(checked).catch(() => undefined)
  if (!info?.isDirectory || info.isSymlink) {
    throw new Error(`${label} must be a real directory`)
  }
  return checked
}

function inside(root: string, candidate: string): boolean {
  const result = relative(root, candidate)
  return result !== '' && !result.startsWith('..') && !result.startsWith('/')
}

/** Reject symlinks at every artifact-root component without resolving them. */
async function safeArtifactFile(
  root: string,
  components: readonly string[],
  label: string,
): Promise<string> {
  if (
    !components.length ||
    components.some((part) =>
      !part || part === '.' || part === '..' || part.includes('/') ||
      part.includes('\\')
    )
  ) {
    throw new Error(`${label} has an unsafe fixed path`)
  }
  let current = root
  for (let index = 0; index < components.length; index += 1) {
    current = `${current}/${components[index]}`
    const info = await Deno.lstat(current).catch(() => undefined)
    if (!info || info.isSymlink) {
      throw new Error(`${label} has a missing or symlinked component`)
    }
    if (index + 1 === components.length) {
      if (!info.isFile) throw new Error(`${label} must be a regular file`)
    } else if (!info.isDirectory) {
      throw new Error(`${label} has a non-directory ancestor`)
    }
  }
  return current
}

function parseEntry(value: unknown, name: string): Entry {
  const entry = object(value, `transport entry ${name}`)
  exactKeys(entry, ['path', 'sha256', 'size'], `transport entry ${name}`)
  const path = text(entry.path, `transport entry ${name} path`)
  if (path !== name || path.includes('/') || path.includes('\\')) {
    throw new Error(`transport entry ${name} must use its basename-only path`)
  }
  if (!Number.isSafeInteger(entry.size) || (entry.size as number) <= 0) {
    throw new Error(`transport entry ${name} has an invalid size`)
  }
  return {
    path,
    sha256: sha(entry.sha256, `transport entry ${name} SHA-256`),
    size: entry.size as number,
  }
}

function parseEntries(value: unknown): Record<string, Entry> {
  const record = object(value, 'transport entries')
  exactKeys(record, EXPECTED_TRANSPORT_NAMES, 'transport entries')
  return Object.fromEntries(
    EXPECTED_TRANSPORT_NAMES.map((
      name,
    ) => [name, parseEntry(record[name], name)]),
  )
}

function frozenExpectation(): ArtifactExpectation {
  return {
    buildReceiptSha256: DIAGNOSTIC_PROTOCOL.rawBuildReceiptSha256,
    manifestSha256: DIAGNOSTIC_PROTOCOL.rawTransportManifestSha256,
    sourceCommit: DIAGNOSTIC_PROTOCOL.oldSourceCommit,
    target: DIAGNOSTIC_PROTOCOL.target,
    programs: {
      denort: DIAGNOSTIC_PROTOCOL.baselineDenort,
      probe: DIAGNOSTIC_PROTOCOL.baselineProbe,
    },
  }
}

/**
 * Validate stored old artifact bytes before a target program can be selected.
 * Tests may supply tiny identities here; the production entrypoint always
 * invokes this with the fixed observation above.
 */
export async function validateStoredArtifact(
  artifactRoot: string,
  expectation: ArtifactExpectation = frozenExpectation(),
  deadline?: DiagnosticDeadline,
): Promise<ArtifactValidation> {
  if (deadlineExpired(deadline)) throw new DeadlineExceeded()
  const root = await realDirectory(artifactRoot, 'artifact root')
  const buildReceipt = await safeArtifactFile(
    root,
    ['source-proofs', expectation.target, 'build-receipt.json'],
    'stored build receipt',
  )
  const manifest = await safeArtifactFile(
    root,
    ['source-proofs', expectation.target, 'transport', 'manifest.json'],
    'stored transport manifest',
  )
  const buildReceiptSha256 = await sha256(buildReceipt, deadline)
  const manifestSha256 = await sha256(manifest, deadline)
  if (buildReceiptSha256 !== expectation.buildReceiptSha256) {
    throw new Error(
      'stored build receipt raw bytes differ from the fixed artifact identity',
    )
  }
  if (manifestSha256 !== expectation.manifestSha256) {
    throw new Error(
      'stored transport manifest raw bytes differ from the fixed artifact identity',
    )
  }
  const build = object(
    JSON.parse(decoder.decode(await Deno.readFile(buildReceipt))),
    'stored build receipt',
  )
  const transport = object(
    JSON.parse(decoder.decode(await Deno.readFile(manifest))),
    'stored transport manifest',
  )
  if (deadlineExpired(deadline)) throw new DeadlineExceeded()
  if (
    build.schema_version !== 1 || build.kind !== 'slv-source-build-receipt' ||
    build.target !== expectation.target ||
    build.source_commit !== expectation.sourceCommit ||
    transport.schema_version !== 1 ||
    transport.kind !== 'slv-source-native-transport' ||
    transport.target !== expectation.target ||
    transport.source_receipt_sha256 !== build.source_receipt_sha256
  ) {
    throw new Error(
      'stored build and transport receipts do not bind the fixed old source artifact',
    )
  }
  const splitBuild = object(build.split_build, 'stored split build evidence')
  if (
    splitBuild.schema_version !== 1 ||
    splitBuild.kind !== 'slv-source-split-build-evidence'
  ) {
    throw new Error('stored split build evidence identity is invalid')
  }
  const buildTransport = object(
    build.transport,
    'stored build transport binding',
  )
  if (
    buildTransport.manifest !== 'transport/manifest.json' ||
    buildTransport.manifest_sha256 !== manifestSha256 ||
    !equalJson(build.artifacts, transport.artifacts)
  ) {
    throw new Error(
      'stored build receipt does not bind the raw transport manifest and artifacts',
    )
  }
  const entries = parseEntries(transport.entries)
  const programPaths: Record<string, string> = {}
  const programMeasurements: Record<string, { sha256: string; size: number }> =
    {}
  for (const [key, expected] of Object.entries(expectation.programs)) {
    const entry = entries[expected.name]
    if (
      !entry || entry.sha256 !== expected.sha256 || entry.size !== expected.size
    ) {
      throw new Error(
        `stored ${expected.name} manifest identity differs from the fixed executable identity`,
      )
    }
    const path = await safeArtifactFile(
      root,
      ['source-proofs', expectation.target, 'transport', entry.path],
      `stored ${expected.name}`,
    )
    const info = await regularFile(path, `stored ${expected.name}`)
    const digest = await sha256(path, deadline)
    if (info.size !== expected.size || digest !== expected.sha256) {
      throw new Error(
        `stored ${expected.name} bytes differ from the fixed executable identity`,
      )
    }
    programPaths[key] = path
    programMeasurements[expected.name] = { sha256: digest, size: info.size }
  }
  return {
    artifactRoot: root,
    buildReceipt,
    manifest,
    denort: programPaths.denort,
    probe: programPaths.probe,
    buildReceiptSha256,
    manifestSha256,
    programMeasurements,
  }
}

export function parseDiagnosticArgs(argv: string[]): Args {
  const flags = [
    '--artifact-root',
    '--out',
    '--diagnostic-context',
    '--reviewed-sha',
  ] as const
  if (argv.length !== flags.length * 2) {
    throw new Error(
      'diagnostic arguments must be exactly four unique --flag VALUE pairs',
    )
  }
  const values: Record<string, string> = {}
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index]
    const value = argv[index + 1]
    if (
      !flags.includes(flag as typeof flags[number]) || !value ||
      value.startsWith('--') || values[flag]
    ) {
      throw new Error(
        'diagnostic arguments must be exactly four unique --flag VALUE pairs',
      )
    }
    values[flag] = value
  }
  return values as Args
}

export function parseDiagnosticContext(value: unknown): DiagnosticContext {
  const context = object(value, 'diagnostic context')
  exactKeys(context, [
    'schema_version',
    'kind',
    'repository',
    'workflow_ref',
    'workflow_sha',
    'diagnostic_source_commit',
    'run_id',
    'run_attempt',
  ], 'diagnostic context')
  if (
    context.schema_version !== 1 ||
    context.kind !== 'slv-native-diagnostic-context' ||
    context.repository !== DIAGNOSTIC_PROTOCOL.repository ||
    context.workflow_ref !== DIAGNOSTIC_PROTOCOL.workflowRef
  ) {
    throw new Error(
      'diagnostic context does not bind the reviewed SLV workflow',
    )
  }
  for (const key of ['workflow_sha', 'diagnostic_source_commit'] as const) {
    if (!SHA40.test(text(context[key], `diagnostic context ${key}`))) {
      throw new Error(
        `diagnostic context ${key} must be a lower-case commit SHA`,
      )
    }
  }
  for (const key of ['run_id', 'run_attempt'] as const) {
    if (
      !POSITIVE_DECIMAL.test(text(context[key], `diagnostic context ${key}`))
    ) {
      throw new Error(
        `diagnostic context ${key} must be a positive decimal string`,
      )
    }
  }
  return context as unknown as DiagnosticContext
}

export function validateDiagnosticContext(
  context: DiagnosticContext,
  reviewedSha: string,
  checkoutSha: string,
): void {
  if (
    !SHA40.test(reviewedSha) || context.workflow_sha !== reviewedSha ||
    context.diagnostic_source_commit !== reviewedSha ||
    checkoutSha !== reviewedSha
  ) {
    throw new Error(
      'diagnostic context, reviewed SHA, and checked-out repository HEAD must match exactly',
    )
  }
  if (
    context.diagnostic_source_commit === DIAGNOSTIC_PROTOCOL.oldSourceCommit
  ) {
    throw new Error(
      'old stored source identity cannot be relabeled as the diagnostic reviewed SHA',
    )
  }
}

function cleanEnvironment(home: string): Record<string, string> {
  return { HOME: home, PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' }
}

async function drain(
  stream: ReadableStream<Uint8Array>,
  budget: LogBudget,
): Promise<
  {
    bytes: number
    retained_bytes: number
    truncated: boolean
    data: Uint8Array
  }
> {
  const chunks: Uint8Array[] = []
  let bytes = 0
  let retained = 0
  const reader = stream.getReader()
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      bytes += value.length
      const available = Math.max(0, budget.limit - budget.retained)
      if (available > 0) {
        const kept = value.subarray(0, available)
        if (kept.length) chunks.push(kept.slice())
        retained += kept.length
        budget.retained += kept.length
      }
    }
  } finally {
    reader.releaseLock()
  }
  const data = new Uint8Array(retained)
  let offset = 0
  for (const chunk of chunks) {
    data.set(chunk, offset)
    offset += chunk.length
  }
  return {
    bytes,
    retained_bytes: retained,
    truncated: retained !== bytes,
    data,
  }
}

/** Run a local child while draining all output and retaining only a bounded prefix. */
export async function runBoundedChild(
  executable: string,
  args: string[],
  options: {
    cwd: string
    home: string
    timeoutMs: number
    outputLimit: number
    deadline?: DiagnosticDeadline
  },
): Promise<ChildResult> {
  if (deadlineExpired(options.deadline)) throw new DeadlineExceeded()
  const started = new Date().toISOString()
  const child = new Deno.Command(executable, {
    args,
    cwd: options.cwd,
    clearEnv: true,
    env: cleanEnvironment(options.home),
    stdin: 'null',
    stdout: 'piped',
    stderr: 'piped',
  }).spawn()
  options.deadline?.activeChildren.add(child)
  let timedOut = false
  let timedOutByDeadline = false
  const timeoutMs = Math.min(
    options.timeoutMs,
    deadlineRemaining(options.deadline),
  )
  if (timeoutMs < 1) {
    options.deadline?.activeChildren.delete(child)
    try {
      child.kill('SIGKILL')
    } catch {
      // The status promise below reaps a child that exited concurrently.
    }
    await child.status.catch(() => undefined)
    throw new DeadlineExceeded()
  }
  const timer = setTimeout(() => {
    timedOut = true
    timedOutByDeadline = deadlineExpired(options.deadline) ||
      timeoutMs < options.timeoutMs
    try {
      child.kill('SIGKILL')
    } catch {
      // A naturally completed child is already reaped by status below.
    }
  }, timeoutMs)
  const budget = { retained: 0, limit: options.outputLimit }
  const statusPromise = child.status
  const stdoutPromise = drain(child.stdout, budget)
  const stderrPromise = drain(child.stderr, budget)
  try {
    const [status, stdout, stderr] = await Promise.all([
      statusPromise,
      stdoutPromise,
      stderrPromise,
    ])
    return {
      argv: [executable, ...args],
      started_at: started,
      finished_at: new Date().toISOString(),
      exit_code: status.code,
      signal: status.signal,
      timed_out: timedOut,
      deadline_expired:
        (timedOutByDeadline || deadlineExpired(options.deadline)) ||
        undefined,
      stdout,
      stderr,
    }
  } catch (error) {
    try {
      child.kill('SIGKILL')
    } catch {
      // The child already exited or the deadline watcher killed it.
    }
    await Promise.allSettled([statusPromise, stdoutPromise, stderrPromise])
    throw error
  } finally {
    clearTimeout(timer)
    options.deadline?.activeChildren.delete(child)
  }
}

function expectedBare(result: ChildResult): boolean {
  const output = decoder.decode(result.stdout.data) +
    decoder.decode(result.stderr.data)
  return !result.timed_out && result.signal === null &&
    result.exit_code === 1 &&
    output.includes('Could not find standalone binary section.')
}

export async function runMandatoryControls(
  bare: { executable: string; args: string[]; targetArgv?: string[] },
  probe: { executable: string; args: string[]; targetArgv?: string[] },
  options: {
    cwd: string
    home: string
    timeoutMs?: number
    outputLimit?: number
    deadline?: DiagnosticDeadline
  },
): Promise<{ bare: ControlRecord; probe: ControlRecord; complete: boolean }> {
  const timeoutMs = options.timeoutMs ?? DIRECT_TIMEOUT_MS
  const outputLimit = options.outputLimit ?? DIRECT_OUTPUT_BYTES
  const attempt = async (
    invocation: { executable: string; args: string[] },
  ): Promise<ChildResult> => {
    try {
      return await runBoundedChild(invocation.executable, invocation.args, {
        cwd: options.cwd,
        home: options.home,
        timeoutMs,
        outputLimit,
        deadline: options.deadline,
      })
    } catch (error) {
      return acquisitionFailure(
        invocation.executable,
        invocation.args,
        error,
        deadlineExpired(options.deadline) || error instanceof DeadlineExceeded,
      )
    }
  }
  const bareResult = await attempt(bare)
  // This is deliberately unconditional. A bare crash is evidence, not a
  // reason to skip the packaged control that differentiates it.
  const probeResult = await attempt(probe)
  const bareRecord: ControlRecord = {
    ...bareResult,
    name: 'baseline-denort',
    target_argv: bare.targetArgv ?? [bare.executable, ...bare.args],
    expected_bare_result: expectedBare(bareResult),
  }
  const probeRecord: ControlRecord = {
    ...probeResult,
    name: 'baseline-probe',
    target_argv: probe.targetArgv ?? [probe.executable, ...probe.args],
  }
  return {
    bare: bareRecord,
    probe: probeRecord,
    complete: bareRecord.expected_bare_result === true &&
      !bareRecord.acquisition_error && !bareRecord.deadline_expired &&
      !probeRecord.acquisition_error && !probeRecord.deadline_expired &&
      !probeRecord.timed_out &&
      probeRecord.signal === null && probeRecord.exit_code === 0,
  }
}

async function findTrustedUtility(
  paths: readonly string[],
): Promise<string | undefined> {
  for (const path of paths) {
    const info = await Deno.lstat(path).catch(() => undefined)
    if (info?.isFile && !info.isSymlink && ((info.mode ?? 0) & 0o111) !== 0) {
      return path
    }
  }
  return undefined
}

async function writeLog(path: string, data: Uint8Array): Promise<void> {
  await Deno.writeFile(path, data)
}

async function writeControlLogs(
  out: string,
  prefix: string,
  result: ChildResult,
): Promise<void> {
  await writeLog(`${out}/${prefix}.stdout.log`, result.stdout.data)
  await writeLog(`${out}/${prefix}.stderr.log`, result.stderr.data)
}

async function metadataCommand(
  executable: string,
  args: string[],
  cwd: string,
  home: string,
  deadline?: DiagnosticDeadline,
): Promise<{ available: boolean; result?: ChildResult }> {
  if (deadlineExpired(deadline)) return { available: false }
  const info = await Deno.lstat(executable).catch(() => undefined)
  if (
    !info?.isFile || info.isSymlink || ((info.mode ?? 0) & 0o111) === 0
  ) {
    return { available: false }
  }
  return {
    available: true,
    result: await runBoundedChild(executable, args, {
      cwd,
      home,
      timeoutMs: 10_000,
      outputLimit: 64 * 1024,
      deadline,
    }),
  }
}

async function collectPlatformMetadata(
  out: string,
  cwd: string,
  home: string,
  deadline?: DiagnosticDeadline,
): Promise<Record<string, unknown>> {
  const commands = [
    ['uname', '/usr/bin/uname', ['-a']],
    ['uname_machine', '/usr/bin/uname', ['-m']],
    ['lscpu', '/usr/bin/lscpu', []],
    ['pagesize', '/usr/bin/getconf', ['PAGESIZE']],
  ] as const
  const result: Record<string, unknown> = {}
  let retainedLogBytes = 0
  let logsTruncated = false
  for (const [name, executable, args] of commands) {
    const record = await metadataCommand(
      executable,
      [...args],
      cwd,
      home,
      deadline,
    )
    result[name] = record.available
      ? {
        available: true,
        exit_code: record.result!.exit_code,
        signal: record.result!.signal,
        timed_out: record.result!.timed_out,
        stdout_bytes: record.result!.stdout.bytes,
        stdout_retained_bytes: record.result!.stdout.retained_bytes,
        stdout_truncated: record.result!.stdout.truncated,
        stderr_bytes: record.result!.stderr.bytes,
        stderr_retained_bytes: record.result!.stderr.retained_bytes,
        stderr_truncated: record.result!.stderr.truncated,
        value: name === 'uname_machine'
          ? decoder.decode(record.result!.stdout.data).trim()
          : undefined,
      }
      : { available: false }
    if (record.result) {
      retainedLogBytes += record.result.stdout.retained_bytes +
        record.result.stderr.retained_bytes
      logsTruncated ||= record.result.stdout.truncated ||
        record.result.stderr.truncated
      await writeControlLogs(out, `metadata-${name}`, record.result)
    }
  }
  const limits = await Deno.readTextFile('/proc/self/limits').catch(() =>
    undefined
  )
  const stack = limits?.split('\n').find((line) =>
    line.startsWith('Max stack size')
  )
  result.stack_limit = stack
    ? { available: true, value: stack }
    : { available: false }
  result.diagnostic_log_bytes = {
    retained_bytes: retainedLogBytes,
    truncated: logsTruncated,
  }
  return result
}

function summaryRecord(result: ChildResult): Record<string, unknown> {
  return {
    argv: result.argv,
    started_at: result.started_at,
    finished_at: result.finished_at,
    exit_code: result.exit_code,
    signal: result.signal,
    timed_out: result.timed_out,
    deadline_expired: result.deadline_expired === true,
    acquisition_error: result.acquisition_error,
    stdout: {
      bytes: result.stdout.bytes,
      retained_bytes: result.stdout.retained_bytes,
      truncated: result.stdout.truncated,
    },
    stderr: {
      bytes: result.stderr.bytes,
      retained_bytes: result.stderr.retained_bytes,
      truncated: result.stderr.truncated,
    },
  }
}

function controlSummary(result: ControlRecord): Record<string, unknown> {
  return {
    ...summaryRecord(result),
    name: result.name,
    target_argv: result.target_argv,
    expected_bare_result: result.expected_bare_result,
  }
}

function diagnosticRepositoryRoot(): string {
  return resolve(fileURLToPath(new URL('..', import.meta.url)))
}

async function checkedGitHead(
  repositoryRoot: string,
  home: string,
  deadline?: DiagnosticDeadline,
): Promise<string> {
  const git = await findTrustedUtility(['/usr/bin/git', '/bin/git'])
  if (!git) {
    throw new Error(
      'trusted git is unavailable for diagnostic checkout validation',
    )
  }
  const result = await runBoundedChild(git, [
    '-C',
    repositoryRoot,
    'rev-parse',
    'HEAD',
  ], {
    cwd: repositoryRoot,
    home,
    timeoutMs: 10_000,
    outputLimit: 4096,
    deadline,
  })
  const value = decoder.decode(result.stdout.data).trim()
  if (
    result.exit_code !== 0 || result.signal !== null || result.timed_out ||
    !SHA40.test(value)
  ) {
    throw new Error('cannot read the actual diagnostic repository HEAD')
  }
  return value
}

async function prepareOutput(
  path: string,
  artifactRoot: string,
): Promise<string> {
  const out = absolute(path)
  const root = absolute(artifactRoot)
  if (out === root || inside(root, out)) {
    throw new Error('diagnostic output must be outside the artifact root')
  }
  const existing = await Deno.lstat(out).catch(() => undefined)
  if (existing) {
    if (!existing.isDirectory || existing.isSymlink) {
      throw new Error('diagnostic output must be a real fresh directory')
    }
    for await (const _entry of Deno.readDir(out)) {
      void _entry
      throw new Error('diagnostic output must be empty')
    }
  } else {
    await Deno.mkdir(out, { recursive: true })
  }
  return out
}

export async function writeDiagnosticSummary(
  out: string,
  value: Record<string, unknown>,
): Promise<void> {
  const bytes = encoder.encode(JSON.stringify(value, null, 2) + '\n')
  if (bytes.length > MAX_SUMMARY_BYTES) {
    throw new Error('diagnostic summary exceeds its 64 KiB bound')
  }
  await Deno.writeFile(`${out}/diagnostic-summary.json`, bytes)
}

async function runDebugger(
  target: string,
  args: string[],
  out: string,
  cwd: string,
  home: string,
  prlimit: string,
  deadline: DiagnosticDeadline,
): Promise<Record<string, unknown>> {
  const gdb = await findTrustedUtility(['/usr/bin/gdb', '/bin/gdb'])
  const timeout = await findTrustedUtility(['/usr/bin/timeout', '/bin/timeout'])
  if (!gdb) {
    return { status: 'unavailable', reason: 'trusted gdb is not installed' }
  }
  if (!timeout) {
    return { status: 'unavailable', reason: 'trusted timeout is not installed' }
  }
  if (deadlineRemaining(deadline) < DEBUGGER_TIMEOUT_MS + 10_000) {
    return {
      status: 'incomplete',
      reason:
        'global diagnostic deadline leaves insufficient time for debugger',
    }
  }
  const gdbArgs = [
    '-q',
    '-nx',
    '-batch',
    '-ex',
    'set pagination off',
    '-ex',
    'set confirm off',
    '-ex',
    'set debuginfod enabled off',
    '-ex',
    'set auto-load python-scripts off',
    '-ex',
    'set auto-load gdb-scripts off',
    '-ex',
    'set disable-randomization off',
    '-ex',
    'set startup-with-shell off',
    '-ex',
    'handle SIGSEGV SIGBUS SIGILL SIGABRT stop print nopass',
    '-ex',
    'run',
    '-ex',
    'info program',
    '-ex',
    'p $_siginfo',
    '-ex',
    'info registers',
    '-ex',
    'x/12i $pc',
    '-ex',
    'thread apply all bt 24',
    '-ex',
    'info sharedlibrary',
    '-ex',
    'info proc mappings',
    '--args',
    target,
    ...args,
  ]
  const result = await runBoundedChild(prlimit, [
    '--core=0:0',
    '--',
    timeout,
    '--kill-after=5s',
    '180s',
    gdb,
    ...gdbArgs,
  ], {
    cwd,
    home,
    timeoutMs: DEBUGGER_TIMEOUT_MS + 10_000,
    outputLimit: DEBUGGER_OUTPUT_BYTES,
    deadline,
  })
  await writeControlLogs(
    out,
    `debugger-${target.slice(target.lastIndexOf('/') + 1)}`,
    result,
  )
  return {
    status: 'attempted',
    gdb_argv: [gdb, ...gdbArgs],
    result: summaryRecord(result),
    retained_log_bytes: result.stdout.retained_bytes +
      result.stderr.retained_bytes,
    log_truncated: result.stdout.truncated || result.stderr.truncated,
  }
}

function debuggerLogBudget(records: readonly Record<string, unknown>[]): {
  retainedBytes: number
  truncated: boolean
} {
  let retainedBytes = 0
  let truncated = false
  for (const record of records) {
    if (typeof record.retained_log_bytes === 'number') {
      retainedBytes += record.retained_log_bytes
    }
    truncated ||= record.log_truncated === true
  }
  return { retainedBytes, truncated }
}

export type DiagnosticControlPhase = {
  controls: {
    bare: ControlRecord
    probe: ControlRecord
    complete: boolean
  }
  debugger_records: Record<string, unknown>[]
  missing_evidence: string[]
}

export function diagnosticControlSummary(
  phase: DiagnosticControlPhase,
): Record<string, unknown> {
  return {
    controls: {
      bare: controlSummary(phase.controls.bare),
      probe: controlSummary(phase.controls.probe),
    },
    debugger_records: phase.debugger_records,
    missing_evidence: phase.missing_evidence,
  }
}

/**
 * Acquire both fixed controls and any permitted debugger records.  This stays
 * local to the diagnostic helper so a launch/log/debugger failure cannot erase
 * the direct control record that led to it.
 */
export async function runDiagnosticControlPhase(
  input: {
    bare: { executable: string; args: string[]; targetArgv?: string[] }
    probe: { executable: string; args: string[]; targetArgv?: string[] }
    cwd: string
    home: string
    out: string
    deadline: DiagnosticDeadline
  },
  debuggerForTarget: (
    target: string,
    args: string[],
  ) => Promise<Record<string, unknown>>,
): Promise<DiagnosticControlPhase> {
  const controls = await runMandatoryControls(input.bare, input.probe, {
    cwd: input.cwd,
    home: input.home,
    timeoutMs: DIRECT_TIMEOUT_MS,
    outputLimit: DIRECT_OUTPUT_BYTES,
    deadline: input.deadline,
  })
  const missingEvidence: string[] = []
  for (
    const [prefix, control] of [
      ['baseline-denort', controls.bare],
      ['baseline-probe', controls.probe],
    ] as const
  ) {
    await writeControlLogs(input.out, prefix, control).catch((error) => {
      missingEvidence.push(
        `${prefix} log write failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      )
    })
  }
  const debuggerRecords: Record<string, unknown>[] = []
  const collectDebugger = async (
    control: ControlRecord,
    target: string | undefined,
    args: string[],
  ): Promise<void> => {
    if (control.acquisition_error) {
      missingEvidence.push(
        `${control.name} debugger skipped after acquisition error`,
      )
      return
    }
    if (!target) {
      missingEvidence.push(`${control.name} debugger target is unavailable`)
      return
    }
    try {
      const record = await debuggerForTarget(target, args)
      debuggerRecords.push(record)
      if (
        record.status === 'unavailable' || record.status === 'incomplete' ||
        record.status === 'acquisition-failed'
      ) {
        missingEvidence.push(`${control.name} debugger: ${record.status}`)
      }
    } catch (error) {
      debuggerRecords.push({
        status: 'acquisition-failed',
        acquisition_error: error instanceof Error
          ? error.message
          : String(error),
      })
      missingEvidence.push(`${control.name} debugger acquisition failed`)
    }
  }
  if (!controls.bare.expected_bare_result) {
    await collectDebugger(
      controls.bare,
      controls.bare.target_argv[0],
      controls.bare.target_argv.slice(1),
    )
  }
  if (
    controls.probe.exit_code !== 0 || controls.probe.signal !== null ||
    controls.probe.timed_out || controls.probe.acquisition_error ||
    controls.probe.deadline_expired
  ) {
    await collectDebugger(
      controls.probe,
      controls.probe.target_argv[0],
      controls.probe.target_argv.slice(1),
    )
  }
  if (controls.bare.deadline_expired || controls.probe.deadline_expired) {
    missingEvidence.push(
      'global diagnostic deadline interrupted control acquisition',
    )
  }
  return {
    controls,
    debugger_records: debuggerRecords,
    missing_evidence: missingEvidence,
  }
}

/** Production entrypoint. Returns a diagnostic acquisition status, never proof status. */
export async function diagnoseNative(args: Args): Promise<number> {
  let out: string | undefined
  let privateHome: string | undefined
  const started = new Date().toISOString()
  const watchdog = startDiagnosticDeadline()
  const { deadline } = watchdog
  const missingEvidence: string[] = []
  let context: DiagnosticContext | undefined
  let validation: ArtifactValidation | undefined
  let platform: Record<string, unknown> | undefined
  let phase: DiagnosticControlPhase | undefined
  try {
    out = await prepareOutput(args['--out'], args['--artifact-root'])
    const output = out
    const home = `${output}/private-home`
    await Deno.mkdir(home)
    privateHome = home
    const repositoryRoot = diagnosticRepositoryRoot()
    const contextPath = absolute(args['--diagnostic-context'])
    await regularFile(contextPath, 'diagnostic context')
    context = parseDiagnosticContext(
      JSON.parse(await Deno.readTextFile(contextPath)),
    )
    const checkoutSha = await checkedGitHead(repositoryRoot, home, deadline)
    validateDiagnosticContext(context, args['--reviewed-sha'], checkoutSha)
    validation = await validateStoredArtifact(
      args['--artifact-root'],
      frozenExpectation(),
      deadline,
    )
    platform = await collectPlatformMetadata(
      out,
      repositoryRoot,
      home,
      deadline,
    )
    const uname = platform.uname as Record<string, unknown>
    const unameMachine = platform.uname_machine as Record<string, unknown>
    if (
      Deno.build.os !== 'linux' || Deno.build.arch !== 'aarch64' ||
      uname.exit_code !== 0 || unameMachine.exit_code !== 0 ||
      unameMachine.value !== 'aarch64'
    ) {
      throw new Error(
        'native Linux ARM64 is required before diagnostic target execution',
      )
    }
    const prlimit = await findTrustedUtility([
      '/usr/bin/prlimit',
      '/bin/prlimit',
    ])
    if (!prlimit) {
      throw new Error(
        'trusted prlimit is required to disable core files before target execution',
      )
    }
    await Deno.chmod(validation.denort, 0o755)
    await Deno.chmod(validation.probe, 0o755)
    phase = await runDiagnosticControlPhase(
      {
        bare: {
          executable: prlimit,
          args: ['--core=0:0', '--', validation.denort],
          targetArgv: [validation.denort],
        },
        probe: {
          executable: prlimit,
          args: ['--core=0:0', '--', validation.probe, '0.125'],
          targetArgv: [validation.probe, '0.125'],
        },
        cwd: repositoryRoot,
        home,
        out: output,
        deadline,
      },
      (target, targetArgs) =>
        runDebugger(
          target,
          targetArgs,
          output,
          repositoryRoot,
          home,
          prlimit,
          deadline,
        ),
    )
    missingEvidence.push(...phase.missing_evidence)
    const finalDenort = {
      sha256: await sha256(validation.denort, deadline),
      size: (await Deno.stat(validation.denort)).size,
    }
    const finalProbe = {
      sha256: await sha256(validation.probe, deadline),
      size: (await Deno.stat(validation.probe)).size,
    }
    const unchanged = equalJson(
      finalDenort,
      validation.programMeasurements['baseline-denort'],
    ) &&
      equalJson(finalProbe, validation.programMeasurements['baseline-probe'])
    if (!unchanged) {
      missingEvidence.push('executed stored bytes changed unexpectedly')
    }
    const success = phase.controls.complete && unchanged &&
      missingEvidence.length === 0
    const controlLogBytes = phase.controls.bare.stdout.retained_bytes +
      phase.controls.bare.stderr.retained_bytes +
      phase.controls.probe.stdout.retained_bytes +
      phase.controls.probe.stderr.retained_bytes
    const platformLogBytes = platform.diagnostic_log_bytes as Record<
      string,
      unknown
    >
    const debuggerLogs = debuggerLogBudget(phase.debugger_records)
    const retainedLogBytes = controlLogBytes +
      (typeof platformLogBytes.retained_bytes === 'number'
        ? platformLogBytes.retained_bytes
        : 0) +
      debuggerLogs.retainedBytes
    const logsTruncated = phase.controls.bare.stdout.truncated ||
      phase.controls.bare.stderr.truncated ||
      phase.controls.probe.stdout.truncated ||
      phase.controls.probe.stderr.truncated ||
      platformLogBytes.truncated === true ||
      debuggerLogs.truncated
    if (retainedLogBytes > MAX_TOTAL_LOG_BYTES) {
      throw new Error('diagnostic retained logs exceeded the 2 MiB bound')
    }
    const controlEvidence = diagnosticControlSummary(phase)
    await writeDiagnosticSummary(out, {
      schema_version: 1,
      kind: 'slv-native-diagnostic',
      status: success ? 'diagnostic-recorded' : 'acquisition-failed',
      started_at: started,
      finished_at: new Date().toISOString(),
      diagnostic_context: context,
      old_artifact: DIAGNOSTIC_PROTOCOL,
      validation: {
        passed: true,
        build_receipt_sha256: validation.buildReceiptSha256,
        transport_manifest_sha256: validation.manifestSha256,
        executed_bytes_before: validation.programMeasurements,
        executed_bytes_unchanged: unchanged,
        executed_bytes_after: {
          'baseline-denort': finalDenort,
          'baseline-probe': finalProbe,
        },
      },
      platform,
      ...controlEvidence,
      log_budget: {
        retained_bytes: retainedLogBytes,
        limit: MAX_TOTAL_LOG_BYTES,
        truncated: logsTruncated,
      },
      missing_evidence: missingEvidence,
    })
    return success ? 0 : 1
  } catch (error) {
    missingEvidence.push(
      error instanceof Error ? error.message : String(error),
    )
    if (deadlineExpired(deadline)) {
      missingEvidence.push('global diagnostic deadline expired')
    }
    if (out) {
      await writeDiagnosticSummary(out, {
        schema_version: 1,
        kind: 'slv-native-diagnostic',
        status: 'acquisition-failed',
        started_at: started,
        finished_at: new Date().toISOString(),
        diagnostic_context: context,
        old_artifact: DIAGNOSTIC_PROTOCOL,
        validation: validation
          ? {
            passed: true,
            build_receipt_sha256: validation.buildReceiptSha256,
            transport_manifest_sha256: validation.manifestSha256,
            executed_bytes_before: validation.programMeasurements,
          }
          : { passed: false },
        platform,
        controls: phase
          ? {
            bare: controlSummary(phase.controls.bare),
            probe: controlSummary(phase.controls.probe),
          }
          : undefined,
        debugger_records: phase?.debugger_records ?? [],
        missing_evidence: [
          ...(phase?.missing_evidence ?? []),
          ...missingEvidence,
        ],
      }).catch(() => undefined)
    }
    return 1
  } finally {
    watchdog.stop()
    if (privateHome) {
      await Deno.remove(privateHome, { recursive: true }).catch(() => undefined)
    }
  }
}

if (import.meta.main) {
  let exitCode = 1
  try {
    exitCode = await diagnoseNative(parseDiagnosticArgs(Deno.args))
  } catch (error) {
    console.error(error instanceof Error ? error.message : error)
  }
  Deno.exit(exitCode)
}
