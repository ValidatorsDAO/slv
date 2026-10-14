import { assert, assertEquals, assertThrows } from 'jsr:@std/assert@1'
import { createHash } from 'node:crypto'
import {
  endpointHost,
  FixedObjectError,
  fixedObjectGet,
  fixedObjectPut,
  parseCredentials,
  signedHeaders,
  signSigV4,
} from './r2-fixed-object.ts'

const bundle = {
  schemaVersion: 1,
  operationId: '123e4567-e89b-42d3-a456-426614174000',
  tokenId: 'fixture',
  expiresOn: '2030-01-01T00:00:00.000Z',
  accountId: 'a'.repeat(32),
  jurisdiction: 'default',
  bucket: 'slv',
  endpoint: `https://${'a'.repeat(32)}.r2.cloudflarestorage.com`,
  accessKeyId: 'fixture',
  secretAccessKey: 'b'.repeat(64),
} as const
const objectUrl = `${bundle.endpoint}/slv/slv/install`
const sha256 = (bytes: Uint8Array) =>
  createHash('sha256').update(bytes).digest('hex')

async function withFetch(
  handler: (
    input: RequestInfo | URL,
    init?: RequestInit,
  ) => Response | Promise<Response>,
  task: () => Promise<void>,
): Promise<void> {
  const original = globalThis.fetch
  globalThis.fetch =
    (async (input, init) => await handler(input, init)) as typeof fetch
  try {
    await task()
  } finally {
    globalThis.fetch = original
  }
}

function expectFixedObjectError(
  error: unknown,
  code: string,
  status: number | null,
): void {
  assert(error instanceof FixedObjectError)
  assertEquals(error.code, code)
  assertEquals(error.status, status)
}

Deno.test('fixed credential parser rejects non-exact fields and endpoints before transport', () => {
  const parsed = parseCredentials(
    JSON.stringify(bundle),
    new Date('2029-01-01T00:00:00.000Z'),
  )
  assertEquals(
    endpointHost(parsed),
    `${'a'.repeat(32)}.r2.cloudflarestorage.com`,
  )
  for (
    const value of [
      JSON.stringify({ ...bundle, extra: true }),
      JSON.stringify({ ...bundle, endpoint: `${bundle.endpoint}/path` }),
      JSON.stringify({ ...bundle, tokenId: 'x', accessKeyId: 'fixture' }),
    ]
  ) {
    assertThrows(() =>
      parseCredentials(value, new Date('2029-01-01T00:00:00.000Z'))
    )
  }
})

Deno.test('published AWS SigV4 header vector is exact', () => {
  // AWS S3 GET Object, published header-signature example:
  // https://docs.aws.amazon.com/AmazonS3/latest/developerguide/sig-v4-header-based-auth.html
  const headers = signSigV4({
    accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
    secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
    method: 'GET',
    host: 'examplebucket.s3.amazonaws.com',
    canonicalUri: '/test.txt',
    payload: new Uint8Array(),
    now: new Date('2013-05-24T00:00:00.000Z'),
    region: 'us-east-1',
    service: 's3',
    headers: { range: 'bytes=0-9' },
  })
  assertEquals(
    headers.get('authorization'),
    'AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request,SignedHeaders=host;range;x-amz-content-sha256;x-amz-date,Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41',
  )
})

Deno.test('fixed SigV4 canonical request has S3 auto scope, exact URI, and payload hash', () => {
  const headers = signedHeaders(
    bundle,
    'GET',
    new Uint8Array(),
    new Date('2029-02-03T04:05:06.000Z'),
  )
  assertEquals(
    headers.get('x-amz-content-sha256'),
    'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
  )
  assert(
    headers.get('authorization')?.includes('/20290203/auto/s3/aws4_request'),
  )
})

Deno.test('fixed R2 signature matches an independent Python stdlib HMAC fixture', async () => {
  const headers = signedHeaders(
    bundle,
    'GET',
    new Uint8Array(),
    new Date('2029-02-03T04:05:06.000Z'),
  )
  const result = await new Deno.Command('python3', {
    args: [
      '-c',
      "import hashlib,hmac;L=chr(10);h='a'*32+'.r2.cloudflarestorage.com';p=hashlib.sha256(b'').hexdigest();d='20290203T040506Z';c='GET'+L+'/slv/slv/install'+L+L+'host:'+h+L+'x-amz-content-sha256:'+p+L+'x-amz-date:'+d+L+L+'host;x-amz-content-sha256;x-amz-date'+L+p;s='20290203/auto/s3/aws4_request';q='AWS4-HMAC-SHA256'+L+d+L+s+L+hashlib.sha256(c.encode()).hexdigest();k=hmac.new(('AWS4'+'b'*64).encode(),b'20290203',hashlib.sha256).digest();k=hmac.new(k,b'auto',hashlib.sha256).digest();k=hmac.new(k,b's3',hashlib.sha256).digest();k=hmac.new(k,b'aws4_request',hashlib.sha256).digest();print(hmac.new(k,q.encode(),hashlib.sha256).hexdigest())",
    ],
  }).output()
  assertEquals(result.code, 0)
  const signature = new TextDecoder().decode(result.stdout).trim()
  assertEquals(
    headers.get('authorization')?.split('Signature=')[1],
    signature,
  )
})

