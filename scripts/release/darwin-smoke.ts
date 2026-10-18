/** One-time native execution of exact Linux-built Darwin validation artifacts. */
import { createHash } from 'node:crypto'
import { join, resolve } from 'node:path'
import {
  type CurrentProductReceipt,
  embeddingRecipeSha256,
  inspectMachO,
  parseCurrentProductReceipt,
} from './build-product.ts'
import {
  canonicalReceipt,
  executableBytesFromArchive,
  hashFile,
  reviewedSourceVersion,
} from './release.ts'
import {
  qualificationIdentity,
  readQualificationManifest,
} from './runtime-qualification.ts'
import {
  checkReviewedRuntimeRevocation,
  verifyRuntimeRevocationBinding,
} from './runtime-revocations.ts'

const REPOSITORY = 'ValidatorsDAO/slv'
const WORKFLOW = '.github/workflows/slv-remote-build.yml'
const HASH = /^[a-f0-9]{64}$/
const SHA = /^[a-f0-9]{40}$/
const ID = /^[1-9]\d*$/
const decoder = new TextDecoder('utf-8', { fatal: true })
const encoder = new TextEncoder()
const MAX_ZIP = 768 * 1024 * 1024
const MAX_NOTICE = 32 * 1024 * 1024
const hash = (bytes: Uint8Array | string) =>
  createHash('sha256').update(bytes).digest('hex')
export class SmokeError extends Error {
  constructor(readonly code: string) {
    super(code)
  }
}
function fail(code: string): never {
  throw new SmokeError(code)
}
function fields(value: unknown, names: string[]): Record<string, any> {
  if (
    !value || typeof value !== 'object' || Array.isArray(value) ||
    Object.keys(value).sort().join('\0') !== [...names].sort().join('\0')
  ) fail('invalid-fields')
  return value as Record<string, any>
}
export type DarwinTarget = 'x86_64-apple-darwin' | 'aarch64-apple-darwin'
export type SmokeInput = {
  target: DarwinTarget
  source_sha: string
  workflow_sha: string
  ref: string
  run_id: string
  run_attempt: string
  reviewed_sha: string
  title: string
  qualification_identity: string
  product: {
    artifact_id: string
    artifact_sha256: string
    receipt_sha256: string
    producer_attempt: string
  }
  notices: {
    artifact_id: string
    artifact_sha256: string
    producer_attempt: string
    sha256: string
  }
}
export function parseSmokeInput(value: unknown): SmokeInput {
  const v = fields(value, [
    'target',
    'source_sha',
    'workflow_sha',
    'ref',
    'run_id',
    'run_attempt',
    'reviewed_sha',
    'title',
    'qualification_identity',
    'product',
    'notices',
  ])
  fields(v.product, [
    'artifact_id',
    'artifact_sha256',
    'receipt_sha256',
    'producer_attempt',
  ])
  fields(v.notices, [
    'artifact_id',
    'artifact_sha256',
    'producer_attempt',
    'sha256',
  ])
  if (
    !['x86_64-apple-darwin', 'aarch64-apple-darwin'].includes(v.target) ||
    !SHA.test(v.source_sha) || v.workflow_sha !== v.source_sha ||
    v.reviewed_sha !== v.source_sha ||
    !/^refs\/heads\/[A-Za-z0-9._/-]+$/.test(v.ref) || v.ref.includes('..') ||
    v.title !== `SLV release build validation ${v.reviewed_sha}` ||
    !HASH.test(v.qualification_identity)
  ) fail('invalid-validation-identity')
  for (
    const id of [
      v.run_id,
      v.run_attempt,
      v.product.artifact_id,
      v.notices.artifact_id,
      v.product.producer_attempt,
      v.notices.producer_attempt,
    ]
  ) {
    if (
      typeof id !== 'string' || !ID.test(id) ||
      !Number.isSafeInteger(Number(id))
    ) fail('invalid-id')
  }
  for (
    const digest of [
      v.product.artifact_sha256,
      v.product.receipt_sha256,
      v.notices.artifact_sha256,
      v.notices.sha256,
    ]
  ) if (typeof digest !== 'string' || !HASH.test(digest)) fail('invalid-digest')
  if (
    v.product.producer_attempt !== v.run_attempt ||
    v.notices.producer_attempt !== v.run_attempt ||
    v.product.artifact_id === v.notices.artifact_id
  ) fail('stale-producer-attempt')
  return v as SmokeInput
}
export function assertSmokeContext(
  input: SmokeInput,
  env: (name: string) => string | undefined,
): void {
  const expected: Record<string, string> = {
    GITHUB_REPOSITORY: REPOSITORY,
    GITHUB_EVENT_NAME: 'workflow_dispatch',
    GITHUB_SHA: input.source_sha,
    GITHUB_WORKFLOW_SHA: input.workflow_sha,
    GITHUB_REF: input.ref,
    GITHUB_WORKFLOW_REF: `${REPOSITORY}/${WORKFLOW}@${input.ref}`,
    GITHUB_RUN_ID: input.run_id,
    GITHUB_RUN_ATTEMPT: input.run_attempt,
    GITHUB_JOB: `validation-smoke-${input.target}`,
    SLV_OPERATION: 'release-build-validation',
    SLV_RESOLVED_MODE: 'release-build-validation',
    SLV_PUBLICATION: 'none',
    SLV_RESOLVED_SOURCE_SHA: input.source_sha,
  }
  if (Object.entries(expected).some(([key, value]) => env(key) !== value)) {
    fail('validation-context-mismatch')
  }
  for (
    const name of [
      'ACTIONS_ID_TOKEN_REQUEST_TOKEN',
      'ACTIONS_ID_TOKEN_REQUEST_URL',
      'SLV_R2_CREDENTIALS_JSON',
      'AWS_ACCESS_KEY_ID',
      'AWS_SECRET_ACCESS_KEY',
      'GOOGLE_APPLICATION_CREDENTIALS',
    ]
  ) if (env(name)) fail('publisher-environment-present')
}

