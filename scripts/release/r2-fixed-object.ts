import { createHash, createHmac } from 'node:crypto'

const CREDENTIAL_ENV = 'SLV_R2_CREDENTIALS_JSON'
const URI = '/slv/slv/install'
const GET_LIMIT_BYTES = 8 * 1024 * 1024
const ACCOUNT = /^[a-f0-9]{32}$/
const SECRET = /^[a-f0-9]{64}$/
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const TOKEN = /^[A-Za-z0-9._:-]{1,256}$/
const JURISDICTIONS = new Set(['default', 'eu', 'us', 'fedramp'])

export type Credentials = Readonly<{
  schemaVersion: 1
  operationId: string
  tokenId: string
  expiresOn: string
  accountId: string
  jurisdiction: 'default' | 'eu' | 'us' | 'fedramp'
  bucket: 'slv'
  endpoint: string
  accessKeyId: string
  secretAccessKey: string
}>

export class FixedObjectError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number | null = null,
  ) {
    super(message)
    this.name = 'FixedObjectError'
  }
}

class DeadlineExceeded extends Error {
  constructor() {
    super('deadline exceeded')
    this.name = 'DeadlineExceeded'
  }
}

const fail = (code: string, message: string): never => {
  throw new FixedObjectError(code, message)
}

const sha256 = (value: Uint8Array | string) =>
  createHash('sha256').update(value).digest('hex')
const hmac = (key: Uint8Array | string, value: string) =>
  createHmac('sha256', key).update(value).digest()
const expectedEndpoint = (accountId: string, jurisdiction: string) =>
  jurisdiction === 'default'
    ? `https://${accountId}.r2.cloudflarestorage.com`
    : `https://${accountId}.${jurisdiction}.r2.cloudflarestorage.com`

export function parseCredentials(
  value = Deno.env.get(CREDENTIAL_ENV),
  now = new Date(),
): Credentials {
  if (!value) {
    fail('E_CREDENTIALS_MISSING', 'required R2 credentials are missing')
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(value as string)
  } catch {
    fail('E_CREDENTIALS_JSON', 'R2 credentials are invalid')
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    fail('E_CREDENTIALS_SHAPE', 'R2 credentials are invalid')
  }
  const record = parsed as Record<string, unknown>
  const keys = [
    'schemaVersion',
    'operationId',
    'tokenId',
    'expiresOn',
    'accountId',
    'jurisdiction',
    'bucket',
    'endpoint',
    'accessKeyId',
    'secretAccessKey',
  ]
  if (
    Object.keys(record).length !== keys.length ||
    keys.some((key) => !(key in record))
  ) {
    fail('E_CREDENTIALS_SHAPE', 'R2 credentials have an invalid shape')
  }
  if (
    record.schemaVersion !== 1 || typeof record.operationId !== 'string' ||
    !UUID.test(record.operationId) || typeof record.tokenId !== 'string' ||
    !TOKEN.test(record.tokenId) || typeof record.accountId !== 'string' ||
    !ACCOUNT.test(record.accountId) ||
    typeof record.jurisdiction !== 'string' ||
    !JURISDICTIONS.has(record.jurisdiction) || record.bucket !== 'slv' ||
    typeof record.accessKeyId !== 'string' ||
    record.accessKeyId !== record.tokenId ||
    typeof record.secretAccessKey !== 'string' ||
    !SECRET.test(record.secretAccessKey) ||
    typeof record.expiresOn !== 'string' || typeof record.endpoint !== 'string'
  ) {
    fail('E_CREDENTIALS_VALUES', 'R2 credentials have invalid values')
  }
  const expiresOn = record.expiresOn as string
  const expires = new Date(expiresOn)
  if (
    Number.isNaN(expires.valueOf()) || expires.toISOString() !== expiresOn ||
    expires <= now
  ) {
    fail(
      'E_CREDENTIALS_EXPIRY',
      'R2 credentials are expired or have an invalid expiry',
    )
  }
  const endpoint = expectedEndpoint(
    record.accountId as string,
    record.jurisdiction as string,
  )
  if (record.endpoint !== endpoint) {
    fail('E_CREDENTIALS_ENDPOINT', 'R2 credentials have an invalid endpoint')
  }
  return record as Credentials
}

