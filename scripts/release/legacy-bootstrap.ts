/**
 * One-shot, reviewed transition of the legacy public installer object.
 * This intentionally has no retry or compare-and-swap claim: its receipt makes
 * the remaining non-atomic window visible to the release operator.
 */
import { createHash } from 'node:crypto'
import { assertVersion } from './release.ts'

const CF = 'https://api.cloudflare.com/client/v4'
const GH = 'https://api.github.com'
const ACCOUNT = 'CLOUDFLARE_ACCOUNT_ID'
const TOKEN = 'CLOUDFLARE_API_TOKEN'
const bucket = 'slv'
const objectKey = 'slv/install'
const domain = 'storage.slv.dev'
const repo = 'ValidatorsDAO/slv'
const REQUEST_TIMEOUT_MS = 30_000
const JSON_LIMIT_BYTES = 1024 * 1024
const INSTALLER_LIMIT_BYTES = 8 * 1024 * 1024
const MAX_TAG_PEEL_DEPTH = 8
const sha256 = (bytes: Uint8Array | string) =>
  createHash('sha256').update(bytes).digest('hex')
const SHA40 = /^[a-f0-9]{40}$/
const SHA256 = /^[a-f0-9]{64}$/

type Options = {
  operation: 'preflight' | 'apply'
  version: string
  outputDir: string
  sourceSha?: string
  expectedPreimageSha256?: string
  expectedPayloadSha256?: string
}
type Statuses = Record<string, number | null>
type Stage =
  | 'domain'
  | 'initial_authenticated_preimage'
  | 'public_preimage'
  | 'release'
  | 'ref'
  | 'tag_peel_1'
  | 'tag_peel_2'
  | 'tag_peel_3'
  | 'tag_peel_4'
  | 'tag_peel_5'
  | 'tag_peel_6'
  | 'tag_peel_7'
  | 'tag_peel_8'
  | 'fresh_authenticated_preimage'
  | 'put'
  | 'authenticated_readback'
  | 'public_readback'
type StageReason =
  | 'request'
  | 'timeout'
  | 'http'
  | 'body'
  | 'body_too_large'
  | 'json'
  | 'shape'
  | 'unsuccessful'

class LegacyBootstrapError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
    this.name = 'LegacyBootstrapError'
  }
}

const stageName: Record<Stage, string> = {
  domain: 'custom domain',
  initial_authenticated_preimage: 'initial authenticated preimage',
  public_preimage: 'public preimage',
  release: 'GitHub release',
  ref: 'GitHub tag ref',
  tag_peel_1: 'GitHub annotated tag',
  tag_peel_2: 'GitHub annotated tag',
  tag_peel_3: 'GitHub annotated tag',
  tag_peel_4: 'GitHub annotated tag',
  tag_peel_5: 'GitHub annotated tag',
  tag_peel_6: 'GitHub annotated tag',
  tag_peel_7: 'GitHub annotated tag',
  tag_peel_8: 'GitHub annotated tag',
  fresh_authenticated_preimage: 'fresh authenticated preimage',
  put: 'object upload',
  authenticated_readback: 'authenticated readback',
  public_readback: 'public readback',
}

function failure(code: string, message: string): never {
  throw new LegacyBootstrapError(code, message)
}

function inputFailure(code: string, message: string): never {
  failure(`E_INPUT_${code}`, message)
}

function stageFailure(stage: Stage, reason: StageReason): never {
  const label = stageName[stage]
  const messages: Record<StageReason, string> = {
    request: `${label} request failed`,
    timeout: `${label} request timed out`,
    http: `${label} returned an unsuccessful HTTP response`,
    body: `${label} response body could not be read`,
    body_too_large: `${label} response body exceeds its size limit`,
    json: `${label} response JSON is invalid`,
    shape: `${label} response has an invalid shape`,
    unsuccessful: `${label} Cloudflare envelope was unsuccessful`,
  }
  failure(`E_${stage.toUpperCase()}_${reason.toUpperCase()}`, messages[reason])
}