async function regular(path: string, maximum: number): Promise<Deno.FileInfo> {
  const info = await Deno.lstat(path).catch(() => fail('missing-file'))
  if (!info.isFile || info.isSymlink || info.size < 1 || info.size > maximum) {
    fail('invalid-file')
  }
  return info
}
async function json(path: string, maximum = 1024 * 1024): Promise<any> {
  await regular(path, maximum)
  try {
    return JSON.parse(await Deno.readTextFile(path))
  } catch {
    return fail('invalid-json')
  }
}
async function privateDirectory(path: string, create = false): Promise<string> {
  if (create) await Deno.mkdir(path, { mode: 0o700 })
  const info = await Deno.lstat(path)
  if (
    !info.isDirectory || info.isSymlink || info.mode === null ||
    (info.mode & 0o077) !== 0
  ) fail('unsafe-work-directory')
  return await Deno.realPath(path)
}

async function trusted(
  program: string,
  args: string[],
  options: {
    cwd?: string
    input?: string
    maximum?: number
    timeout?: number
  } = {},
): Promise<Uint8Array> {
  const child = new Deno.Command(program, {
    args,
    cwd: options.cwd,
    stdin: options.input ? 'piped' : 'null',
    stdout: 'piped',
    stderr: 'null',
  }).spawn()
  const chunks: Uint8Array[] = []
  let length = 0, timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    try {
      child.kill('SIGKILL')
    } catch { /* exited */ }
  }, options.timeout ?? 60_000)
  try {
    if (options.input) {
      const writer = child.stdin.getWriter()
      await writer.write(encoder.encode(options.input))
      await writer.close()
    }
    for await (const chunk of child.stdout) {
      length += chunk.length
      if (length > (options.maximum ?? 8 * 1024 * 1024)) {
        try {
          child.kill('SIGKILL')
        } catch { /* exited */ }
        fail('trusted-command-output-bound')
      }
      chunks.push(chunk)
    }
    if (!(await child.status).success || timedOut) {
      fail(timedOut ? 'trusted-command-timeout' : 'trusted-command-failed')
    }
    const bytes = new Uint8Array(length)
    let offset = 0
    for (const chunk of chunks) {
      bytes.set(chunk, offset)
      offset += chunk.length
    }
    return bytes
  } finally {
    clearTimeout(timer)
    await child.status.catch(() => undefined)
  }
}

export interface SmokeGitHub {
  run(id: string, attempt: string): Promise<any>
  jobs(id: string, attempt: string): Promise<any>
  artifact(id: string): Promise<any>
  download(id: string, destination: string, maximum: number): Promise<void>
}
export function smokeGitHub(): SmokeGitHub {
  const api = async (suffix: string) =>
    JSON.parse(
      decoder.decode(
        await trusted('gh', ['api', `repos/${REPOSITORY}/${suffix}`]),
      ),
    )
  return {
    run: (id, attempt) => api(`actions/runs/${id}/attempts/${attempt}`),
    jobs: (id, attempt) =>
      api(`actions/runs/${id}/attempts/${attempt}/jobs?per_page=100`),
    artifact: (id) => api(`actions/artifacts/${id}`),
    async download(id, destination, maximum) {
      const file = await Deno.open(destination, {
        createNew: true,
        write: true,
        mode: 0o600,
      })
      const child = new Deno.Command('gh', {
        args: ['api', `repos/${REPOSITORY}/actions/artifacts/${id}/zip`],
        stdout: 'piped',
        stderr: 'null',
      }).spawn()
      let length = 0
      const timer = setTimeout(() => {
        try {
          child.kill('SIGKILL')
        } catch { /* exited */ }
      }, 120_000)
      try {
        for await (const chunk of child.stdout) {
          length += chunk.length
          if (length > maximum) {
            try {
              child.kill('SIGKILL')
            } catch { /* exited */ }
            fail('artifact-size-bound')
          }
          let offset = 0
          while (offset < chunk.length) {
            offset += await file.write(chunk.subarray(offset))
          }
        }
        if (!(await child.status).success) fail('artifact-download-failed')
      } finally {
        clearTimeout(timer)
        file.close()
        await child.status.catch(() => undefined)
      }
    },
  }
}
export function verifySmokeProvenance(
  input: SmokeInput,
  run: any,
  jobs: any,
  product: any,
  notices: any,
  now = Date.now(),
): void {
  if (
    run?.id !== Number(input.run_id) ||
    run.run_attempt !== Number(input.run_attempt) ||
    run.event !== 'workflow_dispatch' || run.head_sha !== input.source_sha ||
    run.head_branch !== input.ref.slice('refs/heads/'.length) ||
    run.path !== WORKFLOW || run.display_title !== input.title ||
    run.repository?.full_name !== REPOSITORY ||
    run.head_repository?.full_name !== REPOSITORY ||
    !Number.isSafeInteger(run.repository?.id) ||
    !['in_progress', 'completed'].includes(run.status)
  ) fail('run-provenance-mismatch')
  if (
    !Array.isArray(jobs?.jobs) || jobs.total_count !== jobs.jobs.length ||
    jobs.total_count >= 100
  ) fail('incomplete-job-inventory')
  for (
    const name of [
      'resolve',
      'runtime-qualification',
      'test',
      `build-${input.target}`,
    ]
  ) {
    const matches = jobs.jobs.filter((job: any) => job.name === name)
    if (
      matches.length !== 1 || matches[0].run_id !== Number(input.run_id) ||
      matches[0].run_attempt !== Number(input.run_attempt) ||
      matches[0].head_sha !== input.source_sha ||
      matches[0].status !== 'completed' || matches[0].conclusion !== 'success'
    ) fail('producer-job-mismatch')
  }
  const smoke = jobs.jobs.filter((job: any) =>
    job.name === `validation-smoke-${input.target}`
  )
  if (
    smoke.length !== 1 || smoke[0].run_id !== Number(input.run_id) ||
    smoke[0].run_attempt !== Number(input.run_attempt) ||
    smoke[0].head_sha !== input.source_sha ||
    !['in_progress', 'completed'].includes(smoke[0].status)
  ) fail('smoke-job-mismatch')
  for (
    const [artifact, expected, name, maximum] of [
      [
        product,
        input.product,
        `slv-product-${input.target}-${input.run_id}-${input.run_attempt}`,
        MAX_ZIP,
      ],
      [
        notices,
        input.notices,
        `slv-license-evidence-${input.run_id}-${input.run_attempt}`,
        MAX_NOTICE,
      ],
    ] as const
  ) {
    if (
      artifact?.id !== Number(expected.artifact_id) || artifact.name !== name ||
      artifact.expired !== false ||
      !Number.isFinite(Date.parse(artifact.expires_at)) ||
      Date.parse(artifact.expires_at) <= now ||
      artifact.digest !== `sha256:${expected.artifact_sha256}` ||
      !Number.isSafeInteger(artifact.size_in_bytes) ||
      artifact.size_in_bytes < 1 || artifact.size_in_bytes > maximum ||
      artifact.workflow_run?.id !== Number(input.run_id) ||
      artifact.workflow_run?.head_sha !== input.source_sha ||
      artifact.workflow_run?.repository_id !== run.repository.id ||
      artifact.workflow_run?.head_repository_id !== run.repository.id
    ) fail('artifact-provenance-mismatch')
  }
}

