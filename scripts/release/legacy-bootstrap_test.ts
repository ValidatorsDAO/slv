import {
  assert,
  assertEquals,
  assertMatch,
  assertRejects,
  assertThrows,
} from 'jsr:@std/assert@1'
import { createHash } from 'node:crypto'
import { parseArgs, run, stopPayload } from './legacy-bootstrap.ts'

const VERSION = '2026.6.6.2026'
const SOURCE_SHA = 'a'.repeat(40)
const TAG_SHA = 'c'.repeat(40)
const SHA256 = 'b'.repeat(64)
const OLD = new TextEncoder().encode('old reviewed installer')
const DIFFERENT = new TextEncoder().encode('different reviewed installer')
const digest = (bytes: Uint8Array) =>
  createHash('sha256').update(bytes).digest('hex')
const ACCOUNT_ID = 'a'.repeat(32)
const R2_ENDPOINT = `https://${ACCOUNT_ID}.eu.r2.cloudflarestorage.com`
const R2_OBJECT = `${R2_ENDPOINT}/slv/slv/install`
const CREDENTIALS = {
  schemaVersion: 1,
  operationId: '123e4567-e89b-42d3-a456-426614174000',
  tokenId: 'fixture-token',
  expiresOn: '2030-01-01T00:00:00.000Z',
  accountId: ACCOUNT_ID,
  jurisdiction: 'eu',
  bucket: 'slv',
  endpoint: R2_ENDPOINT,
  accessKeyId: 'fixture-token',
  secretAccessKey: 'b'.repeat(64),
} as const

type Call = {
  url: string
  method: string
  authorization: string | null
  contentType: string | null
  redirect: RequestRedirect | undefined
  signal: AbortSignal | null
}
type FetchHandler = (
  call: Call,
  init: RequestInit | undefined,
) => Response | Promise<Response>
type Fixture = {
  release?: Response
  ref?: Response
  tag?: Response
  initial?: Uint8Array
  publicPreimage?: Uint8Array
  fresh?: Uint8Array
  put?: Response
  authenticatedReadback?: Uint8Array
  publicReadback?: Uint8Array
  annotated?: boolean
}

function json(value: unknown, init?: ResponseInit): Response {
  return Response.json(value, init)
}

function fixtureHandler(fixture: Fixture = {}): FetchHandler {
  const payload = stopPayload(VERSION, SOURCE_SHA)
  const initial = fixture.initial ?? OLD
  const publicPreimage = fixture.publicPreimage ?? initial
  const fresh = fixture.fresh ?? initial
  const authenticatedReadback = fixture.authenticatedReadback ?? payload
  const publicReadback = fixture.publicReadback ?? payload
  let authenticatedObjectGets = 0
  return (call) => {
    if (call.url.includes('/releases/tags/')) {
      return fixture.release ?? json({
        tag_name: `v${VERSION}`,
        immutable: true,
        draft: false,
        prerelease: false,
      })
    }
    if (call.url.includes('/git/ref/tags/')) {
      return fixture.ref ?? json({
        ref: `refs/tags/v${VERSION}`,
        object: {
          type: fixture.annotated ? 'tag' : 'commit',
          sha: fixture.annotated ? TAG_SHA : SOURCE_SHA,
        },
      })
    }
    if (call.url.includes(`/git/tags/${TAG_SHA}`)) {
      return fixture.tag ?? json({
        object: { type: 'commit', sha: SOURCE_SHA },
      })
    }
    if (call.url === 'https://storage.slv.dev/slv/install') {
      const current = authenticatedObjectGets >= 3
        ? publicReadback
        : publicPreimage
      return new Response(current.slice().buffer)
    }
    if (call.url === R2_OBJECT && call.method === 'PUT') {
      return fixture.put ?? new Response(null, { status: 200 })
    }
    if (call.url === R2_OBJECT && call.method === 'GET') {
      authenticatedObjectGets += 1
      const current = authenticatedObjectGets === 1
        ? initial
        : authenticatedObjectGets === 2
        ? fresh
        : authenticatedReadback
      return new Response(current.slice().buffer, {
        headers: authenticatedObjectGets === 1
          ? {
            'content-type': 'application/x-sh',
            'content-disposition': 'attachment; filename=install',
            'cache-control': 'public, max-age=60',
            etag: '"old"',
            'last-modified': 'Wed, 01 Jan 2025 00:00:00 GMT',
            'x-not-allowed': 'must-not-be-recorded',
          }
          : undefined,
      })
    }
    throw new Error('unexpected test request')
  }
}

