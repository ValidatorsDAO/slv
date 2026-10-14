import { assert, assertEquals, assertThrows } from 'jsr:@std/assert@1'
import { createHash } from 'node:crypto'
import { parseArgs, run, stopPayload } from './legacy-bootstrap.ts'

const SHA40 = 'a'.repeat(40)
const SHA256 = 'b'.repeat(64)

Deno.test('legacy bootstrap accepts only complete strict apply inputs', () => {
  const parsed = parseArgs([
    'apply', '--version', '2026.6.6.2026', '--output-dir', '/tmp/out',
    '--source-sha', SHA40, '--expected-preimage-sha256', SHA256,
    '--expected-payload-sha256', SHA256,
  ])
  assertEquals(parsed.sourceSha, SHA40)
  assertThrows(() => parseArgs(['apply', '--version', '2026.6.6.2026', '--output-dir', '/tmp/out']))
  assertThrows(() => parseArgs(['preflight', '--version', '2026.2.30.1200', '--output-dir', '/tmp/out']))
  assertThrows(() => parseArgs(['preflight', '--version', '2026.6.6.2026', '--output-dir', '/tmp/out', '--version', '2026.6.6.2026']))
  assertThrows(() => parseArgs(['preflight', '--version', '2026.6.6.2026', '--output-dir', '/tmp/out', '--unknown', 'x']))
})

Deno.test('legacy bootstrap STOP payload is inert, deterministic, and reviewable', () => {
  const bytes = stopPayload('2026.6.6.2026', SHA40)
  const payload = new TextDecoder().decode(bytes)
  assert(payload.endsWith('\n'))
  assert(payload.includes('STOP: Legacy SLV bootstrap has moved to verified immutable releases.'))
  assert(payload.includes(`Release: v2026.6.6.2026`))
  assert(payload.includes(`Reviewed source commit: ${SHA40}`))
  assert(payload.includes(`https://raw.githubusercontent.com/ValidatorsDAO/slv/${SHA40}/sh/install`))
  assert(payload.includes('less ./slv-install-reviewed.sh'))
  assert(payload.includes('sh ./slv-install-reviewed.sh --install-path /usr/local/bin/slv'))
  assert(!payload.includes('curl ' + '\n'))
  assert(!payload.includes('sudo '))
})

Deno.test('executing STOP payload only prints guidance and returns failure', async () => {
  const root = await Deno.makeTempDir({ prefix: 'slv-legacy-stop-' })
  const script = `${root}/install`
  await Deno.writeFile(script, stopPayload('2026.6.6.2026', SHA40))
  try {
    const result = await new Deno.Command('/bin/sh', { args: [script] }).output()
    assertEquals(result.code, 1)
    const stderr = new TextDecoder().decode(result.stderr)
    assert(stderr.includes('STOP: Legacy SLV bootstrap'))
    assert(stderr.includes('Download commit-pinned installer: curl'))
    assertEquals((await Array.fromAsync(Deno.readDir(root))).map((entry) => entry.name), ['install'])
  } finally {
    await Deno.remove(root, { recursive: true })
  }
})

Deno.test('workflow isolates explicit legacy-bootstrap dispatch from normal release jobs', async () => {
  const workflow = await Deno.readTextFile(
    new URL('../../.github/workflows/slv-remote-build.yml', import.meta.url),
  )
  assert(workflow.includes('default: release'))
  assert(workflow.includes('legacy-bootstrap-preflight'))
  assert(workflow.includes('legacy-bootstrap-apply'))
  assert(workflow.includes('slv-legacy-bootstrap-dispatch-{0}'))
  assert(workflow.includes('slv-legacy-bootstrap-object-${{ github.repository }}-slv-install'))
  assert(workflow.includes('github.ref }}'))
  const job = workflow.slice(workflow.indexOf('  legacy-bootstrap:'), workflow.indexOf('\n  resolve:'))
  assert(job.includes('test "$REF" = refs/heads/main'))
  assert(job.includes('persist-credentials: false'))
  assert(job.includes('--allow-net=api.cloudflare.com,api.github.com,storage.slv.dev'))
  assert(job.includes('retention-days: 7'))
  assert(!job.includes('contents: write'))
})

Deno.test('valid apply uses one PUT after the fresh authenticated preimage and records sanitized evidence', async () => {
  const root = await Deno.makeTempDir({ prefix: 'slv-legacy-bootstrap-' })
  const output = `${root}/evidence`
  const payload = stopPayload('2026.6.6.2026', SHA40)
  const payloadHash = createHash('sha256').update(payload).digest('hex')
  const preimage = new TextEncoder().encode('old reviewed installer')
  const preimageHash = createHash('sha256').update(preimage).digest('hex')
  const calls: Array<{ url: string; method: string }> = []
  const originalFetch = globalThis.fetch
  const oldAccount = Deno.env.get('CLOUDFLARE_ACCOUNT_ID')
  const oldToken = Deno.env.get('CLOUDFLARE_API_TOKEN')
  Deno.env.set('CLOUDFLARE_ACCOUNT_ID', 'account-fixture')
  Deno.env.set('CLOUDFLARE_API_TOKEN', 'sentinel-secret')
  globalThis.fetch = (async (input, init) => {
    const url = String(input)
    const method = init?.method ?? 'GET'
    calls.push({ url, method })
    if (url.includes('/domains/custom/')) return Response.json({ success: true, result: { domain: 'storage.slv.dev', enabled: true, status: 'active' } })
    if (url.includes('/releases/tags/')) return Response.json({ immutable: true, draft: false, prerelease: false, success: true })
    if (url.includes('/git/ref/tags/')) return Response.json({ success: true, object: { type: 'commit', sha: SHA40 } })
    if (url.includes('/objects/slv/install') && method === 'PUT') return Response.json({ success: true, result: { key: 'slv/install', size: payload.length } })
    if (url === 'https://storage.slv.dev/slv/install') return new Response(payload.buffer as ArrayBuffer)
    if (url.includes('/objects/slv/install')) return new Response((method === 'GET' && calls.filter((call) => call.url.includes('/objects/slv/install') && call.method === 'GET').length > 2 ? payload : preimage).buffer as ArrayBuffer)
    throw new Error(`unexpected fetch ${method} ${url}`)
  }) as typeof fetch
  try {
    await run(['apply', '--version', '2026.6.6.2026', '--output-dir', output, '--source-sha', SHA40, '--expected-preimage-sha256', preimageHash, '--expected-payload-sha256', payloadHash])
    assertEquals(calls.filter((call) => call.method === 'PUT').length, 1)
    const receipt = await Deno.readTextFile(`${output}/receipt.json`)
    assert(receipt.includes('"put_succeeded": true'))
    assert(!receipt.includes('sentinel-secret'))
    assertEquals(await Deno.readFile(`${output}/candidate-install`), payload)
  } finally {
    globalThis.fetch = originalFetch
    if (oldAccount === undefined) Deno.env.delete('CLOUDFLARE_ACCOUNT_ID'); else Deno.env.set('CLOUDFLARE_ACCOUNT_ID', oldAccount)
    if (oldToken === undefined) Deno.env.delete('CLOUDFLARE_API_TOKEN'); else Deno.env.set('CLOUDFLARE_API_TOKEN', oldToken)
    await Deno.remove(root, { recursive: true })
  }
})
