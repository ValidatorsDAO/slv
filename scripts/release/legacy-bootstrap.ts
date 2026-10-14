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

function fail(message: string): never {
  throw new Error(message)
}

export function parseArgs(args: string[]): Options {
  const [operation, ...rest] = args
  if (operation !== 'preflight' && operation !== 'apply') {
    fail('usage: legacy-bootstrap.ts preflight|apply --version VERSION --output-dir EXCLUSIVE [--source-sha SHA] [--expected-preimage-sha256 SHA] [--expected-payload-sha256 SHA]')
  }
  const values = new Map<string, string>()
  for (let index = 0; index < rest.length; index += 2) {
    const flag = rest[index]
    const value = rest[index + 1]
    if (!['--version', '--output-dir', '--source-sha', '--expected-preimage-sha256', '--expected-payload-sha256'].includes(flag) || value === undefined || values.has(flag)) fail('invalid or duplicate flag')
    values.set(flag, value)
  }
  const version = values.get('--version')
  const outputDir = values.get('--output-dir')
  if (!version || !outputDir) fail('--version and --output-dir are required')
  assertVersion(version)
  const sourceSha = values.get('--source-sha')
  const expectedPreimageSha256 = values.get('--expected-preimage-sha256')
  const expectedPayloadSha256 = values.get('--expected-payload-sha256')
  if (sourceSha && !SHA40.test(sourceSha)) fail('source SHA must be lower-case 40 hex')
  for (const value of [expectedPreimageSha256, expectedPayloadSha256]) {
    if (value && !SHA256.test(value)) fail('expected SHA-256 must be lower-case 64 hex')
  }
  if (operation === 'apply' && (!sourceSha || !expectedPreimageSha256 || !expectedPayloadSha256)) fail('apply requires source SHA and both expected SHA-256 values')
  return { operation, version, outputDir, sourceSha, expectedPreimageSha256, expectedPayloadSha256 }
}

export function stopPayload(version: string, sourceSha: string): Uint8Array {
  const body = `#!/bin/sh\nprintf '%s\\n' 'STOP: Legacy SLV bootstrap has moved to verified immutable releases.' >&2\nprintf '%s\\n' 'Release: v${version}' >&2\nprintf '%s\\n' 'Reviewed source commit: ${sourceSha}' >&2\nprintf '%s\\n' \"Download commit-pinned installer: curl --fail --show-error --silent --proto '=https' --tlsv1.2 --output ./slv-install-reviewed.sh 'https://raw.githubusercontent.com/ValidatorsDAO/slv/${sourceSha}/sh/install'\" >&2\nprintf '%s\\n' 'Inspect before execution: less ./slv-install-reviewed.sh' >&2\nprintf '%s\\n' 'After review explicit legacy target: sh ./slv-install-reviewed.sh --install-path /usr/local/bin/slv' >&2\nexit 1\n`
  return new TextEncoder().encode(body)
}

function secret(name: string): string {
  const value = Deno.env.get(name)
  if (!value) fail(`${name} is required`)
  return value
}
async function response(url: string, init: RequestInit, statuses: Statuses, label: string): Promise<Response> {
  const result = await fetch(url, { ...init, redirect: 'error' })
  statuses[label] = result.status
  if (!result.ok) fail(`${label} request failed (${result.status})`)
  return result
}
function cfHeaders(token: string): HeadersInit {
  return { authorization: `Bearer ${token}` }
}
async function ensureOutput(path: string): Promise<void> {
  try { await Deno.lstat(path); fail('output directory already exists') } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error
  }
  await Deno.mkdir(path, { recursive: false })
  const stat = await Deno.lstat(path)
  if (!stat.isDirectory || stat.isSymlink) fail('output directory is unsafe')
}
async function writeJson(path: string, value: unknown): Promise<void> {
  await Deno.writeTextFile(path, JSON.stringify(value, null, 2) + '\n')
}
async function readJson(response: Response, label: string): Promise<Record<string, unknown>> {
  const value = await response.json() as Record<string, unknown>
  if (value.success !== true) fail(`${label} response was unsuccessful`)
  return value
}
async function verifiedRelease(version: string, sourceSha: string, statuses: Statuses): Promise<void> {
  const release = await readJson(await response(`${GH}/repos/${repo}/releases/tags/v${version}`, { headers: { accept: 'application/vnd.github+json' } }, statuses, 'release'), 'release')
  if (release.immutable !== true || release.draft !== false || release.prerelease !== false) fail('release is not immutable published stable')
  const tag = await readJson(await response(`${GH}/repos/${repo}/git/ref/tags/v${version}`, { headers: { accept: 'application/vnd.github+json' } }, statuses, 'tag'), 'tag')
  const object = tag.object as Record<string, unknown> | undefined
  if (!object || typeof object.sha !== 'string' || (object.type !== 'commit' && object.type !== 'tag')) fail('unsupported tag object')
  let commit = object.sha
  if (object.type === 'tag') {
    const peeled = await readJson(await response(`${GH}/repos/${repo}/git/tags/${commit}`, { headers: { accept: 'application/vnd.github+json' } }, statuses, 'peeled_tag'), 'peeled tag')
    const target = peeled.object as Record<string, unknown> | undefined
    if (!target || target.type !== 'commit' || typeof target.sha !== 'string') fail('annotated tag does not peel to commit')
    commit = target.sha
  }
  if (commit !== sourceSha) fail('release tag does not bind the requested source SHA')
}