async function withMock(
  handler: FetchHandler,
  task: (root: string, calls: Call[]) => Promise<void>,
): Promise<void> {
  const root = await Deno.makeTempDir({ prefix: 'slv-legacy-bootstrap-' })
  const calls: Call[] = []
  const originalFetch = globalThis.fetch
  const oldCredentials = Deno.env.get('SLV_R2_CREDENTIALS_JSON')
  Deno.env.set('SLV_R2_CREDENTIALS_JSON', JSON.stringify(CREDENTIALS))
  globalThis.fetch = (async (input, init) => {
    const headers = new Headers(init?.headers)
    const call: Call = {
      url: String(input),
      method: init?.method ?? 'GET',
      authorization: headers.get('authorization'),
      contentType: headers.get('content-type'),
      redirect: init?.redirect,
      signal: init?.signal ?? null,
    }
    calls.push(call)
    return await handler(call, init)
  }) as typeof fetch
  try {
    await task(root, calls)
  } finally {
    globalThis.fetch = originalFetch
    if (oldCredentials === undefined) {
      Deno.env.delete('SLV_R2_CREDENTIALS_JSON')
    } else Deno.env.set('SLV_R2_CREDENTIALS_JSON', oldCredentials)
    await Deno.remove(root, { recursive: true })
  }
}

function applyArgs(output: string, preimage = OLD): string[] {
  const payload = stopPayload(VERSION, SOURCE_SHA)
  return [
    'apply',
    '--version',
    VERSION,
    '--output-dir',
    output,
    '--source-sha',
    SOURCE_SHA,
    '--expected-preimage-sha256',
    digest(preimage),
    '--expected-payload-sha256',
    digest(payload),
  ]
}

async function receipt(output: string): Promise<Record<string, unknown>> {
  return JSON.parse(await Deno.readTextFile(`${output}/receipt.json`))
}

Deno.test('legacy bootstrap accepts only complete strict apply inputs', () => {
  const parsed = parseArgs([
    'apply',
    '--version',
    VERSION,
    '--output-dir',
    '/tmp/out',
    '--source-sha',
    SOURCE_SHA,
    '--expected-preimage-sha256',
    SHA256,
    '--expected-payload-sha256',
    SHA256,
  ])
  assertEquals(parsed.sourceSha, SOURCE_SHA)
  for (
    const args of [
      ['apply', '--version', VERSION, '--output-dir', '/tmp/out'],
      ['preflight', '--version', '2026.2.30.1200', '--output-dir', '/tmp/out'],
      [
        'preflight',
        '--version',
        VERSION,
        '--output-dir',
        '/tmp/out',
        '--version',
        VERSION,
      ],
      [
        'preflight',
        '--version',
        VERSION,
        '--output-dir',
        '/tmp/out',
        '--unknown',
        'x',
      ],
      [
        'apply',
        '--version',
        VERSION,
        '--output-dir',
        '/tmp/out',
        '--source-sha',
        SOURCE_SHA.toUpperCase(),
        '--expected-preimage-sha256',
        SHA256,
        '--expected-payload-sha256',
        SHA256,
      ],
    ]
  ) assertThrows(() => parseArgs(args))
})

