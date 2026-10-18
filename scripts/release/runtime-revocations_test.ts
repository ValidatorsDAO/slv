import { assertEquals, assertRejects, assertThrows } from 'jsr:@std/assert@1'
import { join } from 'node:path'
import {
  checkFreshRuntimeRevocation,
  checkReviewedRuntimeRevocation,
  parseRuntimeRevocations,
  runRuntimeRevocationsCommand,
  RUNTIME_REVOCATIONS_MAX_BYTES,
  RUNTIME_REVOCATIONS_PATH,
  RUNTIME_REVOCATIONS_URL,
  RuntimeRevocationError,
  verifyRuntimeRevocationBinding,
} from './runtime-revocations.ts'
const identity = 'a'.repeat(64), unrelated = 'b'.repeat(64)
const encode = (value: string) => new TextEncoder().encode(value)
const policy = (ids: string[] = []) =>
  JSON.stringify({ schema_version: 1, revoked_identities: ids })
const reply = (ids: string[] = []) =>
  new Response(policy(ids), {
    headers: {
      etag: '"policy-v1"',
      'last-modified': 'Sun, 18 Oct 2026 00:00:00 GMT',
    },
  })
Deno.test('strict policy parser rejects duplicate keys, duplicate identities, schema/type/UTF-8/size violations', () => {
  assertEquals(parseRuntimeRevocations(encode(policy())), {
    schema_version: 1,
    revoked_identities: [],
  })
  assertEquals(
    parseRuntimeRevocations(
      encode(
        ` { "revoked_identities" : ["${identity}"], "schema_version" : 1 } `,
      ),
    ).revoked_identities,
    [identity],
  )
  const bad = [
    '',
    'null',
    '[]',
    '{}',
    '{"schema_version":1}',
    '{"revoked_identities":[]}',
    '{"schema_version":1,"schema_version":1,"revoked_identities":[]}',
    '{"schema_version":1,"schema_\\u0076ersion":1,"revoked_identities":[]}',
    '{"schema_version":1,"revoked_identities":[],"extra":true}',
    '{"schema_version":1.0,"revoked_identities":[]}',
    '{"schema_version":1e0,"revoked_identities":[]}',
    '{"schema_version":true,"revoked_identities":[]}',
    '{"schema_version":2,"revoked_identities":[]}',
    '{"schema_version":1,"revoked_identities":null}',
    '{"schema_version":1,"revoked_identities":[1]}',
    policy([identity, identity]),
    policy(['A'.repeat(64)]),
    policy(['a'.repeat(63)]),
    policy(['a'.repeat(65)]),
    '{"schema_version":1,"revoked_identities":[],}',
    '{"schema_version":1,"revoked_identities":["' + identity + '",]}',
    policy() + '{}',
    policy().slice(0, -1),
    '\ufeff' + policy(),
  ]
  for (const value of bad) {
    assertThrows(() => parseRuntimeRevocations(encode(value)))
  }
  for (
    const raw of [
      new Uint8Array([0xff]),
      new Uint8Array([0xc3]),
      new Uint8Array(RUNTIME_REVOCATIONS_MAX_BYTES + 1),
    ]
  ) assertThrows(() => parseRuntimeRevocations(raw))
})
Deno.test('reviewed policy is mandatory, deny-only, and never claims an unbound checkout commit', async () => {
  const root = await Deno.realPath(await Deno.makeTempDir())
  try {
    await assertRejects(
      () => checkReviewedRuntimeRevocation(identity, root),
      Error,
      'missing',
    )
    await Deno.mkdir(join(root, 'source-materials'))
    const path = join(root, RUNTIME_REVOCATIONS_PATH)
    await Deno.writeTextFile(path, policy([unrelated]))
    const allowed = await checkReviewedRuntimeRevocation(identity, root)
    assertEquals(allowed.outcome, 'allow')
    assertEquals(allowed.kind, 'reviewed_checkout_policy')
    assertEquals(allowed.source_commit, null)
    await Deno.writeTextFile(path, policy([identity]))
    const error = await assertRejects(
      () => checkReviewedRuntimeRevocation(identity, root),
      RuntimeRevocationError,
      'revoked',
    )
    assertEquals(error.observation?.outcome, 'deny')
    assertEquals(error.observation?.qualification_identity, identity)
    await Deno.writeTextFile(path, 'bad')
    await assertRejects(() => checkReviewedRuntimeRevocation(identity, root))
    await Deno.writeFile(
      path,
      new Uint8Array(RUNTIME_REVOCATIONS_MAX_BYTES + 1),
    )
    await assertRejects(
      () => checkReviewedRuntimeRevocation(identity, root),
      Error,
      'bounded',
    )
    await Deno.remove(path)
    await Deno.symlink('/dev/null', path)
    await assertRejects(
      () => checkReviewedRuntimeRevocation(identity, root),
      Error,
      'regular',
    )
  } finally {
    await Deno.remove(root, { recursive: true })
  }
})
Deno.test('fresh policy fixed URL sends no credentials, disallows redirects and never reuses stale success', async () => {
  let count = 0
  const fetcher: typeof fetch = (input, init) => {
    assertEquals(String(input), RUNTIME_REVOCATIONS_URL)
    assertEquals(init?.credentials, 'omit')
    assertEquals(init?.redirect, 'error')
    assertEquals(init?.cache, 'no-store')
    const headers = new Headers(init?.headers)
    assertEquals(headers.has('authorization'), false)
    assertEquals(headers.has('cookie'), false)
    assertEquals(headers.get('cache-control'), 'no-cache')
    return Promise.resolve(reply(++count === 1 ? [unrelated] : [identity]))
  }
  const first = await checkFreshRuntimeRevocation(identity, { fetch: fetcher })
  assertEquals(first.outcome, 'allow')
  assertEquals(first.source_commit, null)
  assertEquals(first.origin, RUNTIME_REVOCATIONS_URL)
  assertEquals(first.validators?.etag, '"policy-v1"')
  await assertRejects(
    () => checkFreshRuntimeRevocation(identity, { fetch: fetcher }),
    Error,
    'revoked',
  )
  assertEquals(count, 2)
  for (
    const status of [204, 301, 302, 304, 307, 308, 401, 403, 404, 429, 500]
  ) {
    const transport = {
      fetch: () =>
        Promise.resolve(
          new Response(null, {
            status,
            headers: { location: RUNTIME_REVOCATIONS_URL },
          }),
        ),
    }
    await assertRejects(
      () => checkFreshRuntimeRevocation(identity, transport),
      Error,
      'HTTP 200',
    )
  }
  const altered = reply()
  Object.defineProperty(altered, 'url', {
    value: RUNTIME_REVOCATIONS_URL.replace(
      'refs/heads/main',
      'refs/heads/other',
    ),
  })
  await assertRejects(
    () =>
      checkFreshRuntimeRevocation(identity, {
        fetch: () => Promise.resolve(altered),
      }),
    Error,
    'fixed current-main',
  )
  const redirected = reply()
  Object.defineProperty(redirected, 'redirected', { value: true })
  await assertRejects(
    () =>
      checkFreshRuntimeRevocation(identity, {
        fetch: () => Promise.resolve(redirected),
      }),
    Error,
    'fixed current-main',
  )
  await assertRejects(
    () =>
      checkFreshRuntimeRevocation(identity, {
        fetch: () => Promise.reject(new TypeError('TLS failure')),
      }),
    Error,
    'fetch failed',
  )
})
Deno.test('fresh policy enforces declared and decoded streaming body bounds and cleans streams', async () => {
  let cancelled = 0
  const streamed = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(new Uint8Array(RUNTIME_REVOCATIONS_MAX_BYTES))
      c.enqueue(new Uint8Array(1))
    },
    cancel() {
      cancelled++
    },
  })
  await assertRejects(
    () =>
      checkFreshRuntimeRevocation(identity, {
        fetch: () =>
          Promise.resolve(
            new Response(streamed, {
              headers: { 'content-encoding': 'gzip', 'content-length': '12' },
            }),
          ),
      }),
    Error,
    '256 KiB',
  )
  assertEquals(cancelled, 1)
  await assertRejects(
    () =>
      checkFreshRuntimeRevocation(identity, {
        fetch: () =>
          Promise.resolve(
            new Response(policy(), {
              headers: {
                'content-length': String(RUNTIME_REVOCATIONS_MAX_BYTES + 1),
              },
            }),
          ),
      }),
    Error,
    '256 KiB',
  )
  for (const bytes of [encode(''), encode('{bad'), new Uint8Array([0xff])]) {
    await assertRejects(() =>
      checkFreshRuntimeRevocation(identity, {
        fetch: () => Promise.resolve(new Response(bytes)),
      })
    )
  }
})
Deno.test('ten-second deadline covers both response headers and a stalled body with cancellation', async () => {
  let headerAborted = false, bodyCancelled = false, bodyAborted = false
  const start = performance.now()
  const headers = checkFreshRuntimeRevocation(identity, {
    fetch: (_input, init) =>
      new Promise((_resolve, reject) => {
        init!.signal!.addEventListener('abort', () => {
          headerAborted = true
          reject(new DOMException('aborted', 'AbortError'))
        }, { once: true })
      }),
  })
  const body = checkFreshRuntimeRevocation(identity, {
    fetch: (_input, init) => {
      init!.signal!.addEventListener('abort', () => {
        bodyAborted = true
      }, { once: true })
      return Promise.resolve(
        new Response(
          new ReadableStream({
            start() {},
            cancel() {
              bodyCancelled = true
            },
          }),
        ),
      )
    },
  })
  await Promise.all([
    assertRejects(() => headers, Error, 'timed out'),
    assertRejects(() => body, Error, 'timed out'),
  ])
  assertEquals(headerAborted, true)
  assertEquals(bodyAborted, true)
  assertEquals(bodyCancelled, true)
  if (performance.now() - start > 11_000) {
    throw new Error('deadline did not bound the complete fetch')
  }
})
Deno.test('shipped command handler always checks current policy before creating an acceptance receipt', async () => {
  const root = await Deno.realPath(await Deno.makeTempDir())
  try {
    const first = join(root, 'first.json'), second = join(root, 'second.json')
    await runRuntimeRevocationsCommand(['fresh', identity, first], {
      fetch: () => Promise.resolve(reply()),
    })
    await assertRejects(
      () =>
        runRuntimeRevocationsCommand(['fresh', identity, second], {
          fetch: () => Promise.resolve(reply([identity])),
        }),
      Error,
      'revoked',
    )
    await assertRejects(() => Deno.stat(second), Deno.errors.NotFound)
    await assertRejects(
      () =>
        runRuntimeRevocationsCommand(['fresh', identity, second], {
          fetch: () => Promise.resolve(new Response(null, { status: 404 })),
        }),
      Error,
      'HTTP 200',
    )
    await assertRejects(
      () =>
        runRuntimeRevocationsCommand(['fresh'], {
          fetch: () => Promise.resolve(reply()),
        }),
      Error,
      'usage',
    )
    await Deno.mkdir(join(root, 'source-materials'))
    await Deno.writeTextFile(
      join(root, RUNTIME_REVOCATIONS_PATH),
      policy([identity]),
    )
    await assertRejects(
      () => runRuntimeRevocationsCommand(['local', root, identity, second]),
      Error,
      'revoked',
    )
    await assertRejects(() => Deno.stat(second), Deno.errors.NotFound)
  } finally {
    await Deno.remove(root, { recursive: true })
  }
})
Deno.test('actual local-policy CLI denies missing/listed/malformed policies before producing receipts', async () => {
  const root = await Deno.realPath(await Deno.makeTempDir())
  try {
    await Deno.mkdir(join(root, 'source-materials'))
    const input = join(root, RUNTIME_REVOCATIONS_PATH),
      output = join(root, 'receipt.json')
    const command = async () =>
      new Deno.Command(Deno.execPath(), {
        args: [
          'run',
          '--cached-only',
          '--frozen',
          '--no-prompt',
          '--allow-read',
          '--allow-write',
          new URL('./runtime-revocations.ts', import.meta.url).pathname,
          'local',
          root,
          identity,
          output,
        ],
        stdin: 'null',
        stdout: 'piped',
        stderr: 'piped',
      }).output()
    assertEquals((await command()).success, false)
    for (
      const value of [
        policy([identity]),
        '{"schema_version":1,"schema_version":1,"revoked_identities":[]}',
        'bad',
      ]
    ) {
      await Deno.writeTextFile(input, value)
      assertEquals((await command()).success, false)
      await assertRejects(() => Deno.stat(output), Deno.errors.NotFound)
    }
    await Deno.writeTextFile(input, policy([unrelated]))
    const allowed = await command()
    if (!allowed.success) {
      throw new Error(new TextDecoder().decode(allowed.stderr))
    }
    assertEquals(JSON.parse(await Deno.readTextFile(output)).outcome, 'allow')
  } finally {
    await Deno.remove(root, { recursive: true })
  }
})