export function productMembers(target: DarwinTarget): Record<string, string> {
  const prefix = `release-inputs/product-runtime/${target}`
  return {
    [`slv-${target}-exe.tar.gz`]: 'product.tar.gz',
    [`${prefix}/product-runtime-receipt.json`]: 'product-runtime-receipt.json',
    [`${prefix}/product-verification.json`]: 'product-verification.json',
    [`${prefix}/release-bridge-smoke`]: 'bridge',
  }
}
/** Check every namespace entry before writing selected regular files. */
export async function extractSmokeZip(
  path: string,
  destination: string,
  members: Record<string, string>,
  maximum: number,
): Promise<void> {
  const script = String.raw`
import json,os,stat,sys,zipfile,shutil
wanted=json.load(sys.stdin); total=0; seen=set(); regular=set(); directories=set()
with zipfile.ZipFile(sys.argv[1]) as z:
 for i in z.infolist():
  name=i.filename[:-1] if i.is_dir() else i.filename
  if not name or name.startswith('/') or '\\' in name or '\x00' in name or any(p in ('','.','..') for p in name.split('/')) or name in seen: raise ValueError('namespace')
  seen.add(name); mode=i.external_attr>>16; kind=stat.S_IFMT(mode)
  if i.flag_bits&1 or kind not in (0,stat.S_IFREG,stat.S_IFDIR): raise ValueError('type')
  if i.is_dir():
   if kind not in (0,stat.S_IFDIR) or i.file_size: raise ValueError('directory')
   directories.add(name)
  else:
   if kind not in (0,stat.S_IFREG) or i.file_size<1: raise ValueError('regular')
   regular.add(name); total+=i.file_size
  if total>int(sys.argv[3]): raise ValueError('size')
 if regular!=set(wanted): raise ValueError('inventory')
 if any(not any(n.startswith(d+'/') for n in regular) for d in directories): raise ValueError('extra-directory')
 for n in seen:
  if any('/'.join(n.split('/')[:k]) in regular for k in range(1,len(n.split('/')))): raise ValueError('collision')
 for name,out in wanted.items():
  if '/' in out or '\\' in out or out in ('','.','..'): raise ValueError('destination')
  target=os.path.join(sys.argv[2],out)
  with z.open(name) as source,open(target,'xb') as output: shutil.copyfileobj(source,output,1024*1024)
  os.chmod(target,0o600)
`
  await trusted('/usr/bin/python3', [
    '-I',
    '-c',
    script,
    path,
    destination,
    String(maximum),
  ], { input: JSON.stringify(members), timeout: 120_000 })
}