Deno.test('legacy bootstrap STOP payload is inert, deterministic, and reviewable', async () => {
  const bytes = stopPayload(VERSION, SOURCE_SHA)
  const payload = new TextDecoder().decode(bytes)
  assert(payload.endsWith('\n'))
  assertEquals(payload.split('\n').length, 9)
  assert(
    payload.includes(
      'STOP: Legacy SLV bootstrap has moved to verified immutable releases.',
    ),
  )
  assert(payload.includes(`Release: v${VERSION}`))
  assert(payload.includes(`Reviewed source commit: ${SOURCE_SHA}`))
  assert(
    payload.includes(
      `https://raw.githubusercontent.com/ValidatorsDAO/slv/${SOURCE_SHA}/sh/install`,
    ),
  )
  assert(payload.includes('less ./slv-install-reviewed.sh'))
  assert(
    payload.includes(
      'sh ./slv-install-reviewed.sh --install-path /usr/local/bin/slv',
    ),
  )
  const root = await Deno.makeTempDir({ prefix: 'slv-legacy-stop-' })
  const script = `${root}/install`
  await Deno.writeFile(script, bytes)
  try {
    const result = await new Deno.Command('/bin/sh', { args: [script] })
      .output()
    assertEquals(result.code, 1)
    const stderr = new TextDecoder().decode(result.stderr)
    assert(stderr.includes('STOP: Legacy SLV bootstrap'))
    assert(stderr.includes('Download commit-pinned installer: curl'))
    assertEquals(
      (await Array.fromAsync(Deno.readDir(root))).map((entry) => entry.name),
      ['install'],
    )
  } finally {
    await Deno.remove(root, { recursive: true })
  }
})

Deno.test('legacy bootstrap rejects an existing or symlinked evidence directory', async () => {
  const root = await Deno.makeTempDir({ prefix: 'slv-legacy-output-' })
  try {
    const existing = `${root}/existing`
    const target = `${root}/target`
    const symlink = `${root}/symlink`
    await Deno.mkdir(existing)
    await Deno.mkdir(target)
    await Deno.symlink(target, symlink)
    await assertRejects(
      () => run(['preflight', '--version', VERSION, '--output-dir', existing]),
      Error,
      'output directory already exists',
    )
    await assertRejects(
      () => run(['preflight', '--version', VERSION, '--output-dir', symlink]),
      Error,
      'output directory is unsafe',
    )
  } finally {
    await Deno.remove(root, { recursive: true })
  }
})

Deno.test('invalid S3 bundles reject before any network effect', async () => {
  const invalidBundles = [
    { ...CREDENTIALS, endpoint: 'https://r2.example.invalid' },
    { ...CREDENTIALS, accessKeyId: 'different-token' },
    { ...CREDENTIALS, expiresOn: '2020-01-01T00:00:00.000Z' },
    { ...CREDENTIALS, extra: 'unexpected' },
  ]
  await withMock(fixtureHandler(), async (root, calls) => {
    for (const [index, bundle] of invalidBundles.entries()) {
      Deno.env.set('SLV_R2_CREDENTIALS_JSON', JSON.stringify(bundle))
      await assertRejects(
        () =>
          run([
            'preflight',
            '--version',
            VERSION,
            '--output-dir',
            `${root}/invalid-${index}`,
          ]),
        Error,
        'R2 credentials',
      )
      assertEquals(calls.length, 0)
    }
  })
})