function asSafeFailure(
  error: unknown,
  code: string,
  message: string,
): LegacyBootstrapError {
  if (error instanceof LegacyBootstrapError) return error
  return new LegacyBootstrapError(code, message)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function parseArgs(args: string[]): Options {
  const [operation, ...rest] = args
  if (operation !== 'preflight' && operation !== 'apply') {
    inputFailure(
      'USAGE',
      'usage: legacy-bootstrap.ts preflight|apply --version VERSION --output-dir EXCLUSIVE [--source-sha SHA] [--expected-preimage-sha256 SHA] [--expected-payload-sha256 SHA]',
    )
  }
  const values = new Map<string, string>()
  for (let index = 0; index < rest.length; index += 2) {
    const flag = rest[index]
    const value = rest[index + 1]
    if (
      ![
        '--version',
        '--output-dir',
        '--source-sha',
        '--expected-preimage-sha256',
        '--expected-payload-sha256',
      ].includes(flag) || value === undefined || values.has(flag)
    ) inputFailure('FLAGS', 'invalid or duplicate flag')
    values.set(flag, value)
  }
  const version = values.get('--version')
  const outputDir = values.get('--output-dir')
  if (!version || !outputDir) {
    inputFailure('REQUIRED', '--version and --output-dir are required')
  }
  try {
    assertVersion(version)
  } catch {
    inputFailure('VERSION', 'version is invalid')
  }
  const sourceSha = values.get('--source-sha')
  const expectedPreimageSha256 = values.get('--expected-preimage-sha256')
  const expectedPayloadSha256 = values.get('--expected-payload-sha256')
  if (sourceSha && !SHA40.test(sourceSha)) {
    inputFailure('SOURCE_SHA', 'source SHA must be lower-case 40 hex')
  }
  for (const value of [expectedPreimageSha256, expectedPayloadSha256]) {
    if (value && !SHA256.test(value)) {
      inputFailure(
        'EXPECTED_SHA256',
        'expected SHA-256 must be lower-case 64 hex',
      )
    }
  }
  if (
    operation === 'apply' &&
    (!sourceSha || !expectedPreimageSha256 || !expectedPayloadSha256)
  ) {
    inputFailure(
      'APPLY_INPUTS',
      'apply requires source SHA and both expected SHA-256 values',
    )
  }
  return {
    operation,
    version,
    outputDir,
    sourceSha,
    expectedPreimageSha256,
    expectedPayloadSha256,
  }
}

export function stopPayload(version: string, sourceSha: string): Uint8Array {
  const body =
    `#!/bin/sh\nprintf '%s\\n' 'STOP: Legacy SLV bootstrap has moved to verified immutable releases.' >&2\nprintf '%s\\n' 'Release: v${version}' >&2\nprintf '%s\\n' 'Reviewed source commit: ${sourceSha}' >&2\nprintf '%s\\n' "Download commit-pinned installer: curl --fail --show-error --silent --proto '=https' --tlsv1.2 --output ./slv-install-reviewed.sh 'https://raw.githubusercontent.com/ValidatorsDAO/slv/${sourceSha}/sh/install'" >&2\nprintf '%s\\n' 'Inspect before execution: less ./slv-install-reviewed.sh' >&2\nprintf '%s\\n' 'After review explicit legacy target: sh ./slv-install-reviewed.sh --install-path /usr/local/bin/slv' >&2\nexit 1\n`
  return new TextEncoder().encode(body)
}

function secret(name: string): string {
  try {
    const value = Deno.env.get(name)
    if (!value) {
      failure(
        'E_CREDENTIALS_MISSING',
        'required Cloudflare credentials are missing',
      )
    }
    return value
  } catch (error) {
    if (error instanceof LegacyBootstrapError) throw error
    failure('E_CREDENTIALS_READ', 'Cloudflare credentials could not be read')
  }
}

function cfHeaders(token: string): HeadersInit {
  return { authorization: `Bearer ${token}` }
}

async function ensureOutput(path: string): Promise<void> {
  try {
    const existing = await Deno.lstat(path)
    if (existing.isSymlink || !existing.isDirectory) {
      failure('E_OUTPUT_UNSAFE', 'output directory is unsafe')
    }
    failure('E_OUTPUT_EXISTS', 'output directory already exists')
  } catch (error) {
    if (error instanceof LegacyBootstrapError) throw error
    if (!(error instanceof Deno.errors.NotFound)) {
      failure('E_OUTPUT_INSPECTION', 'output directory could not be inspected')
    }
  }
  try {
    await Deno.mkdir(path, { recursive: false })
    const created = await Deno.lstat(path)
    if (created.isSymlink || !created.isDirectory) {
      failure('E_OUTPUT_UNSAFE', 'output directory is unsafe')
    }
  } catch (error) {
    if (error instanceof LegacyBootstrapError) throw error
    failure('E_OUTPUT_CREATE', 'output directory could not be created')
  }
}

async function writeJson(
  path: string,
  value: unknown,
  code: string,
): Promise<void> {
  try {
    await Deno.writeTextFile(path, JSON.stringify(value, null, 2) + '\n')
  } catch {
    failure(code, 'evidence file could not be written')
  }
}

async function writeBytes(
  path: string,
  value: Uint8Array,
  code: string,
): Promise<void> {
  try {
    await Deno.writeFile(path, value)
  } catch {
    failure(code, 'evidence file could not be written')
  }
}

async function boundedBytes(
  response: Response,
  stage: Stage,
  signal: AbortSignal,
  limit: number,
): Promise<Uint8Array> {
  const body = response.body
  if (!body) return new Uint8Array()
  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let length = 0
  try {
    while (true) {
      const part = await reader.read()
      if (part.done) break
      length += part.value.byteLength
      if (length > limit) {
        try {
          await reader.cancel()
        } catch {
          // The bounded failure below is still the only operator-visible result.
        }
        stageFailure(stage, 'body_too_large')
      }
      chunks.push(part.value)
    }
  } catch (error) {
    if (error instanceof LegacyBootstrapError) throw error
    if (signal.aborted) stageFailure(stage, 'timeout')
    stageFailure(stage, 'body')
  } finally {
    reader.releaseLock()
  }
  const value = new Uint8Array(length)
  let offset = 0
  for (const chunk of chunks) {
    value.set(chunk, offset)
    offset += chunk.byteLength
  }
  return value
}

async function request<T>(
  stage: Stage,
  url: string,
  init: RequestInit,
  statuses: Statuses,
  consume: (response: Response, signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  let result: Response
  try {
    result = await fetch(url, {
      ...init,
      redirect: 'error',
      signal: controller.signal,
    })
  } catch {
    clearTimeout(timeout)
    if (controller.signal.aborted) stageFailure(stage, 'timeout')
    stageFailure(stage, 'request')
  }
  try {
    statuses[stage] = result.status
    if (!result.ok) stageFailure(stage, 'http')
    return await consume(result, controller.signal)
  } catch (error) {
    if (error instanceof LegacyBootstrapError) throw error
    if (controller.signal.aborted) stageFailure(stage, 'timeout')
    stageFailure(stage, 'body')
  } finally {
    clearTimeout(timeout)
  }
}

function parsePlainJson(
  bytes: Uint8Array,
  stage: Stage,
): Record<string, unknown> {
  try {
    const value = JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(bytes),
    )
    if (!isRecord(value)) stageFailure(stage, 'shape')
    return value
  } catch (error) {
    if (error instanceof LegacyBootstrapError) throw error
    stageFailure(stage, 'json')
  }
}

function parseCfEnvelope(
  bytes: Uint8Array,
  stage: Stage,
): Record<string, unknown> {
  const envelope = parsePlainJson(bytes, stage)
  if (envelope.success !== true) stageFailure(stage, 'unsuccessful')
  if (!isRecord(envelope.result)) stageFailure(stage, 'shape')
  return envelope.result
}

async function githubJson(
  stage: Stage,
  url: string,
  statuses: Statuses,
): Promise<Record<string, unknown>> {
  return await request(
    stage,
    url,
    { headers: { accept: 'application/vnd.github+json' } },
    statuses,
    async (response, signal) =>
      parsePlainJson(
        await boundedBytes(response, stage, signal, JSON_LIMIT_BYTES),
        stage,
      ),
  )
}

async function cloudflareJson(
  stage: Stage,
  url: string,
  init: RequestInit,
  statuses: Statuses,
): Promise<Record<string, unknown>> {
  return await request(
    stage,
    url,
    init,
    statuses,
    async (response, signal) =>
      parseCfEnvelope(
        await boundedBytes(response, stage, signal, JSON_LIMIT_BYTES),
        stage,
      ),
  )
}

type ByteResponse = {
  bytes: Uint8Array
  status: number
  metadata?: Record<string, string>
}

function initialMetadata(response: Response): Record<string, string> {
  const metadata: Record<string, string> = {}
  for (
    const name of [
      'content-type',
      'content-disposition',
      'cache-control',
      'etag',
      'last-modified',
    ]
  ) {
    const value = response.headers.get(name)
    if (value !== null) metadata[name] = value
  }
  return metadata
}

async function objectBytes(
  stage: Stage,
  url: string,
  init: RequestInit,
  statuses: Statuses,
  captureMetadata = false,
): Promise<ByteResponse> {
  return await request(
    stage,
    url,
    init,
    statuses,
    async (response, signal) => ({
      bytes: await boundedBytes(response, stage, signal, INSTALLER_LIMIT_BYTES),
      status: response.status,
      metadata: captureMetadata ? initialMetadata(response) : undefined,
    }),
  )
}

function checkedGitObject(
  value: unknown,
  stage: Stage,
): { sha: string; type: 'tag' | 'commit' } {
  if (
    !isRecord(value) || typeof value.sha !== 'string' || !SHA40.test(value.sha)
  ) {
    failure(
      `E_${stage.toUpperCase()}_SHA`,
      'GitHub tag identity has an invalid SHA',
    )
  }
  if (value.type !== 'tag' && value.type !== 'commit') {
    failure(
      `E_${stage.toUpperCase()}_TYPE`,
      'GitHub tag identity has an invalid type',
    )
  }
  return { sha: value.sha, type: value.type }
}

async function verifiedRelease(
  version: string,
  sourceSha: string,
  statuses: Statuses,
): Promise<void> {
  const tagName = `v${version}`
  const release = await githubJson(
    'release',
    `${GH}/repos/${repo}/releases/tags/${tagName}`,
    statuses,
  )
  if (
    release.tag_name !== tagName || release.immutable !== true ||
    release.draft !== false || release.prerelease !== false
  ) {
    failure(
      'E_RELEASE_IDENTITY',
      'release is not the exact immutable published stable release',
    )
  }
  const ref = await githubJson(
    'ref',
    `${GH}/repos/${repo}/git/ref/tags/${tagName}`,
    statuses,
  )
  if (ref.ref !== `refs/tags/${tagName}`) {
    failure('E_REF_IDENTITY', 'GitHub tag ref is not exact')
  }
  let object = checkedGitObject(ref.object, 'ref')
  const seen = new Set<string>()
  for (let depth = 1; object.type === 'tag'; depth += 1) {
    if (depth > MAX_TAG_PEEL_DEPTH || seen.has(object.sha)) {
      failure('E_TAG_PEEL', 'annotated tag peel is cyclic or exceeds its bound')
    }
    seen.add(object.sha)
    const stage = `tag_peel_${depth}` as Stage
    const tag = await githubJson(
      stage,
      `${GH}/repos/${repo}/git/tags/${object.sha}`,
      statuses,
    )
    object = checkedGitObject(tag.object, stage)
  }
  if (object.sha !== sourceSha) {
    failure(
      'E_RELEASE_SOURCE_SHA',
      'release tag does not bind the requested source SHA',
    )
  }
}

function statusTemplate(): Statuses {
  return {
    domain: null,
    initial_authenticated_preimage: null,
    public_preimage: null,
    release: null,
    ref: null,
    tag_peel_1: null,
    tag_peel_2: null,
    tag_peel_3: null,
    tag_peel_4: null,
    tag_peel_5: null,
    tag_peel_6: null,
    tag_peel_7: null,
    tag_peel_8: null,
    fresh_authenticated_preimage: null,
    put: null,
    authenticated_readback: null,
    public_readback: null,
  }
}

function outputPath(outputDir: string, name: string): string {
  return `${outputDir}/${name}`
}

function retainKnownReadStatuses(
  receipt: Record<string, unknown>,
  statuses: Statuses,
): void {
  for (
    const [stage, evidence] of [
      ['initial_authenticated_preimage', 'initial_authenticated_preimage'],
      ['public_preimage', 'public_preimage'],
      ['fresh_authenticated_preimage', 'fresh_authenticated_preimage'],
      ['authenticated_readback', 'authenticated_readback'],
      ['public_readback', 'public_readback'],
    ] as const
  ) {
    const record = receipt[evidence] as Record<string, unknown>
    if (record.http_status === null) record.http_status = statuses[stage]
  }
}

export async function run(args: string[]): Promise<void> {
  const options = parseArgs(args)
  await ensureOutput(options.outputDir)
  const statuses = statusTemplate()
  const receipt: Record<string, unknown> = {
    operation: options.operation,
    version: options.version,
    source_sha: options.sourceSha ?? null,
    target: { bucket, key: objectKey, domain },
    http_statuses: statuses,
    authenticated_backup: null,
    initial_authenticated_preimage: {
      http_status: null,
      sha256: null,
      size: null,
      metadata: {},
    },
    public_preimage: { http_status: null, sha256: null, size: null },
    fresh_authenticated_preimage: {
      http_status: null,
      sha256: null,
      size: null,
    },
    authenticated_readback: { http_status: null, sha256: null, size: null },
    public_readback: { http_status: null, sha256: null, size: null },
    release_validated: false,
    put_attempted: false,
    put_succeeded: false,
    put_write_outcome: 'not-attempted',
    readback_state: 'not-started',
    race_limit:
      'non-atomic: a concurrent writer may change the object after the fresh preimage GET and before or after this single PUT',
    error: null,
  }
  let operationError: LegacyBootstrapError | undefined

  try {
    const account = secret(ACCOUNT)
    const token = secret(TOKEN)
    const base = `${CF}/accounts/${account}/r2/buckets/${bucket}`
    const auth = cfHeaders(token)
    const domainResult = await cloudflareJson(
      'domain',
      `${base}/domains/custom/${domain}`,
      { headers: auth },
      statuses,
    )
    const status = domainResult.status
    if (
      domainResult.domain !== domain || domainResult.enabled !== true ||
      !isRecord(status) || status.ownership !== 'active' ||
      status.ssl !== 'active'
    ) {
      failure(
        'E_DOMAIN_MAPPING',
        'custom domain is not the exact active enabled mapping',
      )
    }

    const initial = await objectBytes(
      'initial_authenticated_preimage',
      `${base}/objects/${objectKey}`,
      { headers: auth },
      statuses,
      true,
    )
    const initialHash = sha256(initial.bytes)
    const initialEvidence = receipt.initial_authenticated_preimage as Record<
      string,
      unknown
    >
    initialEvidence.http_status = initial.status
    initialEvidence.sha256 = initialHash
    initialEvidence.size = initial.bytes.byteLength
    initialEvidence.metadata = initial.metadata ?? {}
    receipt.authenticated_backup = {
      path: 'authenticated-preimage.bin',
      size: initial.bytes.byteLength,
      sha256: initialHash,
    }
    await writeBytes(
      outputPath(options.outputDir, 'authenticated-preimage.bin'),
      initial.bytes,
      'E_BACKUP_WRITE',
    )
    await writeJson(
      outputPath(options.outputDir, 'metadata.json'),
      {
        backup: receipt.authenticated_backup,
        initial_authenticated_response_metadata: initial.metadata ?? {},
      },
      'E_METADATA_WRITE',
    )

    const publicPreimage = await objectBytes(
      'public_preimage',
      `https://${domain}/${objectKey}`,
      {},
      statuses,
    )
    const publicPreimageHash = sha256(publicPreimage.bytes)
    const publicPreimageEvidence = receipt.public_preimage as Record<
      string,
      unknown
    >
    publicPreimageEvidence.http_status = publicPreimage.status
    publicPreimageEvidence.sha256 = publicPreimageHash
    publicPreimageEvidence.size = publicPreimage.bytes.byteLength
    if (publicPreimageHash !== initialHash) {
      failure(
        'E_PREIMAGE_PUBLIC_MISMATCH',
        'public preimage does not match authenticated backup',
      )
    }

    let payload: Uint8Array | undefined
    let payloadHash: string | undefined
    if (options.sourceSha) {
      payload = stopPayload(options.version, options.sourceSha)
      payloadHash = sha256(payload)
      receipt.candidate_payload = {
        path: 'candidate-install',
        size: payload.byteLength,
        sha256: payloadHash,
      }
      await writeBytes(
        outputPath(options.outputDir, 'candidate-install'),
        payload,
        'E_CANDIDATE_WRITE',
      )
    }

    if (options.operation === 'preflight') {
      receipt.readback_state = 'preflight-only'
    } else {
      if (payloadHash !== options.expectedPayloadSha256) {
        failure(
          'E_PAYLOAD_HASH',
          'candidate payload does not match the reviewed hash',
        )
      }
      if (initialHash !== options.expectedPreimageSha256) {
        failure(
          'E_PREIMAGE_HASH',
          'authenticated preimage does not match the reviewed hash',
        )
      }

      await verifiedRelease(options.version, options.sourceSha!, statuses)
      receipt.release_validated = true

      const fresh = await objectBytes(
        'fresh_authenticated_preimage',
        `${base}/objects/${objectKey}`,
        { headers: auth },
        statuses,
      )
      const freshHash = sha256(fresh.bytes)
      const freshEvidence = receipt.fresh_authenticated_preimage as Record<
        string,
        unknown
      >
      freshEvidence.http_status = fresh.status
      freshEvidence.sha256 = freshHash
      freshEvidence.size = fresh.bytes.byteLength
      if (freshHash !== options.expectedPreimageSha256) {
        failure(
          'E_FRESH_PREIMAGE_HASH',
          'fresh authenticated preimage changed before write',
        )
      }

      receipt.put_attempted = true
      receipt.put_write_outcome = 'unknown'
      let putResult: Record<string, unknown>
      try {
        putResult = await cloudflareJson(
          'put',
          `${base}/objects/${objectKey}`,
          {
            method: 'PUT',
            headers: { ...auth, 'content-type': 'application/octet-stream' },
            body: payload!.buffer as ArrayBuffer,
          },
          statuses,
        )
      } catch (error) {
        const safe = asSafeFailure(
          error,
          'E_PUT_OPERATION',
          'object upload failed',
        )
        throw safe
      }
      if (
        putResult.key !== objectKey ||
        putResult.size !== String(payload!.byteLength)
      ) {
        failure(
          'E_PUT_RESULT',
          'object upload response did not bind the expected key and size',
        )
      }
      receipt.put_succeeded = true
      receipt.put_write_outcome = 'succeeded'

      const authenticatedReadback = await objectBytes(
        'authenticated_readback',
        `${base}/objects/${objectKey}`,
        { headers: auth },
        statuses,
      )
      const authenticatedReadbackHash = sha256(authenticatedReadback.bytes)
      const authenticatedReadbackEvidence = receipt
        .authenticated_readback as Record<string, unknown>
      authenticatedReadbackEvidence.http_status = authenticatedReadback.status
      authenticatedReadbackEvidence.sha256 = authenticatedReadbackHash
      authenticatedReadbackEvidence.size =
        authenticatedReadback.bytes.byteLength

      const publicReadback = await objectBytes(
        'public_readback',
        `https://${domain}/${objectKey}`,
        {},
        statuses,
      )
      const publicReadbackHash = sha256(publicReadback.bytes)
      const publicReadbackEvidence = receipt.public_readback as Record<
        string,
        unknown
      >
      publicReadbackEvidence.http_status = publicReadback.status
      publicReadbackEvidence.sha256 = publicReadbackHash
      publicReadbackEvidence.size = publicReadback.bytes.byteLength
      if (
        authenticatedReadbackHash !== payloadHash ||
        publicReadbackHash !== payloadHash
      ) {
        failure('E_READBACK_HASH', 'post-write readback hash mismatch')
      }
      receipt.readback_state = 'matched'
    }
  } catch (error) {
    operationError = asSafeFailure(
      error,
      'E_OPERATION',
      'legacy bootstrap operation failed',
    )
    receipt.error = {
      code: operationError.code,
      message: operationError.message,
    }
  }
  retainKnownReadStatuses(receipt, statuses)

  try {
    await writeJson(
      outputPath(options.outputDir, 'receipt.json'),
      receipt,
      'E_RECEIPT_WRITE',
    )
  } catch (error) {
    if (!operationError) {
      operationError = asSafeFailure(
        error,
        'E_RECEIPT_WRITE',
        'legacy bootstrap receipt could not be written',
      )
    }
  }
  if (operationError) throw operationError
}

if (import.meta.main) {
  try {
    await run(Deno.args)
  } catch {
    console.error('legacy bootstrap failed')
    Deno.exit(1)
  }
}