export async function verifySmokeFiles(
  input: SmokeInput,
  root: string,
  work: string,
): Promise<CurrentProductReceipt> {
  for (
    const [name, expected, maximum] of [
      ['product.zip', input.product.artifact_sha256, MAX_ZIP],
      ['notices.zip', input.notices.artifact_sha256, MAX_NOTICE],
      [
        'product-runtime-receipt.json',
        input.product.receipt_sha256,
        1024 * 1024,
      ],
      ['THIRD_PARTY_NOTICES', input.notices.sha256, MAX_NOTICE],
    ] as const
  ) {
    await regular(join(work, name), maximum)
    if (await hashFile(join(work, name)) !== expected) {
      fail('artifact-bytes-mismatch')
    }
  }
  const receipt = parseCurrentProductReceipt(
    await json(join(work, 'product-runtime-receipt.json')),
  )
  const policy = await checkReviewedRuntimeRevocation(
    input.qualification_identity,
    root,
  )
  const descriptor = await readQualificationManifest(
    join(root, 'source-materials/runtime-qualification.json'),
    input.qualification_identity,
  )
  if (
    qualificationIdentity(descriptor) !== input.qualification_identity ||
    descriptor.compatibility.embedding_recipe_sha256 !== embeddingRecipeSha256()
  ) fail('qualification-descriptor-mismatch')
  for (
    const [path, expected] of Object.entries(
      descriptor.compatibility.runtime_inputs,
    )
  ) {
    if (await hashFile(join(root, path)) !== expected) {
      fail('qualification-runtime-input-mismatch')
    }
  }
  const row = descriptor.targets.find((row) => row.target === input.target)!
  const mappings = {
    baseline_denort_sha256: row.runtime,
    selected_lock_sha256: descriptor.source.selected_lock,
    derived_lock_sha256: row.derived_lock,
    native_proof_sha256: row.proof,
    build_receipt_sha256: row.build_receipt,
  }
  for (const [field, asset] of Object.entries(mappings)) {
    if (
      receipt.qualification[field as keyof typeof mappings] !==
        descriptor.assets[asset].sha256
    ) fail('qualification-target-mismatch')
  }
  if (
    receipt.target !== input.target ||
    receipt.source.commit !== input.source_sha ||
    receipt.source.ref !== input.ref ||
    receipt.producer.workflow_sha !== input.workflow_sha ||
    receipt.producer.run_id !== input.run_id ||
    receipt.producer.run_attempt !== input.run_attempt ||
    receipt.producer.job !== `build-${input.target}` ||
    receipt.producer.host_os !== 'linux' ||
    receipt.producer.host_arch !== 'x86_64' ||
    receipt.producer.profile !== 'linux-16' ||
    receipt.qualification.identity !== input.qualification_identity ||
    receipt.qualification.state !== 'candidate-validation' ||
    receipt.native_execution !== 'not_performed' ||
    receipt.frontend.sha256 !==
      descriptor.compatibility.frontend['x86_64-unknown-linux-gnu'].sha256
  ) fail('product-receipt-identity-mismatch')
  for (
    const [path, expected] of [['deno.lock', receipt.source.lock_sha256], [
      'cli/lib/release/engine.py',
      receipt.source.engine_sha256,
    ], [
      'cli/lib/release/compiled_bridge_smoke.ts',
      receipt.source.bridge_source_sha256,
    ]] as const
  ) {
    if (await hashFile(join(root, path)) !== expected) {
      fail('current-source-input-mismatch')
    }
  }
  const notice = fields(await json(join(work, 'license-bundle.json')), [
    'schema_version',
    'source_sha',
    'producer_run_id',
    'producer_run_attempt',
    'filename',
    'size',
    'sha256',
  ])
  if (
    notice.schema_version !== 1 || notice.source_sha !== input.source_sha ||
    notice.producer_run_id !== input.run_id ||
    notice.producer_run_attempt !== Number(input.run_attempt) ||
    notice.filename !== 'THIRD_PARTY_NOTICES' ||
    notice.sha256 !== input.notices.sha256 ||
    notice.sha256 !== receipt.source.notices_sha256 ||
    notice.size !==
      (await regular(join(work, 'THIRD_PARTY_NOTICES'), MAX_NOTICE)).size
  ) fail('notice-producer-mismatch')
  for (
    const [name, expected] of [
      ['product.tar.gz', receipt.output.archive_sha256],
      ['bridge', receipt.output.bridge_sha256],
      ['product-verification.json', receipt.output.verification_sha256],
    ] as const
  ) {
    await regular(
      join(work, name),
      name === 'product-verification.json' ? 1024 * 1024 : MAX_ZIP,
    )
    if (await hashFile(join(work, name)) !== expected) {
      fail('product-bytes-mismatch')
    }
  }
  await trusted('/usr/bin/python3', [
    '-I',
    '-c',
    "import gzip,sys\nn=0\nwith gzip.open(sys.argv[1],'rb') as f:\n while True:\n  b=f.read(1024*1024)\n  if not b:break\n  n+=len(b)\n  if n>384*1024*1024:raise ValueError('executable expansion bound')",
    join(work, 'product.tar.gz'),
  ], { timeout: 30_000 })
  const bytes = await executableBytesFromArchive(
    join(work, 'product.tar.gz'),
    `slv-${input.target}-exe`,
  )
  if (hash(bytes) !== receipt.output.executable_sha256) {
    fail('product-executable-mismatch')
  }
  const verification = {
    kind: 'slv-current-darwin-verification',
    executable: inspectMachO(bytes, input.target),
    bridge: inspectMachO(
      await Deno.readFile(join(work, 'bridge')),
      input.target,
    ),
    native_execution: 'not_performed',
  }
  const actual = await json(join(work, 'product-verification.json'))
  const runtimeRevocation = verifyRuntimeRevocationBinding(
    actual.runtime_revocation,
    {
      identity: input.qualification_identity,
      mode: 'candidate-validation',
      reviewedPolicySha256: policy.policy_sha256,
      sourceCommit: input.source_sha,
    },
  )
  if (
    canonicalReceipt({
      ...verification,
      runtime_revocation: runtimeRevocation,
    }) !== canonicalReceipt(actual)
  ) fail('product-static-verification-mismatch')
  const executable = join(work, 'executable')
  try {
    await regular(executable, MAX_ZIP)
    if (await hashFile(executable) !== receipt.output.executable_sha256) {
      fail('extracted-executable-mismatch')
    }
  } catch (error) {
    if (!(error instanceof SmokeError) || error.code !== 'missing-file') {
      throw error
    }
    await Deno.writeFile(executable, bytes, { createNew: true, mode: 0o600 })
  }
  return receipt
}