Deno.test('receipt snapshots cannot omit revocation, change identity/origin/digest or masquerade as final', async () => {
  const root = await Deno.realPath(await Deno.makeTempDir())
  try {
    await Deno.mkdir(join(root, 'source-materials'))
    await Deno.writeTextFile(join(root, RUNTIME_REVOCATIONS_PATH), policy())
    const local = await checkReviewedRuntimeRevocation(identity, root),
      remote = await checkFreshRuntimeRevocation(identity, {
        fetch: () => Promise.resolve(reply()),
      })
    const expected = {
      identity,
      mode: 'candidate-validation' as const,
      reviewedPolicySha256: local.policy_sha256,
    }
    const valid = { reviewed_checkout_policy: local, current_main_policy: null }
    verifyRuntimeRevocationBinding(valid, expected)
    verifyRuntimeRevocationBinding({ ...valid, current_main_policy: remote }, {
      ...expected,
      mode: 'final-qualified',
    })
    for (
      const change of [
        (x: any) => delete x.reviewed_checkout_policy,
        (x: any) => x.extra = true,
        (x: any) => x.reviewed_checkout_policy.outcome = 'deny',
        (x: any) =>
          x.reviewed_checkout_policy.qualification_identity = unrelated,
        (x: any) => x.reviewed_checkout_policy.policy_sha256 = unrelated,
        (x: any) => x.reviewed_checkout_policy.origin = RUNTIME_REVOCATIONS_URL,
        (x: any) => x.current_main_policy = remote,
      ]
    ) {
      const altered = structuredClone(valid)
      change(altered)
      assertThrows(() => verifyRuntimeRevocationBinding(altered, expected))
    }
    assertThrows(() =>
      verifyRuntimeRevocationBinding(valid, {
        ...expected,
        mode: 'final-qualified',
      })
    )
  } finally {
    await Deno.remove(root, { recursive: true })
  }
})
Deno.test('actual compile, qualified package and publication CLIs enforce reviewed denial before effects', async () => {
  const root = await Deno.realPath(await Deno.makeTempDir())
  const moduleRoot = new URL('../../', import.meta.url).pathname
  const sha = 'c'.repeat(40)
  try {
    await Deno.mkdir(join(root, 'source-materials'))
    await Deno.mkdir(join(root, 'dist/release'), { recursive: true })
    const manifest = await Deno.readFile(
      new URL(
        '../../source-materials/runtime-qualification.json',
        import.meta.url,
      ),
    )
    await Deno.writeFile(
      join(root, 'source-materials/runtime-qualification.json'),
      manifest,
    )
    const hash = await crypto.subtle.digest('SHA-256', manifest)
    const selected = Array.from(
      new Uint8Array(hash),
      (v) => v.toString(16).padStart(2, '0'),
    ).join('')
    await Deno.writeTextFile(
      join(root, RUNTIME_REVOCATIONS_PATH),
      policy([selected]),
    )
    const marker = join(root, 'dist/release/existing-marker')
    await Deno.writeTextFile(marker, 'preserve')
    const run = async (file: string, args: string[]) =>
      new Deno.Command(Deno.execPath(), {
        cwd: root,
        args: [
          'run',
          '--cached-only',
          '--frozen',
          '--no-prompt',
          '--config',
          join(moduleRoot, 'deno.json'),
          '--allow-read',
          '--allow-write',
          join(moduleRoot, 'scripts/release', file),
          ...args,
        ],
        stdin: 'null',
        stdout: 'piped',
        stderr: 'piped',
      }).output()
    const commands: [string, string[]][] = [
      ['build-product.ts', [
        'compile',
        '--target',
        'x86_64-apple-darwin',
        '--source-sha',
        sha,
        '--source-ref',
        'refs/heads/main',
        '--run-id',
        '1',
        '--run-attempt',
        '1',
        '--workflow-sha',
        sha,
        '--qualification-dir',
        root,
        '--qualification-state',
        'candidate-validation',
        '--profile',
        'hosted',
        '--license-attempt',
        '1',
        '--license-sha256',
        identity,
      ]],
      ['release.ts', [
        'pack-ci-qualified',
        '2026.10.18.1200',
        sha,
        'refs/pull/1/merge',
        '1',
        '1',
        '2026-10-18T12:00:00Z',
        sha,
        root,
      ]],
      ['release.ts', [
        'verify-qualified-publication',
        join(root, 'dist/release'),
        sha,
        '1',
        '1',
        sha,
      ]],
    ]
    for (const [file, args] of commands) {
      const result = await run(file, args)
      assertEquals(result.success, false)
      if (
        !new TextDecoder().decode(result.stderr).includes(
          'selected qualification is revoked',
        )
      ) throw new Error(new TextDecoder().decode(result.stderr))
      assertEquals(await Deno.readTextFile(marker), 'preserve')
    }
    await Deno.remove(join(root, RUNTIME_REVOCATIONS_PATH))
    const missing = await run(...commands[0])
    assertEquals(missing.success, false)
    if (
      !new TextDecoder().decode(missing.stderr).includes(
        'reviewed policy is missing',
      )
    ) throw new Error(new TextDecoder().decode(missing.stderr))
  } finally {
    await Deno.remove(root, { recursive: true })
  }
})