Deno.test('fixed GET accepts only raw HTTP 200 and preserves failed status without retry', async () => {
  let calls = 0
  await withFetch(
    (input, init) => {
      calls += 1
      assertEquals(String(input), objectUrl)
      assertEquals(init?.method, 'GET')
      assertEquals(init?.redirect, 'error')
      assertEquals(new Headers(init?.headers).get('content-type'), null)
      return new Response('created', { status: 201 })
    },
    async () => {
      let thrown: unknown
      try {
        await fixedObjectGet(bundle)
      } catch (error) {
        thrown = error
      }
      expectFixedObjectError(thrown, 'E_S3_GET_HTTP', 201)
    },
  )
  assertEquals(calls, 1)
})

Deno.test('fixed GET carries its deadline through stream completion and cancels a timed-out body', async () => {
  const originalSetTimeout = globalThis.setTimeout
  let cancelled = false
  let requestSignal: AbortSignal | null = null
  globalThis.setTimeout =
    ((callback: () => void) =>
      originalSetTimeout(callback, 0)) as typeof setTimeout
  try {
    await withFetch(
      (_input, init) => {
        requestSignal = init?.signal ?? null
        return new Response(
          new ReadableStream<Uint8Array>({
            pull() {
              return new Promise<void>(() => {})
            },
            cancel() {
              cancelled = true
            },
          }),
          { status: 200 },
        )
      },
      async () => {
        let thrown: unknown
        try {
          await fixedObjectGet(bundle)
        } catch (error) {
          thrown = error
        }
        expectFixedObjectError(thrown, 'E_S3_GET_TIMEOUT', 200)
        assert(requestSignal instanceof AbortSignal)
      },
    )
  } finally {
    globalThis.setTimeout = originalSetTimeout
  }
  assert(cancelled)
})

Deno.test('fixed GET bounds and cancels an oversized raw body', async () => {
  let cancelled = false
  await withFetch(
    () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array(8 * 1024 * 1024 + 1))
          },
          cancel() {
            cancelled = true
          },
        }),
        { status: 200 },
      ),
    async () => {
      let thrown: unknown
      try {
        await fixedObjectGet(bundle)
      } catch (error) {
        thrown = error
      }
      expectFixedObjectError(thrown, 'E_S3_GET_BODY_LIMIT', 200)
    },
  )
  assert(cancelled)
})

Deno.test('fixed PUT sends the exact typed-array view it signs and requires HTTP 200', async () => {
  const payload = new Uint8Array([99, 4, 5, 6, 88]).subarray(1, 4)
  let calls = 0
  let cancelled = false
  await withFetch(
    async (input, init) => {
      calls += 1
      assertEquals(String(input), objectUrl)
      assertEquals(init?.method, 'PUT')
      const headers = new Headers(init?.headers)
      assertEquals(headers.get('content-type'), 'application/octet-stream')
      assertEquals(headers.get('x-amz-content-sha256'), sha256(payload))
      const sent = new Uint8Array(await new Response(init?.body).arrayBuffer())
      assertEquals(sent, new Uint8Array([4, 5, 6]))
      return new Response(
        new ReadableStream<Uint8Array>({
          cancel() {
            cancelled = true
          },
        }),
        { status: 200 },
      )
    },
    async () => {
      assertEquals(await fixedObjectPut(bundle, payload), 200)
    },
  )
  assertEquals(calls, 1)
  assert(cancelled)
})

Deno.test('fixed PUT rejects non-200 status with a conservative status-bearing outcome', async () => {
  let calls = 0
  await withFetch(
    () => {
      calls += 1
      return new Response(null, { status: 204 })
    },
    async () => {
      let thrown: unknown
      try {
        await fixedObjectPut(bundle, new Uint8Array([1]))
      } catch (error) {
        thrown = error
      }
      expectFixedObjectError(thrown, 'E_S3_PUT_HTTP', 204)
    },
  )
  assertEquals(calls, 1)
})

Deno.test('endpoint-host CLI emits only the validated hostname', async () => {
  const result = await new Deno.Command(Deno.execPath(), {
    args: [
      'run',
      '--quiet',
      '--allow-env=SLV_R2_CREDENTIALS_JSON',
      new URL('./r2-fixed-object.ts', import.meta.url).pathname,
      'endpoint-host',
    ],
    env: { SLV_R2_CREDENTIALS_JSON: JSON.stringify(bundle) },
  }).output()
  assertEquals(result.code, 0)
  assertEquals(
    new TextDecoder().decode(result.stdout),
    `${'a'.repeat(32)}.r2.cloudflarestorage.com\n`,
  )
  assertEquals(new TextDecoder().decode(result.stderr), '')
})