export type NativeHost = {
  os: 'darwin'
  architecture: 'x86_64' | 'arm64'
  process_architecture: string
  os_version: string
  os_build: string
  translated: false
  translation_probe: 'native' | 'unavailable-native-intel'
}
export function assertNativeHost(
  target: DarwinTarget,
  value: {
    os: string
    arch: string
    uname: string
    hardwareArm: string
    hardwareArmExit: number
    hardwareArmError: string
    translated: string
    translatedExit: number
    translatedError: string
    version: string
    build: string
  },
): NativeHost {
  const arm = target === 'aarch64-apple-darwin'
  const missing = (name: string, text: string, code: number, error: string) =>
    code === 1 && text === '' && error === `sysctl: unknown oid '${name}'`
  // Darwin registers hw.optional.arm64 only on ARM kernels. On native Intel,
  // accept that exact absence; permission and other probe errors remain fatal.
  // https://github.com/apple-oss-distributions/xnu/blob/xnu-11417.140.69/bsd/kern/kern_mib.c#L1075
  const hardwareMatches =
    (value.hardwareArmExit === 0 && value.hardwareArmError === '' &&
      value.hardwareArm === (arm ? '1' : '0')) ||
    (!arm && missing(
      'hw.optional.arm64',
      value.hardwareArm,
      value.hardwareArmExit,
      value.hardwareArmError,
    ))
  const untranslated =
    (value.translatedExit === 0 && value.translated === '0' &&
      value.translatedError === '') ||
    (!arm && missing(
      'sysctl.proc_translated',
      value.translated,
      value.translatedExit,
      value.translatedError,
    ))
  if (
    value.os !== 'darwin' || value.arch !== (arm ? 'aarch64' : 'x86_64') ||
    value.uname !== (arm ? 'arm64' : 'x86_64') ||
    !hardwareMatches || !untranslated ||
    !/^\d+\.\d+(?:\.\d+)?$/.test(value.version) ||
    !/^[0-9]{2}[A-Z][0-9]+[a-z]?$/.test(value.build)
  ) fail('native-host-mismatch')
  return {
    os: 'darwin',
    architecture: arm ? 'arm64' : 'x86_64',
    process_architecture: value.arch,
    os_version: value.version,
    os_build: value.build,
    translated: false,
    translation_probe: value.translatedExit === 0
      ? 'native'
      : 'unavailable-native-intel',
  }
}
export async function nativeHost(target: DarwinTarget): Promise<NativeHost> {
  const query = async (program: string, args: string[]) => {
    const output = await new Deno.Command(program, {
      args,
      clearEnv: true,
      env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', LANG: 'C', LC_ALL: 'C' },
      stdout: 'piped',
      stderr: 'piped',
      signal: AbortSignal.timeout(5_000),
    }).output()
    return {
      text: decoder.decode(output.stdout).trim(),
      error: decoder.decode(output.stderr).trim(),
      code: output.code,
    }
  }
  const [uname, hardwareArm, translated, version, build] = await Promise.all([
    query('/usr/bin/uname', ['-m']),
    query('/usr/sbin/sysctl', ['-n', 'hw.optional.arm64']),
    query('/usr/sbin/sysctl', ['-n', 'sysctl.proc_translated']),
    query('/usr/bin/sw_vers', ['-productVersion']),
    query('/usr/bin/sw_vers', ['-buildVersion']),
  ])
  if (
    [uname, version, build].some((result) => result.code !== 0 || result.error)
  ) {
    fail('native-host-probe-failed')
  }
  return assertNativeHost(target, {
    os: Deno.build.os,
    arch: Deno.build.arch,
    uname: uname.text,
    hardwareArm: hardwareArm.text,
    hardwareArmExit: hardwareArm.code,
    hardwareArmError: hardwareArm.error,
    translated: translated.text,
    translatedExit: translated.code,
    translatedError: translated.error,
    version: version.text,
    build: build.text,
  })
}

export function sandboxProfile(payload: string, scratch: string): string {
  if (
    ![payload, scratch].every((p) =>
      p.startsWith('/') && !/[\n\r\0]/.test(p)
    ) || payload === scratch
  ) fail('invalid-sandbox-path')
  const literal = (path: string) => JSON.stringify(path)
  return `(version 1)\n(deny default)\n(allow process*)\n(allow sysctl-read)\n(allow file-read* (literal "/") (subpath "/System") (subpath "/usr") (subpath "/bin") (subpath "/sbin") (subpath "/Library/Apple/System/Library") (subpath "/Library/Developer/CommandLineTools") (literal "/private/etc/localtime") (literal "/dev/null") (literal "/dev/random") (literal "/dev/urandom") (subpath ${
    literal(payload)
  }) (subpath ${literal(scratch)}))\n(allow file-write* (subpath ${
    literal(scratch)
  }) (literal "/dev/null"))\n`
}
export type SmokeCase = 'version' | 'help' | 'licenses' | 'bridge'
export type ExecutionResult = {
  exit_code: number
  timed_out: boolean
  duration_ms: number
  stdout: Uint8Array
  stderr: Uint8Array
}
export type SmokeExecutor = (
  request: {
    executable: string
    args: string[]
    profile: string
    cwd: string
    temporary: string
    timeout_ms: number
    maximum_output: number
  },
) => Promise<ExecutionResult>
export async function systemPython(): Promise<
  { executable: string; root: string }