Deno.test('preflight backs up the authenticated object, verifies its public consumer, and never validates a release or PUTs', async () => {
  await withMock(fixtureHandler(), async (root, calls) => {
    const output = `${root}/evidence`
    await run([
      'preflight',
      '--version',
      VERSION,
      '--output-dir',
      output,
      '--source-sha',
      SOURCE_SHA,
    ])
    assertEquals(calls.map((call) => [call.method, call.url]), [
      ['GET', R2_OBJECT],
      ['GET', 'https://storage.slv.dev/slv/install'],
    ])
    assert(
      calls.every((call) => call.redirect === 'error' && call.signal !== null),
    )
    assert(
      calls.slice(0, 1).every((call) =>
        call.authorization?.startsWith(
          'AWS4-HMAC-SHA256 Credential=fixture-token/',
        )
      ),
    )
    assertEquals(calls[1].authorization, null)
    const evidence = await receipt(output)
    assertEquals(evidence.release_validated, false)
    assertEquals(evidence.put_attempted, false)
    assertEquals(evidence.readback_state, 'preflight-only')
    assert(!calls.some((call) => call.url.startsWith('https://api.github.com')))
    assertEquals(
      (evidence.http_statuses as Record<string, unknown>).release,
      null,
    )
    assertEquals(
      await Deno.readFile(`${output}/authenticated-preimage.bin`),
      OLD,
    )
    assertEquals(
      await Deno.readFile(`${output}/candidate-install`),
      stopPayload(VERSION, SOURCE_SHA),
    )
    const metadata = JSON.parse(
      await Deno.readTextFile(`${output}/metadata.json`),
    )
    assertEquals(
      Object.keys(metadata.initial_authenticated_response_metadata).sort(),
      [
        'cache-control',
        'content-disposition',
        'content-type',
        'etag',
        'last-modified',
      ],
    )
    assert(!JSON.stringify(evidence).includes('x-not-allowed'))
    assert(!JSON.stringify(evidence).includes(CREDENTIALS.secretAccessKey))
    assert(!JSON.stringify(evidence).includes('AWS4-HMAC-SHA256'))
    assert(!JSON.stringify(evidence).includes('Signature='))
    assertEquals(evidence.domain_configuration, 'not_checked')
    assertEquals(evidence.public_binding, {
      method: 'authenticated-object/public-byte-agreement',
      matched: true,
    })
  })
})

Deno.test('apply validates plain GitHub documents and uses exactly one literal-key PUT after a fresh authenticated GET', async () => {
  for (const annotated of [false, true]) {
    await withMock(fixtureHandler({ annotated }), async (root, calls) => {
      const output = `${root}/evidence`
      await run(applyArgs(output))
      const putIndexes = calls.flatMap((call, index) =>
        call.method === 'PUT' ? [index] : []
      )
      assertEquals(putIndexes.length, 1)
      const put = putIndexes[0]
      assertEquals(
        calls[put - 1].url,
        R2_OBJECT,
      )
      assertEquals(
        calls[put].url,
        R2_OBJECT,
      )
      assertEquals(calls[put].contentType, 'application/octet-stream')
      assert(
        calls.some((call) =>
          call.url === 'https://storage.slv.dev/slv/install'
        ),
      )
      assert(
        calls.filter((call) => call.url.startsWith('https://api.github.com'))
          .every((call) => call.authorization === null),
      )
      assert(
        calls.filter((call) =>
          call.url === 'https://storage.slv.dev/slv/install'
        ).every((call) => call.authorization === null),
      )
      assert(
        calls.filter((call) => call.url.startsWith(R2_ENDPOINT)).every((call) =>
          call.authorization?.startsWith(
            'AWS4-HMAC-SHA256 Credential=fixture-token/',
          )
        ),
      )
      const evidence = await receipt(output)
      assertEquals(evidence.release_validated, true)
      assertEquals(evidence.put_attempted, true)
      assertEquals(evidence.put_succeeded, true)
      assertEquals(evidence.put_write_outcome, 'succeeded')
      assertEquals(evidence.readback_state, 'matched')
      assertEquals(
        (evidence.authenticated_backup as Record<string, unknown>).path,
        'authenticated-preimage.bin',
      )
      assertEquals(
        await Deno.readFile(`${output}/candidate-install`),
        stopPayload(VERSION, SOURCE_SHA),
      )
      if (annotated) {
        assert(calls.some((call) => call.url.endsWith(`/git/tags/${TAG_SHA}`)))
      } else assert(!calls.some((call) => call.url.includes('/git/tags/')))
    })
  }
})