export function endpointHost(credentials: Credentials): string {
  return new URL(credentials.endpoint).hostname
}

function amzDate(now: Date): { full: string; day: string } {
  const full = now.toISOString().replace(/[:-]|\.\d{3}/g, '')
  return { full, day: full.slice(0, 8) }
}

function normalizedHeaderValue(value: string): string {
  return value.trim().replace(/\s+/g, ' ')
}

export type SigV4Request = Readonly<{
  accessKeyId: string
  secretAccessKey: string
  method: 'GET' | 'PUT'
  host: string
  canonicalUri: string
  payload: Uint8Array
  now: Date
  region: string
  service: string
  headers?: Record<string, string>
}>

/**
 * Pure SigV4 canonicalization seam. Fixed-object transport supplies the fixed
 * auto-region S3 origin and URI below; callers cannot direct that transport.
 */
export function signSigV4(request: SigV4Request): Headers {
  const { full, day } = amzDate(request.now)
  const payloadHash = sha256(request.payload)
  const values = new Map<string, string>()
  values.set('host', request.host)
  values.set('x-amz-content-sha256', payloadHash)
  values.set('x-amz-date', full)
  for (const [name, value] of Object.entries(request.headers ?? {})) {
    values.set(name.toLowerCase(), normalizedHeaderValue(value))
  }
  const names = [...values.keys()].sort()
  const canonicalHeaders = names
    .map((name) => `${name}:${values.get(name)!}\n`)
    .join('')
  const signedHeaders = names.join(';')
  const canonical =
    `${request.method}\n${request.canonicalUri}\n\n${canonicalHeaders}\n${signedHeaders}\n${payloadHash}`
  const scope = `${day}/${request.region}/${request.service}/aws4_request`
  const stringToSign = `AWS4-HMAC-SHA256\n${full}\n${scope}\n${
    sha256(canonical)
  }`
  const dateKey = hmac(`AWS4${request.secretAccessKey}`, day)
  const regionKey = hmac(dateKey, request.region)
  const serviceKey = hmac(regionKey, request.service)
  const signingKey = hmac(serviceKey, 'aws4_request')
  const signature = hmac(signingKey, stringToSign).toString('hex')
  const output = new Headers()
  for (const name of names) output.set(name, values.get(name)!)
  output.set(
    'authorization',
    `AWS4-HMAC-SHA256 Credential=${request.accessKeyId}/${scope},SignedHeaders=${signedHeaders},Signature=${signature}`,
  )
  return output
}

export function signedHeaders(
  credentials: Credentials,
  method: 'GET' | 'PUT',
  payload: Uint8Array = new Uint8Array(),
  now = new Date(),
): Headers {
  parseCredentials(JSON.stringify(credentials), now)
  return signSigV4({
    accessKeyId: credentials.accessKeyId,
    secretAccessKey: credentials.secretAccessKey,
    method,
    host: endpointHost(credentials),
    canonicalUri: URI,
    payload,
    now,
    region: 'auto',
    service: 's3',
    headers: method === 'PUT'
      ? { 'content-type': 'application/octet-stream' }
      : undefined,
  })
}

async function beforeDeadline<T>(
  task: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  if (signal.aborted) throw new DeadlineExceeded()
  let onAbort: (() => void) | undefined
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(new DeadlineExceeded())
    signal.addEventListener('abort', onAbort, { once: true })
  })
  try {
    return await Promise.race([task, aborted])
  } finally {
    if (onAbort) signal.removeEventListener('abort', onAbort)
  }
}

async function cancelBody(
  body: ReadableStream<Uint8Array> | null,
  signal: AbortSignal,
): Promise<void> {
  if (!body) return
  try {
    await beforeDeadline(body.cancel(), signal)
  } catch {
    // A failed cancellation never replaces the bounded transport failure.
  }
}