> {
  const value = JSON.parse(
    decoder.decode(
      await trusted('/usr/bin/python3', [
        '-I',
        '-c',
        'import json,sys;print(json.dumps({"executable":sys.executable,"prefix":sys.base_prefix}))',
      ]),
    ),
  )
  if (
    typeof value.executable !== 'string' || typeof value.prefix !== 'string'
  ) fail('untrusted-system-python')
  const accepted =
    /^(\/Applications\/Xcode[^/]*\.app\/Contents\/Developer|\/Library\/Developer\/CommandLineTools)(?:\/|$)/
  const executable = await Deno.realPath(value.executable)
  const match = accepted.exec(executable)
  if (
    !match || !value.prefix.startsWith(match[1] + '/') ||
    /[\n\r\0]/.test(executable + value.prefix)
  ) fail('untrusted-system-python')
  return { executable, root: match[1] }
}
export async function sandboxExecutor(
  request: Parameters<SmokeExecutor>[0],
): Promise<ExecutionResult> {
  const preservedHome = Deno.env.get('HOME')
  if (!preservedHome) fail('runner-home-unavailable')
  const python = await systemPython()
  const env = {
    PATH: `${
      python.executable.slice(0, python.executable.lastIndexOf('/'))
    }:/usr/bin:/bin:/usr/sbin:/sbin`,
    HOME: preservedHome,
    TMPDIR: `${request.temporary}/`,
    XDG_CONFIG_HOME: `${request.temporary}/config`,
    XDG_CACHE_HOME: `${request.temporary}/cache`,
    DENO_DIR: `${request.temporary}/deno`,
    NO_COLOR: '1',
    TERM: 'dumb',
    LANG: 'C',
    LC_ALL: 'C',
    TZ: 'UTC',
  }
  const ancestors = python.root.split('/').filter(Boolean).map((
    _,
    index,
    parts,
  ) => '/' + parts.slice(0, index + 1).join('/'))
  const profile = request.profile +
    `\n(allow file-read* (subpath ${
      JSON.stringify(python.root)
    }))\n(allow file-read-metadata ${
      ancestors.map((path) => `(literal ${JSON.stringify(path)})`).join(' ')
    })\n`
  // The supervisor stays outside the sandbox; its only child is sandbox-exec.
  // Every child process group is killed after each case, including orphaned
  // descendants after normal exit. No caller credentials reach that group.
  const script = String.raw`
import base64,json,os,selectors,signal,subprocess,sys,time
r=json.load(sys.stdin); started=time.monotonic(); out=[bytearray(),bytearray()]; timed=False; overflow=False
p=subprocess.Popen(['/usr/bin/sandbox-exec','-p',r['profile'],r['executable'],*r['args']],cwd=r['cwd'],env=r['env'],stdin=subprocess.DEVNULL,stdout=subprocess.PIPE,stderr=subprocess.PIPE,start_new_session=True)
s=selectors.DefaultSelector();s.register(p.stdout,selectors.EVENT_READ,0);s.register(p.stderr,selectors.EVENT_READ,1)
try:
 while s.get_map():
  if time.monotonic()-started>r['timeout_ms']/1000: timed=True;break
  for key,_ in s.select(0.05):
   chunk=os.read(key.fileobj.fileno(),65536)
   if not chunk:s.unregister(key.fileobj);continue
   out[key.data].extend(chunk)
   if sum(map(len,out))>r['maximum_output']:overflow=True;break
  if overflow:break
finally:
 try:os.killpg(p.pid,signal.SIGTERM)
 except (ProcessLookupError,PermissionError):
  if p.poll() is None:raise
 try:p.wait(timeout=0.2)
 except subprocess.TimeoutExpired:pass
 try:os.killpg(p.pid,signal.SIGKILL)
 except (ProcessLookupError,PermissionError):
  if p.poll() is None:raise
 p.wait();s.close();p.stdout.close();p.stderr.close()
if overflow:raise ValueError('output bound')
print(json.dumps({'exit_code':p.returncode,'timed_out':timed,'duration_ms':int((time.monotonic()-started)*1000),'stdout':base64.b64encode(out[0]).decode(),'stderr':base64.b64encode(out[1]).decode()}))
`
  const result = JSON.parse(
    decoder.decode(
      await trusted('/usr/bin/python3', ['-I', '-c', script], {
        input: JSON.stringify({ ...request, profile, env }),
        timeout: request.timeout_ms + 5_000,
        maximum: Math.ceil(request.maximum_output * 1.4) + 4096,
      }),
    ),
  )
  const bytes = (value: string) =>
    Uint8Array.from(atob(value), (character) => character.charCodeAt(0))
  return {
    ...result,
    stdout: bytes(result.stdout),
    stderr: bytes(result.stderr),
  }
}

export function verifySmokeOutput(
  name: SmokeCase,
  result: ExecutionResult,
  version: string,
  notices: Uint8Array,
): void {
  if (
    result.timed_out || result.exit_code !== 0 ||
    !Number.isInteger(result.duration_ms) || result.duration_ms < 0 ||
    result.duration_ms > 31_000 || result.stderr.length
  ) fail(result.timed_out ? 'execution-timeout' : 'execution-failed')
  const output = decoder.decode(result.stdout)
  if (name === 'version' && output !== `slv ${version}\n`) {
    fail('version-output-mismatch')
  }
  if (
    name === 'help' &&
    (!output.includes('slv is a Toolkit for Solana Developers') ||
      !/Usage:\s+slv\b/.test(output) || !output.includes('licenses'))
  ) fail('help-output-mismatch')
  if (name === 'licenses' && hash(result.stdout) !== hash(notices)) {
    fail('licenses-output-mismatch')
  }
  if (
    name === 'bridge' && output !== 'release bridge smoke passed (compiled)\n'
  ) fail('bridge-output-mismatch')
}

