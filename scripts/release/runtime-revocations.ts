/** Reviewed deny-only runtime policy. It never selects or grants trust to an artifact. */
import { createHash } from 'node:crypto'
import { join } from 'node:path'

export const RUNTIME_REVOCATIONS_PATH =
  'source-materials/runtime-revocations.json'
export const RUNTIME_REVOCATIONS_URL =
  'https://raw.githubusercontent.com/ValidatorsDAO/slv/refs/heads/main/source-materials/runtime-revocations.json'
export const RUNTIME_REVOCATIONS_MAX_BYTES = 256 * 1024
const FETCH_DEADLINE_MS = 10_000
const IDENTITY = /^[a-f0-9]{64}$/
export type RuntimeRevocations = {
  schema_version: 1
  revoked_identities: string[]
}
export type RuntimeRevocationObservation = {
  kind: 'reviewed_checkout_policy' | 'current_main_policy'
  policy_sha256: string
  source_commit: string | null
  observed_at: string
  origin: typeof RUNTIME_REVOCATIONS_PATH | typeof RUNTIME_REVOCATIONS_URL
  qualification_identity: string
  outcome: 'allow' | 'deny'
  validators: { etag: string | null; last_modified: string | null } | null
}
export type RuntimeRevocationBinding = {
  reviewed_checkout_policy: RuntimeRevocationObservation
  current_main_policy: RuntimeRevocationObservation | null
}
/** Receipt validation does not replace a required fresh/local policy acquisition. */
export function verifyRuntimeRevocationBinding(value: unknown, expected: {
  identity: string
  mode: 'candidate-validation' | 'final-qualified'
  reviewedPolicySha256: string
  sourceCommit?: string
}): RuntimeRevocationBinding {
  assertIdentity(expected.identity)
  if (!IDENTITY.test(expected.reviewedPolicySha256)) {
    fail('invalid expected reviewed policy digest')
  }
  const exact = (value: unknown, keys: string[]) => {
    if (
      !value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).sort().join('\0') !== keys.sort().join('\0')
    ) fail('invalid policy receipt fields')
    return value as Record<string, unknown>
  }
  const row = exact(value, ['reviewed_checkout_policy', 'current_main_policy'])
  const check = (
    input: unknown,
    kind: RuntimeRevocationObservation['kind'],
  ) => {
    const item = exact(input, [
      'kind',
      'policy_sha256',
      'source_commit',
      'observed_at',
      'origin',
      'qualification_identity',
      'outcome',
      'validators',
    ])
    if (
      item.kind !== kind || item.qualification_identity !== expected.identity ||
      item.outcome !== 'allow' || typeof item.policy_sha256 !== 'string' ||
      !IDENTITY.test(item.policy_sha256) ||
      typeof item.observed_at !== 'string' ||
      Number.isNaN(Date.parse(item.observed_at)) ||
      new Date(item.observed_at).toISOString() !== item.observed_at
    ) fail('invalid policy receipt binding')
    if (
      item.source_commit !== null &&
      (typeof item.source_commit !== 'string' ||
        !/^[a-f0-9]{40}$/.test(item.source_commit))
    ) fail('invalid policy receipt source')
    if (kind === 'reviewed_checkout_policy') {
      if (
        item.origin !== RUNTIME_REVOCATIONS_PATH ||
        item.policy_sha256 !== expected.reviewedPolicySha256 ||
        item.validators !== null ||
        (expected.sourceCommit && item.source_commit !== null &&
          item.source_commit !== expected.sourceCommit)
      ) fail('reviewed policy receipt differs')
    } else {
      if (
        item.origin !== RUNTIME_REVOCATIONS_URL || item.source_commit !== null
      ) fail('current-main policy receipt origin/source differs')
      const validators = exact(item.validators, ['etag', 'last_modified'])
      for (const v of Object.values(validators)) {
        if (
          v !== null &&
          (typeof v !== 'string' || !v || v.length > 1024 ||
            /[\x00-\x1f\x7f]/.test(v))
        ) fail('invalid policy response validator')
      }
    }
    return item as RuntimeRevocationObservation
  }
  const reviewed = check(
    row.reviewed_checkout_policy,
    'reviewed_checkout_policy',
  )
  let current: RuntimeRevocationObservation | null = null
  if (expected.mode === 'final-qualified') {
    current = check(row.current_main_policy, 'current_main_policy')
  } else if (
    expected.mode !== 'candidate-validation' || row.current_main_policy !== null
  ) fail('candidate policy receipt has final-state fields')
  return { reviewed_checkout_policy: reviewed, current_main_policy: current }
}
export class RuntimeRevocationError extends Error {
  constructor(
    message: string,
    readonly observation?: RuntimeRevocationObservation,
  ) {
    super(`runtime revocation: ${message}`)
    this.name = 'RuntimeRevocationError'
  }
}
function fail(message: string): never {
  throw new RuntimeRevocationError(message)
}
function assertIdentity(identity: string): void {
  if (!IDENTITY.test(identity)) fail('invalid qualification identity')
}
function hash(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

/** Fixed-schema parser detects duplicate keys before JSON deserialization loses them. */
export function parseRuntimeRevocations(bytes: Uint8Array): RuntimeRevocations {
  if (bytes.length > RUNTIME_REVOCATIONS_MAX_BYTES) {
    fail('policy exceeds 256 KiB')
  }
  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
      bytes,
    )
  } catch {
    return fail('policy is not valid UTF-8')
  }
  let index = 0
  const whitespace = () => {
    while (/[ \t\r\n]/.test(text[index] ?? '') && index < text.length) index++
  }
  const take = (character: string) => {
    whitespace()
    if (text[index++] !== character) fail('invalid policy JSON')
  }
  const quoted = (): string => {
    whitespace()
    const start = index
    if (text[index++] !== '"') fail('policy value must be a JSON string')
    while (index < text.length) {
      const character = text[index++]
      if (character === '\\') {
        index++
        continue
      }
      if (character === '"') {
        try {
          const result: unknown = JSON.parse(text.slice(start, index))
          if (typeof result !== 'string') fail('invalid policy string')
          return result
        } catch {
          return fail('invalid policy JSON string')
        }
      }
    }
    return fail('unterminated policy string')
  }
  take('{')
  const keys = new Set<string>()
  let identities: string[] | undefined
  for (;;) {
    whitespace()
    if (text[index] === '}') {
      index++
      break
    }
    const key = quoted()
    if (keys.has(key)) fail('duplicate policy object key')
    keys.add(key)
    take(':')
    if (key === 'schema_version') {
      whitespace()
      if (text[index++] !== '1' || !/[ \t\r\n,}]/.test(text[index] ?? '')) {
        fail('unsupported policy schema')
      }
    } else if (key === 'revoked_identities') {
      take('[')
      identities = []
      const seen = new Set<string>()
      whitespace()
      if (text[index] === ']') index++
      else {for (;;) {
          const identity = quoted()
          assertIdentity(identity)
          if (seen.has(identity)) fail('duplicate revoked identity')
          seen.add(identity)
          identities.push(identity)
          whitespace()
          if (text[index] === ']') {
            index++
            break
          }
          take(',')
        }}
    } else fail('unknown policy field')
    whitespace()
    if (text[index] === '}') {
      index++
      break
    }
    take(',')
    whitespace()
    if (text[index] === '}') fail('trailing policy comma')
  }
  whitespace()
  if (
    index !== text.length || keys.size !== 2 || !keys.has('schema_version') ||
    identities === undefined
  ) fail('missing policy field or trailing JSON')
  return { schema_version: 1, revoked_identities: identities }
}
function observation(
  bytes: Uint8Array,
  identity: string,
  details: Omit<
    RuntimeRevocationObservation,
    'policy_sha256' | 'qualification_identity' | 'outcome'
  >,
): RuntimeRevocationObservation {
  assertIdentity(identity)
  const policy = parseRuntimeRevocations(bytes)
  const receipt: RuntimeRevocationObservation = {
    ...details,
    policy_sha256: hash(bytes),
    qualification_identity: identity,
    outcome: policy.revoked_identities.includes(identity) ? 'deny' : 'allow',
  }
  if (receipt.outcome === 'deny') {
    throw new RuntimeRevocationError(
      'selected qualification is revoked',
      receipt,
    )
  }
  return receipt
}
async function boundedStream(
  stream: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  const reader = stream.getReader(), chunks: Uint8Array[] = []
  let length = 0
  const cancel = () => {
    void reader.cancel().catch(() => {})
  }
  signal?.addEventListener('abort', cancel, { once: true })
  try {
    for (;;) {
      const part = await reader.read()
      if (part.done) break
      length += part.value.length
      if (length > RUNTIME_REVOCATIONS_MAX_BYTES) fail('policy exceeds 256 KiB')
      chunks.push(part.value)
    }
    const bytes = new Uint8Array(length)
    let offset = 0
    for (const chunk of chunks) {
      bytes.set(chunk, offset)
      offset += chunk.length
    }
    return bytes
  } finally {
    signal?.removeEventListener('abort', cancel)
    cancel()
    reader.releaseLock()
  }
}
async function boundCheckoutCommit(
  root: string,
  bytes: Uint8Array,
): Promise<string | null> {
  if (
    (await Deno.permissions.query({ name: 'run', command: 'git' })).state !==
      'granted'
  ) return null
  const run = async (args: string[]) => {
    const child = new Deno.Command('git', {
      args: ['-C', root, ...args],
      stdin: 'null',
      stdout: 'piped',
      stderr: 'null',
    }).spawn()
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL')
      } catch { /* exited */ }
    }, 2000)
    try {
      return await child.output()
    } finally {
      clearTimeout(timer)
    }
  }
  const head = await run(['rev-parse', 'HEAD'])
  if (!head.success) return null
  const commit = new TextDecoder().decode(head.stdout).trim()
  if (!/^[a-f0-9]{40}$/.test(commit)) return null
  const committed = await run([
    'rev-parse',
    `${commit}:${RUNTIME_REVOCATIONS_PATH}`,
  ])
  const blob = createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes)
    .digest('hex')
  return committed.success &&
      new TextDecoder().decode(committed.stdout).trim() === blob
    ? commit
    : null
}
export async function checkReviewedRuntimeRevocation(
  identity: string,
  repositoryRoot: string,
): Promise<RuntimeRevocationObservation> {
  assertIdentity(identity)
  const path = join(repositoryRoot, RUNTIME_REVOCATIONS_PATH)
  const before = await Deno.lstat(path).catch(() =>
    fail('reviewed policy is missing')
  )
  if (
    !before.isFile || before.isSymlink ||
    before.size > RUNTIME_REVOCATIONS_MAX_BYTES
  ) fail('reviewed policy must be a bounded regular file')
  const file = await Deno.open(path, { read: true })
  let bytes: Uint8Array
  try {
    const info = await file.stat()
    if (!info.isFile || info.size > RUNTIME_REVOCATIONS_MAX_BYTES) {
      fail('reviewed policy must be a bounded regular file')
    }
    bytes = await boundedStream(file.readable)
  } finally {
    try {
      file.close()
    } catch { /* stream closed */ }
  }
  // Parse/deny before optional Git metadata lookup, which cannot grant trust.
  const receipt = observation(bytes, identity, {
    kind: 'reviewed_checkout_policy',
    source_commit: null,
    observed_at: new Date().toISOString(),
    origin: RUNTIME_REVOCATIONS_PATH,
    validators: null,
  })
  receipt.source_commit = await boundCheckoutCommit(repositoryRoot, bytes)
  return receipt
}
export type RuntimeRevocationTransport = { fetch?: typeof globalThis.fetch }
/** Fixed origin/ref, no credentials, redirects, cached success, retries or endpoint overrides. */
export async function checkFreshRuntimeRevocation(
  identity: string,
  transport: RuntimeRevocationTransport = {},
): Promise<RuntimeRevocationObservation> {
  assertIdentity(identity)
  const fetchPolicy = transport.fetch ?? globalThis.fetch
  const controller = new AbortController()
  let response: Response | undefined
  let timedOut = false
  let rejectDeadline: (reason: Error) => void = () => {}
  const deadline = new Promise<never>((_resolve, reject) => {
    rejectDeadline = reject
  })
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
    void response?.body?.cancel().catch(() => {})
    rejectDeadline(new RuntimeRevocationError('policy fetch timed out'))
  }, FETCH_DEADLINE_MS)
  const acquire = async () => {
    response = await fetchPolicy(RUNTIME_REVOCATIONS_URL, {
      method: 'GET',
      redirect: 'error',
      credentials: 'omit',
      cache: 'no-store',
      headers: {
        Accept: 'application/json',
        'Cache-Control': 'no-cache',
        'Pragma': 'no-cache',
      },
      signal: controller.signal,
    })
    if (controller.signal.aborted) {
      void response.body?.cancel().catch(() => {})
      fail('policy fetch timed out')
    }
    if (
      response.status !== 200 || response.redirected ||
      (response.url && response.url !== RUNTIME_REVOCATIONS_URL)
    ) fail('policy response is not the fixed current-main HTTP 200 resource')
    const length = response.headers.get('content-length')
    if (
      length !== null &&
      (!/^[0-9]+$/.test(length) ||
        Number(length) > RUNTIME_REVOCATIONS_MAX_BYTES)
    ) fail('policy exceeds 256 KiB')
    if (!response.body) fail('empty policy response')
    const bytes = await boundedStream(response.body, controller.signal)
    const validator = (name: string) => {
      const value = response!.headers.get(name)
      return value && value.length <= 1024 && !/[\x00-\x1f\x7f]/.test(value)
        ? value
        : null
    }
    return observation(bytes, identity, {
      kind: 'current_main_policy',
      source_commit: null,
      observed_at: new Date().toISOString(),
      origin: RUNTIME_REVOCATIONS_URL,
      validators: {
        etag: validator('etag'),
        last_modified: validator('last-modified'),
      },
    })
  }
  try {
    return await Promise.race([acquire(), deadline])
  } catch (error) {
    if (error instanceof RuntimeRevocationError) throw error
    throw new RuntimeRevocationError(
      timedOut ? 'policy fetch timed out' : 'policy fetch failed',
    )
  } finally {
    clearTimeout(timer)
    controller.abort()
    void response?.body?.cancel().catch(() => {})
  }
}

export async function runRuntimeRevocationsCommand(
  argv: string[],
  transport: RuntimeRevocationTransport = {},
): Promise<RuntimeRevocationObservation> {
  const [action, ...args] = argv
  let result: RuntimeRevocationObservation
  if (action === 'local' && (args.length === 2 || args.length === 3)) {
    result = await checkReviewedRuntimeRevocation(args[1], args[0])
  } else if (action === 'fresh' && (args.length === 1 || args.length === 2)) {
    result = await checkFreshRuntimeRevocation(args[0], transport)
  } else fail('usage: local ROOT ID [RECEIPT] | fresh ID [RECEIPT]')
  const output = action === 'local' ? args[2] : args[1]
  const bytes = new TextEncoder().encode(JSON.stringify(result) + '\n')
  if (output) await Deno.writeFile(output, bytes, { createNew: true })
  else await Deno.stdout.write(bytes)
  return result
}
if (import.meta.main) await runRuntimeRevocationsCommand(Deno.args)