async function boundedBody(
  response: Response,
  method: 'GET' | 'PUT',
  signal: AbortSignal,
): Promise<Uint8Array> {
  const reader = response.body?.getReader()
  if (!reader) return new Uint8Array()
  const chunks: Uint8Array[] = []
  let length = 0
  let finished = false
  try {
    for (;;) {
      const part = await beforeDeadline(reader.read(), signal)
      if (part.done) {
        finished = true
        break
      }
      length += part.value.byteLength
      if (length > GET_LIMIT_BYTES) {
        await cancelBody(response.body, signal)
        throw new FixedObjectError(
          `E_S3_${method}_BODY_LIMIT`,
          `fixed S3 ${method} response body exceeds its size limit`,
          response.status,
        )
      }
      chunks.push(part.value)
    }
  } catch (error) {
    if (
      error instanceof FixedObjectError || error instanceof DeadlineExceeded
    ) {
      throw error
    }
    throw new FixedObjectError(
      `E_S3_${method}_BODY`,
      `fixed S3 ${method} response body could not be read`,
      response.status,
    )
  } finally {
    if (!finished) {
      try {
        await beforeDeadline(reader.cancel(), signal)
      } catch {
        // Preserve the original body or deadline result.
      }
    }
    reader.releaseLock()
  }
  const out = new Uint8Array(length)
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.byteLength
  }
  return out
}

async function completePutResponse(
  response: Response,
  signal: AbortSignal,
): Promise<void> {
  if (!response.body) return
  try {
    await beforeDeadline(response.body.cancel(), signal)
  } catch (error) {
    if (error instanceof DeadlineExceeded) throw error
    throw new FixedObjectError(
      'E_S3_PUT_BODY',
      'fixed S3 PUT response could not be completed',
      response.status,
    )
  }
}

async function request<T>(
  credentials: Credentials,
  method: 'GET' | 'PUT',
  payload: Uint8Array | undefined,
  consume: (response: Response, signal: AbortSignal) => Promise<T>,
): Promise<T> {
  // Re-check expiry immediately before every authenticated signed request.
  parseCredentials(JSON.stringify(credentials))
  const body = method === 'PUT'
    ? new Uint8Array(payload ?? new Uint8Array())
    : undefined
  const headers = signedHeaders(credentials, method, body)
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 30_000)
  let status: number | null = null
  try {
    const response = await beforeDeadline(
      fetch(`${credentials.endpoint}${URI}`, {
        method,
        headers,
        body: body?.buffer,
        redirect: 'error',
        signal: controller.signal,
      }),
      controller.signal,
    )
    status = response.status
    if (response.status !== 200) {
      await cancelBody(response.body, controller.signal)
      throw new FixedObjectError(
        `E_S3_${method}_HTTP`,
        `fixed S3 ${method} returned HTTP ${response.status}`,
        response.status,
      )
    }
    return await consume(response, controller.signal)
  } catch (error) {
    if (error instanceof FixedObjectError) throw error
    if (error instanceof DeadlineExceeded || controller.signal.aborted) {
      throw new FixedObjectError(
        `E_S3_${method}_TIMEOUT`,
        `fixed S3 ${method} request timed out`,
        status,
      )
    }
    throw new FixedObjectError(
      `E_S3_${method}_REQUEST`,
      `fixed S3 ${method} request failed`,
      status,
    )
  } finally {
    clearTimeout(timeout)
  }
}

export async function fixedObjectGet(
  credentials: Credentials,
): Promise<
  { bytes: Uint8Array; status: number; metadata: Record<string, string> }
> {
  return await request(
    credentials,
    'GET',
    undefined,
    async (response, signal) => {
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
      return {
        bytes: await boundedBody(response, 'GET', signal),
        status: response.status,
        metadata,
      }
    },
  )
}

export async function fixedObjectPut(
  credentials: Credentials,
  payload: Uint8Array,
): Promise<number> {
  return await request(
    credentials,
    'PUT',
    payload,
    async (response, signal) => {
      await completePutResponse(response, signal)
      return response.status
    },
  )
}

if (import.meta.main) {
  try {
    if (Deno.args.length !== 1 || Deno.args[0] !== 'endpoint-host') {
      fail('E_USAGE', 'usage error')
    }
    console.log(endpointHost(parseCredentials()))
  } catch {
    Deno.exit(1)
  }
}