type Receipt = Record<string, any>
function initialReceipt(input: SmokeInput): Receipt {
  return {
    schema_version: 1,
    kind: 'slv-darwin-validation-smoke',
    publication: 'none',
    target: input.target,
    source: { commit: input.source_sha, ref: input.ref },
    workflow: {
      repository: REPOSITORY,
      path: WORKFLOW,
      sha: input.workflow_sha,
      run_id: input.run_id,
      run_attempt: input.run_attempt,
      smoke_job: `validation-smoke-${input.target}`,
      producer_job: `build-${input.target}`,
    },
    qualification: {
      identity: input.qualification_identity,
      state: 'candidate-validation',
    },
    artifacts: { product: input.product, notices: input.notices },
    status: 'incomplete',
    stage: 'acquire',
    started_at: new Date().toISOString(),
    cases: [],
  }
}
async function writeReceipt(path: string, receipt: Receipt): Promise<void> {
  await Deno.writeTextFile(path, JSON.stringify(receipt, null, 2) + '\n', {
    mode: 0o600,
  })
}
export async function acquireSmoke(
  input: SmokeInput,
  root: string,
  workPath: string,
  receiptPath: string,
  github: SmokeGitHub = smokeGitHub(),
): Promise<void> {
  const receipt = initialReceipt(input)
  try {
    assertSmokeContext(input, Deno.env.get)
    const checkout = decoder.decode(
      await trusted('git', ['rev-parse', 'HEAD'], { cwd: root }),
    ).trim()
    if (checkout !== input.source_sha) fail('checkout-mismatch')
    await trusted('git', ['diff', '--quiet', 'HEAD', '--'], { cwd: root })
    const work = await privateDirectory(workPath, true)
    const [run, jobs, product, notices] = await Promise.all([
      github.run(input.run_id, input.run_attempt),
      github.jobs(input.run_id, input.run_attempt),
      github.artifact(input.product.artifact_id),
      github.artifact(input.notices.artifact_id),
    ])
    verifySmokeProvenance(input, run, jobs, product, notices)
    const smokeJob = jobs.jobs.find((job: any) =>
      job.name === `validation-smoke-${input.target}`
    )
    if (
      [run.created_at, run.run_started_at, smokeJob.started_at].every((value) =>
        typeof value === 'string' && Number.isFinite(Date.parse(value))
      )
    ) {
      receipt.timing_context = {
        run_created_at: run.created_at,
        run_started_at: run.run_started_at,
        smoke_started_at: smokeJob.started_at,
        run_to_smoke_start_ms: Date.parse(smokeJob.started_at) -
          Date.parse(run.run_started_at),
      }
    }
    const downloadStarted = Date.now()
    await Promise.all([
      github.download(
        input.product.artifact_id,
        join(work, 'product.zip'),
        product.size_in_bytes,
      ),
      github.download(
        input.notices.artifact_id,
        join(work, 'notices.zip'),
        notices.size_in_bytes,
      ),
    ])
    for (
      const [name, expected, size] of [[
        'product.zip',
        input.product.artifact_sha256,
        product.size_in_bytes,
      ], [
        'notices.zip',
        input.notices.artifact_sha256,
        notices.size_in_bytes,
      ]] as const
    ) {
      if (
        (await regular(join(work, name), size)).size !== size ||
        await hashFile(join(work, name)) !== expected
      ) fail('download-digest-mismatch')
    }
    await extractSmokeZip(
      join(work, 'product.zip'),
      work,
      productMembers(input.target),
      MAX_ZIP,
    )
    await extractSmokeZip(join(work, 'notices.zip'), work, {
      THIRD_PARTY_NOTICES: 'THIRD_PARTY_NOTICES',
      'license-bundle.json': 'license-bundle.json',
    }, MAX_NOTICE)
    const verified = await verifySmokeFiles(input, root, work)
    receipt.product = {
      receipt_sha256: input.product.receipt_sha256,
      archive_sha256: verified.output.archive_sha256,
      executable_sha256: verified.output.executable_sha256,
      bridge_sha256: verified.output.bridge_sha256,
      notices_sha256: verified.source.notices_sha256,
    }
    receipt.timings = { acquisition_ms: Date.now() - downloadStarted }
    receipt.status = 'prepared'
    receipt.stage = 'verified'
    receipt.finished_at = new Date().toISOString()
    await Deno.writeTextFile(
      join(work, 'prepared.json'),
      canonicalReceipt({
        input_sha256: hash(canonicalReceipt(input)),
        receipt,
      }),
      { createNew: true, mode: 0o600 },
    )
    await writeReceipt(receiptPath, receipt)
  } catch (error) {
    receipt.status = 'failed'
    receipt.error_code = error instanceof SmokeError
      ? error.code
      : 'acquisition-failed'
    receipt.finished_at = new Date().toISOString()
    await writeReceipt(receiptPath, receipt)
    throw error
  }
}

