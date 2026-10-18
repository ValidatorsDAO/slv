/** Install the exact reviewed compiler frontend, before it can build products. */
import { createHash } from 'node:crypto'
import { constants as fsConstants } from 'node:fs'
import { copyFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import {
  assertQualificationManifest,
  type QualificationManifest,
  readQualificationManifest,
} from './runtime-qualification.ts'
import { sha256 } from './source-materials.ts'

const SHA256 = /^[a-f0-9]{64}$/
export const FRONTEND_VERSION = '2.9.3'
export const FRONTEND_ZIP_MAX_BYTES = 64 * 1024 * 1024
const FRONTEND_BINARY_MAX_BYTES = 256 * 1024 * 1024
const DOWNLOAD_DEADLINE_MS = 120_000
const HOSTS = new Set([
  'github.com',
  'release-assets.githubusercontent.com',
  'objects.githubusercontent.com',
])
export type FrontendTarget =
  | 'x86_64-unknown-linux-gnu'
  | 'aarch64-unknown-linux-gnu'
export type FrontendPlan = {
  target: FrontendTarget
  version: typeof FRONTEND_VERSION
  url: string
  archive_sha256: string
  binary_sha256: string
  binary_size: number
}
export type FrontendTransport = {
  fetch?:
    typeof globalThis.fetch /** Tests/callers may shorten, never extend, the production deadline. */
  deadlineMs?: number
}
export type FrontendReceipt = {
  kind: 'slv-qualified-frontend'
  version: typeof FRONTEND_VERSION
  target: FrontendTarget
  archive_sha256: string
  executable_sha256: string
  executable_size: number
}
function fail(message: string): never {
  throw new Error(`qualified frontend: ${message}`)
}
function digest(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}
export function frontendTarget(os: string, arch: string): FrontendTarget {
  if (os !== 'linux' || !['x86_64', 'aarch64'].includes(arch)) {
    fail('requires a native Linux x64 or ARM64 host')
  }
  return `${arch}-unknown-linux-gnu` as FrontendTarget
}
/** The transport and executable are independently bound by reviewed input bytes. */
export function frontendPlan(
  manifest: QualificationManifest,
  toolPinBytes: Uint8Array,
  target: FrontendTarget,
): FrontendPlan {
  assertQualificationManifest(manifest)
  if (
    manifest.compatibility.deno_version !== FRONTEND_VERSION ||
    !['x86_64-unknown-linux-gnu', 'aarch64-unknown-linux-gnu'].includes(target)
  ) fail('unsupported reviewed frontend target/version')
  const pinHash = digest(toolPinBytes)
  if (
    pinHash !==
      manifest.compatibility
        .runtime_inputs['source-rebuild/tool-prereqs.json'] ||
    pinHash !== manifest.assets[manifest.source.tool_prereqs].sha256
  ) fail('tool prerequisites differ from qualification')
  let pins: any
  try {
    pins = JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(toolPinBytes),
    )
  } catch {
    return fail('invalid tool prerequisite JSON')
  }
  const entry = pins?.targets?.[target]
  const tools = target === 'aarch64-unknown-linux-gnu'
    ? entry?.execution?.tools
    : entry?.tools
  const selected = Array.isArray(tools)
    ? tools.filter((tool: any) => tool?.name === 'deno')
    : []
  if (selected.length !== 1) {
    fail('tool prerequisites do not select one frontend')
  }
  const tool = selected[0], binary = manifest.compatibility.frontend[target]
  const url =
    `https://github.com/denoland/deno/releases/download/v${FRONTEND_VERSION}/deno-${target}.zip`
  if (
    tool.version !== FRONTEND_VERSION || tool.url !== url ||
    tool.format !== 'zip' || tool.strip_components !== 0 ||
    !SHA256.test(tool.sha256) || !Array.isArray(tool.identities) ||
    tool.identities.length !== 1 || tool.identities[0].path !== 'deno' ||
    tool.identities[0].sha256 !== binary.sha256
  ) fail('frontend transport/executable pins differ')
  const plan: FrontendPlan = {
    target,
    version: FRONTEND_VERSION,
    url,
    archive_sha256: tool.sha256,
    binary_sha256: binary.sha256,
    binary_size: binary.size,
  }
  validatePlan(plan)
  return plan
}
function validatePlan(plan: FrontendPlan): void {
  if (
    plan.version !== FRONTEND_VERSION ||
    !['x86_64-unknown-linux-gnu', 'aarch64-unknown-linux-gnu'].includes(
      plan.target,
    ) ||
    plan.url !==
      `https://github.com/denoland/deno/releases/download/v${FRONTEND_VERSION}/deno-${plan.target}.zip` ||
    !SHA256.test(plan.archive_sha256) || !SHA256.test(plan.binary_sha256) ||
    !Number.isSafeInteger(plan.binary_size) || plan.binary_size <= 0 ||
    plan.binary_size > FRONTEND_BINARY_MAX_BYTES
  ) fail('invalid frontend plan')
}
function publicDownloadUrl(url: string): void {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return fail('invalid frontend download URL')
  }
  if (
    parsed.protocol !== 'https:' || !HOSTS.has(parsed.hostname) ||
    parsed.port || parsed.username || parsed.password || parsed.hash
  ) fail('frontend redirect left approved public HTTPS hosts')
}
export async function downloadFrontend(
  plan: FrontendPlan,
  destination: string,
  transport: FrontendTransport = {},
): Promise<void> {
  validatePlan(plan)
  const deadlineMs = transport.deadlineMs ?? DOWNLOAD_DEADLINE_MS
  if (
    !Number.isSafeInteger(deadlineMs) || deadlineMs <= 0 ||
    deadlineMs > DOWNLOAD_DEADLINE_MS
  ) fail('invalid download deadline')
  const controller = new AbortController(),
    fetchPublic = transport.fetch ?? globalThis.fetch
  let response: Response | undefined,
    reader: ReadableStreamDefaultReader<Uint8Array> | undefined,
    file: Deno.FsFile | undefined
  let rejectDeadline: (reason: Error) => void = () => {}
  const deadline = new Promise<never>((_, reject) => {
    rejectDeadline = reject
  })
  const timer = setTimeout(() => {
    controller.abort()
    void reader?.cancel().catch(() => {})
    void response?.body?.cancel().catch(() => {})
    rejectDeadline(new Error('qualified frontend: download timed out'))
  }, deadlineMs)
  const acquire = async () => {
    let url = plan.url
    for (let redirects = 0; redirects <= 3; redirects++) {
      publicDownloadUrl(url)
      response = await fetchPublic(url, {
        method: 'GET',
        redirect: 'manual',
        credentials: 'omit',
        cache: 'no-store',
        headers: { Accept: 'application/octet-stream' },
        signal: controller.signal,
      })
      if (controller.signal.aborted) {
        void response.body?.cancel().catch(() => {})
        fail('download timed out')
      }
      if (response.redirected || (response.url && response.url !== url)) {
        fail('unexpected automatic redirect')
      }
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get('location')
        void response.body?.cancel().catch(() => {})
        if (!location || redirects === 3) {
          fail('invalid frontend redirect chain')
        }
        url = new URL(location, url).href
        publicDownloadUrl(url)
        continue
      }
      if (response.status !== 200 || !response.body) {
        fail('frontend download did not return HTTP 200')
      }
      const length = response.headers.get('content-length')
      if (
        length !== null &&
        (!/^[0-9]+$/.test(length) || Number(length) > FRONTEND_ZIP_MAX_BYTES)
      ) fail('frontend ZIP exceeds size bound')
      file = await Deno.open(destination, {
        createNew: true,
        write: true,
        mode: 0o600,
      })
      try {
        if (controller.signal.aborted) fail('download timed out')
        reader = response.body.getReader()
        const hash = createHash('sha256')
        let bytes = 0
        for (;;) {
          const part = await reader.read()
          if (controller.signal.aborted) fail('download timed out')
          if (part.done) break
          bytes += part.value.length
          if (bytes > FRONTEND_ZIP_MAX_BYTES) {
            fail('frontend ZIP exceeds size bound')
          }
          hash.update(part.value)
          let offset = 0
          while (offset < part.value.length) {
            offset += await file.write(part.value.subarray(offset))
          }
        }
        if (bytes === 0 || hash.digest('hex') !== plan.archive_sha256) {
          fail('frontend ZIP digest differs from reviewed transport')
        }
        return
      } finally {
        try {
          file?.close()
        } catch { /* cancelled/closed */ }
        file = undefined
      }
    }
    fail('frontend redirect bound exceeded')
  }
  try {
    await Promise.race([acquire(), deadline])
  } catch (error) {
    if (
      error instanceof Error && error.message.startsWith('qualified frontend:')
    ) throw error
    fail('frontend download failed')
  } finally {
    clearTimeout(timer)
    controller.abort()
    void reader?.cancel().catch(() => {})
    try {
      reader?.releaseLock()
    } catch { /* closed */ }
    void response?.body?.cancel().catch(() => {})
    try {
      file?.close()
    } catch { /* cancelled/closed */ }
  }
}
/** This validates data only; no downloaded program is executed. */
export async function extractVerifiedFrontend(
  archive: string,
  destination: string,
  plan: FrontendPlan,
): Promise<void> {
  validatePlan(plan)
  const info = await Deno.lstat(archive)
  if (
    !info.isFile || info.isSymlink || info.size <= 0 ||
    info.size > FRONTEND_ZIP_MAX_BYTES ||
    await sha256(archive) !== plan.archive_sha256
  ) fail('frontend ZIP digest/size differs')
  const script = String.raw`
import os,stat,sys,zipfile
archive,destination,expected=sys.argv[1:]
expected=int(expected)
with zipfile.ZipFile(archive) as z:
 rows=z.infolist()
 if len(rows)!=1: raise ValueError('frontend ZIP must contain exactly one file')
 row=rows[0];mode=row.external_attr>>16
 if row.filename!='deno' or row.is_dir() or row.header_offset!=0 or stat.S_IFMT(mode) not in (0,stat.S_IFREG) or row.external_attr&0x10 or row.flag_bits&1 or row.compress_type not in (0,8): raise ValueError('unsafe frontend ZIP member')
 if row.file_size!=expected: raise ValueError('frontend executable size differs')
 with z.open(row) as src:
  fd=os.open(destination,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
  with os.fdopen(fd,'wb') as out:
   total=0
   while True:
    chunk=src.read(1024*1024)
    if not chunk:break
    total+=len(chunk)
    if total>expected:raise ValueError('frontend expansion exceeds reviewed size')
    out.write(chunk)
   if total!=expected:raise ValueError('frontend executable is truncated')
`
  const result = await new Deno.Command('python3', {
    args: ['-c', script, archive, destination, String(plan.binary_size)],
    clearEnv: true,
    env: { PATH: '/usr/local/bin:/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' },
    stdin: 'null',
    stdout: 'null',
    stderr: 'piped',
    signal: AbortSignal.timeout(30_000),
  }).output()
  if (!result.success) fail('unsafe or mismatched frontend ZIP')
  const extracted = await Deno.lstat(destination)
  if (
    !extracted.isFile || extracted.isSymlink ||
    extracted.size !== plan.binary_size ||
    await sha256(destination) !== plan.binary_sha256
  ) fail('frontend executable bytes differ from qualification')
}
export async function prepareFrontend(
  options: { manifestPath: string; outputDirectory: string },
  transport: FrontendTransport = {},
): Promise<FrontendReceipt> {
  const target = frontendTarget(Deno.build.os, Deno.build.arch)
  const manifest = await readQualificationManifest(options.manifestPath)
  const toolPins = await Deno.readFile(
    new URL('../../source-rebuild/tool-prereqs.json', import.meta.url),
  )
  const plan = frontendPlan(manifest, toolPins, target)
  return await prepareFrontendPlan(plan, options.outputDirectory, transport)
}
/** Explicit plan seam permits offline transport tests; the CLI always derives reviewed pins. */
export async function prepareFrontendPlan(
  plan: FrontendPlan,
  outputDirectory: string,
  transport: FrontendTransport = {},
): Promise<FrontendReceipt> {
  validatePlan(plan)
  const output = resolve(outputDirectory)
  try {
    await Deno.lstat(output)
    fail('frontend output already exists')
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error
  }
  const scratch = await Deno.realPath(
    await Deno.makeTempDir({ dir: dirname(output), prefix: '.slv-frontend-' }),
  )
  let createdOutput = false
  try {
    const archive = join(scratch, 'frontend.zip'),
      binary = join(scratch, 'deno-unverified')
    await downloadFrontend(plan, archive, transport)
    await extractVerifiedFrontend(archive, binary, plan)
    await Deno.mkdir(output, { mode: 0o700 })
    createdOutput = true
    const executable = join(output, 'deno')
    await copyFile(binary, executable, fsConstants.COPYFILE_EXCL)
    if (
      (await Deno.stat(executable)).size !== plan.binary_size ||
      await sha256(executable) !== plan.binary_sha256
    ) fail('installed frontend bytes differ')
    await Deno.chmod(executable, 0o755)
    return {
      kind: 'slv-qualified-frontend',
      version: plan.version,
      target: plan.target,
      archive_sha256: plan.archive_sha256,
      executable_sha256: plan.binary_sha256,
      executable_size: plan.binary_size,
    }
  } catch (error) {
    if (createdOutput) await Deno.remove(output, { recursive: true })
    throw error
  } finally {
    await Deno.remove(scratch, { recursive: true })
  }
}
if (import.meta.main) {
  if (Deno.args.length !== 2) {
    fail('usage: prepare-frontend.ts MANIFEST OUTPUT_DIR')
  }
  const receipt = await prepareFrontend({
    manifestPath: Deno.args[0],
    outputDirectory: Deno.args[1],
  })
  console.log(JSON.stringify(receipt))
}