Deno.test('preflight rejects a public mismatch and preserves its initial backup and receipt', async () => {
  await withMock(
    fixtureHandler({ publicPreimage: DIFFERENT }),
    async (root, calls) => {
      const output = `${root}/evidence`
      await assertRejects(
        () => run(['preflight', '--version', VERSION, '--output-dir', output]),
        Error,
        'public preimage does not match authenticated backup',
      )
      assertEquals(calls.filter((call) => call.method === 'PUT').length, 0)
      assertEquals(
        await Deno.readFile(`${output}/authenticated-preimage.bin`),
        OLD,
      )
      assertEquals((await receipt(output)).put_attempted, false)
    },
  )
})

Deno.test('rejects GitHub release and tag identity violations before a write', async () => {
  const cases: Array<{ name: string; fixture: Fixture; message: string }> = [
    {
      name: 'release tag identity',
      fixture: {
        release: json({
          tag_name: 'v2026.1.1.1',
          immutable: true,
          draft: false,
          prerelease: false,
        }),
      },
      message: 'exact immutable published stable',
    },
    {
      name: 'mutable release',
      fixture: {
        release: json({
          tag_name: `v${VERSION}`,
          immutable: false,
          draft: false,
          prerelease: false,
        }),
      },
      message: 'exact immutable published stable',
    },
    {
      name: 'draft release',
      fixture: {
        release: json({
          tag_name: `v${VERSION}`,
          immutable: true,
          draft: true,
          prerelease: false,
        }),
      },
      message: 'exact immutable published stable',
    },
    {
      name: 'prerelease',
      fixture: {
        release: json({
          tag_name: `v${VERSION}`,
          immutable: true,
          draft: false,
          prerelease: true,
        }),
      },
      message: 'exact immutable published stable',
    },
    {
      name: 'ref identity',
      fixture: {
        ref: json({
          ref: 'refs/tags/vwrong',
          object: { type: 'commit', sha: SOURCE_SHA },
        }),
      },
      message: 'tag ref is not exact',
    },
    {
      name: 'uppercase ref SHA',
      fixture: {
        ref: json({
          ref: `refs/tags/v${VERSION}`,
          object: { type: 'commit', sha: SOURCE_SHA.toUpperCase() },
        }),
      },
      message: 'invalid SHA',
    },
    {
      name: 'unsupported ref type',
      fixture: {
        ref: json({
          ref: `refs/tags/v${VERSION}`,
          object: { type: 'tree', sha: SOURCE_SHA },
        }),
      },
      message: 'invalid type',
    },
  ]
  for (const testCase of cases) {
    await withMock(fixtureHandler(testCase.fixture), async (root, calls) => {
      await assertRejects(
        () => run(applyArgs(`${root}/evidence`)),
        Error,
        testCase.message,
      )
      assertEquals(
        calls.filter((call) => call.method === 'PUT').length,
        0,
        testCase.name,
      )
    })
  }
})

Deno.test('apply fails closed on reviewed payload, initial preimage, and fresh preimage drift', async () => {
  const cases: Array<
    {
      name: string
      args: (output: string) => string[]
      fixture: Fixture
      message: string
    }
  > = [
    {
      name: 'payload',
      args: (output) => {
        const args = applyArgs(output)
        args[args.indexOf('--expected-payload-sha256') + 1] = SHA256
        return args
      },
      fixture: {},
      message: 'candidate payload does not match',
    },
    {
      name: 'initial preimage',
      args: (output) => applyArgs(output, DIFFERENT),
      fixture: {},
      message: 'authenticated preimage does not match',
    },
    {
      name: 'fresh preimage',
      args: (output) => applyArgs(output),
      fixture: { fresh: DIFFERENT },
      message: 'fresh authenticated preimage changed',
    },
  ]
  for (const testCase of cases) {
    await withMock(fixtureHandler(testCase.fixture), async (root, calls) => {
      await assertRejects(
        () => run(testCase.args(`${root}/evidence`)),
        Error,
        testCase.message,
      )
      assertEquals(
        calls.filter((call) => call.method === 'PUT').length,
        0,
        testCase.name,
      )
    })
  }
})