export async function run(args: string[]): Promise<void> {
  const options = parseArgs(args)
  await ensureOutput(options.outputDir)
  const statuses: Statuses = { domain: null, preimage: null, release: null, tag: null, peeled_tag: null, put: null, authenticated_readback: null, public_readback: null }
  const receipt: Record<string, unknown> = { operation: options.operation, version: options.version, source_sha: options.sourceSha ?? null, target: { account: 'redacted', bucket, key: objectKey, domain }, http_statuses: statuses, release_validated: false, put_attempted: false, put_succeeded: false, readback_state: 'not-started', race_limit: 'non-atomic: a concurrent writer may change the object after the fresh preimage GET and before/after this single PUT' }
  try {
    const account = secret(ACCOUNT)
    const token = secret(TOKEN)
    const base = `${CF}/accounts/${account}/r2/buckets/${bucket}`
    const mapping = await readJson(await response(`${base}/domains/custom/${domain}`, { headers: cfHeaders(token) }, statuses, 'domain'), 'custom domain')
    const mapped = mapping.result as Record<string, unknown> | undefined
    if (!mapped || mapped.domain !== domain || mapped.enabled !== true || mapped.status !== 'active') fail('custom domain is not the exact active enabled mapping')
    const preimage = new Uint8Array(await (await response(`${base}/objects/${objectKey}`, { headers: cfHeaders(token) }, statuses, 'preimage')).arrayBuffer())
    const preimageHash = sha256(preimage)
    receipt.preimage_sha256 = preimageHash
    await Deno.writeFile(`${options.outputDir}/authenticated-preimage.bin`, preimage)
    await writeJson(`${options.outputDir}/metadata.json`, { account: 'redacted', bucket, key: objectKey, domain, preimage_sha256: preimageHash })
    let payload: Uint8Array | undefined
    if (options.sourceSha) {
      payload = stopPayload(options.version, options.sourceSha)
      receipt.payload_sha256 = sha256(payload)
      await Deno.writeFile(`${options.outputDir}/candidate-install`, payload)
    }
    if (options.operation === 'preflight') { receipt.readback_state = 'preflight-only'; return }
    if (preimageHash !== options.expectedPreimageSha256 || sha256(payload!) !== options.expectedPayloadSha256) fail('expected hash did not match reviewed bytes')
    await verifiedRelease(options.version, options.sourceSha!, statuses)
    receipt.release_validated = true
    const fresh = new Uint8Array(await (await response(`${base}/objects/${objectKey}`, { headers: cfHeaders(token) }, statuses, 'preimage')).arrayBuffer())
    if (sha256(fresh) !== options.expectedPreimageSha256) fail('fresh preimage changed before write')
    receipt.put_attempted = true
    const put = await response(`${base}/objects/${objectKey}`, { method: 'PUT', headers: { ...cfHeaders(token), 'content-type': 'application/octet-stream' }, body: payload!.buffer as ArrayBuffer }, statuses, 'put')
    const putResult = await readJson(put, 'put')
    const result = putResult.result as Record<string, unknown> | undefined
    if (!result || result.key !== objectKey || result.size !== payload!.length) fail('PUT response did not bind expected key and size')
    receipt.put_succeeded = true
    const authenticated = new Uint8Array(await (await response(`${base}/objects/${objectKey}`, { headers: cfHeaders(token) }, statuses, 'authenticated_readback')).arrayBuffer())
    const publicBytes = new Uint8Array(await (await response(`https://${domain}/${objectKey}`, {}, statuses, 'public_readback')).arrayBuffer())
    if (sha256(authenticated) !== sha256(payload!) || sha256(publicBytes) !== sha256(payload!)) fail('post-write readback hash mismatch')
    receipt.readback_state = 'matched'
  } catch (error) {
    receipt.error = error instanceof Error ? error.message : 'operation failed'
    throw error
  } finally {
    await writeJson(`${options.outputDir}/receipt.json`, receipt)
  }
}

if (import.meta.main) {
  try { await run(Deno.args) } catch (error) { console.error(error instanceof Error ? error.message : 'legacy bootstrap failed'); Deno.exit(1) }
}