export async function executeSmoke(
  input: SmokeInput,
  root: string,
  workPath: string,
  receiptPath: string,
  options: { executor?: SmokeExecutor; host?: () => Promise<NativeHost> } = {},
): Promise<void> {
  let receipt = initialReceipt(input)
  try {
    assertSmokeContext(input, Deno.env.get)
    const work = await privateDirectory(workPath)
    const prepared = fields(await json(join(work, 'prepared.json')), [
      'input_sha256',
      'receipt',
    ])
    if (
      prepared.input_sha256 !== hash(canonicalReceipt(input)) ||
      prepared.receipt.status !== 'prepared'
    ) fail('missing-verified-acquisition')
    receipt = initialReceipt(input)
    receipt.stage = 'execute'
    receipt.status = 'incomplete'
    const product = await verifySmokeFiles(input, root, work)
    receipt.runtime_revocation = await checkReviewedRuntimeRevocation(
      input.qualification_identity,
      root,
    )
    receipt.product = {
      receipt_sha256: input.product.receipt_sha256,
      archive_sha256: product.output.archive_sha256,
      executable_sha256: product.output.executable_sha256,
      bridge_sha256: product.output.bridge_sha256,
      notices_sha256: product.source.notices_sha256,
    }
    if (
      Number.isSafeInteger(prepared.receipt.timings?.acquisition_ms) &&
      prepared.receipt.timings.acquisition_ms >= 0
    ) {
      receipt.timings = {
        acquisition_ms: prepared.receipt.timings.acquisition_ms,
      }
    }
    const priorTiming = prepared.receipt.timing_context
    if (
      priorTiming &&
      [
        priorTiming.run_created_at,
        priorTiming.run_started_at,
        priorTiming.smoke_started_at,
      ].every((value) =>
        typeof value === 'string' && Number.isFinite(Date.parse(value))
      )
    ) {
      receipt.timing_context = {
        run_created_at: new Date(priorTiming.run_created_at).toISOString(),
        run_started_at: new Date(priorTiming.run_started_at).toISOString(),
        smoke_started_at: new Date(priorTiming.smoke_started_at).toISOString(),
        run_to_smoke_start_ms: Date.parse(priorTiming.smoke_started_at) -
          Date.parse(priorTiming.run_started_at),
      }
    }
    const host = await (options.host ?? (() => nativeHost(input.target)))()
    if (
      host.architecture !==
        (input.target.startsWith('x86_64') ? 'x86_64' : 'arm64') ||
      host.translated !== false || host.os !== 'darwin'
    ) fail('native-host-mismatch')
    receipt.host = host
    const scratch = await Deno.makeTempDir({ dir: work, prefix: 'scratch-' })
    await Deno.chmod(scratch, 0o700)
    try {
      const profile = sandboxProfile(work, scratch)
      const executable = join(work, 'executable'), bridge = join(work, 'bridge')
      await Deno.chmod(executable, 0o700)
      await Deno.chmod(bridge, 0o700)
      const version = await reviewedSourceVersion(root),
        notices = await Deno.readFile(join(work, 'THIRD_PARTY_NOTICES'))
      for (
        const [name, program, args] of [
          ['version', executable, ['--version']],
          ['help', executable, ['--help']],
          ['licenses', executable, ['licenses']],
          ['bridge', bridge, []],
        ] as const
      ) {
        const result = await (options.executor ?? sandboxExecutor)({
          executable: program,
          args: [...args],
          profile,
          cwd: scratch,
          temporary: scratch,
          timeout_ms: 30_000,
          maximum_output: name === 'licenses'
            ? Math.min(MAX_NOTICE, notices.length + 1)
            : 1024 * 1024,
        })
        const row = {
          case: name,
          executable: name === 'bridge' ? 'current-bridge' : 'current-product',
          arguments: [...args],
          exit_code: result.exit_code,
          duration_ms: result.duration_ms,
          timed_out: result.timed_out,
          stdout_sha256: hash(result.stdout),
          stderr_sha256: hash(result.stderr),
          status: 'failed',
        }
        receipt.cases.push(row)
        verifySmokeOutput(name, result, version, notices)
        row.status = 'passed'
      }
      await verifySmokeFiles(input, root, work)
      if (
        await hashFile(executable) !== product.output.executable_sha256 ||
        await hashFile(bridge) !== product.output.bridge_sha256
      ) fail('post-execution-byte-mismatch')
      receipt.post_execution = {
        archive_sha256: product.output.archive_sha256,
        executable_sha256: product.output.executable_sha256,
        bridge_sha256: product.output.bridge_sha256,
      }
    } finally {
      await Deno.remove(scratch, { recursive: true })
    }
    receipt.status = 'passed'
    receipt.stage = 'complete'
    receipt.finished_at = new Date().toISOString()
    await writeReceipt(receiptPath, receipt)
  } catch (error) {
    receipt.status = 'failed'
    receipt.error_code = error instanceof SmokeError
      ? error.code
      : 'execution-verification-failed'
    receipt.finished_at = new Date().toISOString()
    await writeReceipt(receiptPath, receipt)
    throw error
  }
}

if (import.meta.main) {
  const [operation, inputPath, workPath, receiptPath] = Deno.args
  try {
    if (
      Deno.args.length !== 4 || !['acquire', 'execute'].includes(operation) ||
      resolve(receiptPath).startsWith(resolve(workPath) + '/')
    ) fail('invalid-arguments')
    const input = parseSmokeInput(await json(inputPath))
    if (operation === 'acquire') {
      await acquireSmoke(input, Deno.cwd(), workPath, receiptPath)
    } else await executeSmoke(input, Deno.cwd(), workPath, receiptPath)
    console.log(
      JSON.stringify({
        ok: true,
        stage: operation === 'acquire' ? 'prepared' : 'passed',
      }),
    )
  } catch (error) {
    console.log(
      JSON.stringify({
        ok: false,
        error_code: error instanceof SmokeError ? error.code : 'smoke-failed',
      }),
    )
    Deno.exit(1)
  }
}