Deno.test('annotated tag peeling rejects cycles and its bounded depth before a write', async () => {
  const cyclic = fixtureHandler({
    annotated: true,
    tag: json({ object: { type: 'tag', sha: TAG_SHA } }),
  })
  await withMock(cyclic, async (root, calls) => {
    await assertRejects(
      () => run(applyArgs(`${root}/cycle`)),
      Error,
      'annotated tag peel is cyclic or exceeds its bound',
    )
    assertEquals(
      calls.filter((call) => call.url.includes('/git/tags/')).length,
      1,
    )
    assertEquals(calls.filter((call) => call.method === 'PUT').length, 0)
  })

  const chain = ['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((digit) =>
    digit.repeat(40)
  )
  const bounded = fixtureHandler({
    ref: json({
      ref: `refs/tags/v${VERSION}`,
      object: { type: 'tag', sha: chain[0] },
    }),
  })
  await withMock((call, init) => {
    const position = chain.findIndex((sha) =>
      call.url.endsWith(`/git/tags/${sha}`)
    )
    if (position >= 0) {
      return json({ object: { type: 'tag', sha: chain[position + 1] } })
    }
    return bounded(call, init)
  }, async (root, calls) => {
    await assertRejects(
      () => run(applyArgs(`${root}/bound`)),
      Error,
      'annotated tag peel is cyclic or exceeds its bound',
    )
    assertEquals(
      calls.filter((call) => call.url.includes('/git/tags/')).length,
      8,
    )
    assertEquals(calls.filter((call) => call.method === 'PUT').length, 0)
  })
})

Deno.test('bounds streamed installer and JSON responses, fails malformed JSON, and does not retry', async () => {
  const oversizedInstaller = new Uint8Array(8 * 1024 * 1024 + 1)
  await withMock(
    fixtureHandler({ initial: oversizedInstaller }),
    async (root, calls) => {
      await assertRejects(
        () =>
          run([
            'preflight',
            '--version',
            VERSION,
            '--output-dir',
            `${root}/installer`,
          ]),
        Error,
        'initial authenticated preimage response body exceeds its size limit',
      )
      assertEquals(calls.length, 1)
    },
  )
  await withMock(
    fixtureHandler({
      release: new Response(`{"padding":"${'x'.repeat(1024 * 1024)}"}`),
    }),
    async (root, calls) => {
      await assertRejects(
        () => run(applyArgs(`${root}/large-json`)),
        Error,
        'GitHub release response body exceeds its size limit',
      )
      assertEquals(
        calls.filter((call) => call.url.includes('/releases/tags/')).length,
        1,
      )
      assertEquals(calls.filter((call) => call.method === 'PUT').length, 0)
    },
  )
})

Deno.test('records an ambiguous PUT HTTP failure and an acknowledged write with mismatched readback without retries', async () => {
  await withMock(
    fixtureHandler({ put: new Response('no', { status: 500 }) }),
    async (root, calls) => {
      const output = `${root}/put-http`
      await assertRejects(
        () => run(applyArgs(output)),
        Error,
        'object upload returned an unsuccessful HTTP response',
      )
      const evidence = await receipt(output)
      assertEquals(evidence.put_attempted, true)
      assertEquals(evidence.put_write_outcome, 'unknown')
      assertEquals(
        (evidence.http_statuses as Record<string, unknown>).put,
        500,
      )
      assertEquals(
        (evidence.error as Record<string, unknown>).code,
        'E_PUT_HTTP',
      )
      assertEquals(calls.filter((call) => call.method === 'PUT').length, 1)
    },
  )
  await withMock(
    fixtureHandler({ publicReadback: DIFFERENT }),
    async (root, calls) => {
      const output = `${root}/readback`
      await assertRejects(
        () => run(applyArgs(output)),
        Error,
        'post-write readback hash mismatch',
      )
      const evidence = await receipt(output)
      assertEquals(evidence.put_attempted, true)
      assertEquals(evidence.put_write_outcome, 'succeeded')
      assertEquals(calls.filter((call) => call.method === 'PUT').length, 1)
    },
  )
})

Deno.test('records a failed authenticated S3 GET status at its receipt stage', async () => {
  await withMock(
    () => new Response('failed', { status: 503 }),
    async (root, calls) => {
      const output = `${root}/get-http`
      await assertRejects(
        () => run(['preflight', '--version', VERSION, '--output-dir', output]),
        Error,
        'initial authenticated preimage returned an unsuccessful HTTP response',
      )
      const evidence = await receipt(output)
      assertEquals(
        (evidence.http_statuses as Record<string, unknown>)
          .initial_authenticated_preimage,
        503,
      )
      assertEquals(
        (evidence.error as Record<string, unknown>).code,
        'E_INITIAL_AUTHENTICATED_PREIMAGE_HTTP',
      )
      assertEquals(calls.length, 1)
    },
  )
})

Deno.test('treats aborts as bounded timeouts and configures every request to reject redirects', async () => {
  const originalSetTimeout = globalThis.setTimeout
  globalThis.setTimeout =
    ((callback: () => void) =>
      originalSetTimeout(callback, 0)) as typeof setTimeout
  try {
    await withMock(
      (_call, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener(
            'abort',
            () => reject(new DOMException('aborted', 'AbortError')),
            { once: true },
          )
        }),
      async (root, calls) => {
        const output = `${root}/timeout`
        await assertRejects(
          () =>
            run(['preflight', '--version', VERSION, '--output-dir', output]),
          Error,
          'initial authenticated preimage request timed out',
        )
        assertEquals(calls.length, 1)
        assertEquals(calls[0].redirect, 'error')
        assert(calls[0].signal instanceof AbortSignal)
        const evidence = await receipt(output)
        assertEquals(
          (evidence.error as Record<string, unknown>).code,
          'E_INITIAL_AUTHENTICATED_PREIMAGE_TIMEOUT',
        )
      },
    )
    await withMock(
      () =>
        new Response(
          new ReadableStream({
            pull() {
              return new Promise<void>(() => {})
            },
          }),
        ),
      async (root) => {
        const output = `${root}/stream-timeout`
        await assertRejects(
          () =>
            run(['preflight', '--version', VERSION, '--output-dir', output]),
          Error,
          'initial authenticated preimage request timed out',
        )
        const evidence = await receipt(output)
        assertEquals(
          (evidence.http_statuses as Record<string, unknown>)
            .initial_authenticated_preimage,
          200,
        )
      },
    )
  } finally {
    globalThis.setTimeout = originalSetTimeout
  }
})

Deno.test('sanitizes unknown request exceptions and CLI stderr without leaking a sentinel credential', async () => {
  const sentinel = 'SENTINEL_CREDENTIAL_SHOULD_NOT_LEAK'
  await withMock(() => {
    throw new Error(sentinel)
  }, async (root) => {
    const output = `${root}/evidence`
    await assertRejects(
      () => run(['preflight', '--version', VERSION, '--output-dir', output]),
      Error,
      'initial authenticated preimage request failed',
    )
    const evidence = await Deno.readTextFile(`${output}/receipt.json`)
    assert(!evidence.includes(sentinel))
    assert(!evidence.includes(CREDENTIALS.secretAccessKey))
  })

  const root = await Deno.makeTempDir({ prefix: 'slv-legacy-cli-' })
  try {
    const result = await new Deno.Command(Deno.execPath(), {
      args: [
        'run',
        '--quiet',
        '--allow-read',
        '--allow-write',
        '--allow-env',
        new URL('./legacy-bootstrap.ts', import.meta.url).pathname,
        'preflight',
        '--version',
        VERSION,
        '--output-dir',
        `${root}/evidence`,
      ],
      clearEnv: true,
      env: { CLOUDFLARE_ACCOUNT_ID: sentinel },
    }).output()
    const stderr = new TextDecoder().decode(result.stderr)
    assertEquals(result.code, 1)
    assertMatch(stderr, /^legacy bootstrap failed\n$/)
    assert(!stderr.includes(sentinel))
  } finally {
    await Deno.remove(root, { recursive: true })
  }
})
