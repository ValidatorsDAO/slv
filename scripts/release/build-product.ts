/** Fresh application compilation against an independently verified custom runtime. */
import { createHash } from 'node:crypto'
import {
  canonicalReceipt,
  compiledModuleGraphFromDenoInfo,
  executableDigestFromArchive,
  hashFile,
  lockedSbom,
  packExecutable,
  reviewedSourceVersion,
  TARGETS,
  verifyLicenses,
} from './release.ts'
import { verifyLinuxProduct } from '../../source-rebuild/verify-linux-product.ts'
import {
  qualificationIdentity,
  readQualificationManifest,
  verifyQualificationBinding,
} from './runtime-qualification.ts'
import {
  checkFreshRuntimeRevocation,
  checkReviewedRuntimeRevocation,
  verifyRuntimeRevocationBinding,
} from './runtime-revocations.ts'

export type ProductTarget = (typeof TARGETS)[number]
export type QualificationState = 'candidate-validation' | 'final-qualified'
const SHA = /^[a-f0-9]{40}$/
const HASH = /^[a-f0-9]{64}$/
const ID = /^[1-9]\d*$/
const decode = new TextDecoder('utf-8', { fatal: true })
const digest = (bytes: Uint8Array) =>
  createHash('sha256').update(bytes).digest('hex')
const fail = (message: string): never => {
  throw new Error(message)
}
const equal = (a: unknown, b: unknown) =>
  JSON.stringify(a) === JSON.stringify(b)

export function assertProductHost(
  target: string,
  os = Deno.build.os,
  arch = Deno.build.arch,
): void {
  if (
    !(TARGETS as readonly string[]).includes(target) || os !== 'linux' ||
    arch !== (target === 'aarch64-unknown-linux-gnu' ? 'aarch64' : 'x86_64')
  ) {
    fail('product compilation requires the exact Linux build architecture')
  }
}

/** Strict thin Mach-O inspection; this makes no native execution/notarization claim. */
export function inspectMachO(bytes: Uint8Array, target: ProductTarget) {
  if (!target.endsWith('apple-darwin')) fail('Mach-O target is not Darwin')
  if (bytes.length < 32) fail('truncated Mach-O')
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const u32 = (offset: number, le = true) => {
    if (offset < 0 || offset + 4 > bytes.length) {
      fail('Mach-O read outside file')
    }
    return view.getUint32(offset, le)
  }
  const u64 = (offset: number) => {
    const result = Number(view.getBigUint64(offset, true))
    if (!Number.isSafeInteger(result)) fail('Mach-O offset overflow')
    return result
  }
  const cstring = (start: number, end: number) => {
    let nul = start
    while (nul < end && bytes[nul] !== 0) nul++
    if (nul === end) fail('unterminated Mach-O load-command string')
    return decode.decode(bytes.subarray(start, nul))
  }
  if (
    u32(0) !== 0xfeedfacf ||
    u32(4) !== (target.startsWith('x86_64') ? 0x01000007 : 0x0100000c) ||
    u32(12) !== 2
  ) {
    fail('wrong Mach-O architecture or executable format')
  }
  const commands = u32(16), commandBytes = u32(20)
  if (!commands || commands > 4096 || commandBytes > bytes.length - 32) {
    fail('invalid Mach-O load commands')
  }
  let offset = 32,
    minimum: number | undefined,
    signature: { offset: number; size: number } | undefined
  let hasText = false, hasLinkedit = false, hasMain = false, hasDyld = false
  let textSize = 0, entryOffset = 0, linkeditOffset = 0, linkeditEnd = 0
  const dependencies: string[] = []
  for (let index = 0; index < commands; index++) {
    const kind = u32(offset), size = u32(offset + 4)
    if (size < 8 || size % 8 || offset + size > 32 + commandBytes) {
      fail('malformed Mach-O command size')
    }
    if (kind === 0x19) {
      if (size < 72 || size !== 72 + u32(offset + 64) * 80) {
        fail('malformed Mach-O segment')
      }
      const name = cstring(offset + 8, offset + 24)
      const fileOffset = u64(offset + 40), fileSize = u64(offset + 48)
      if (fileOffset + fileSize > bytes.length) {
        fail('Mach-O segment exceeds file')
      }
      if (name === '__TEXT') {
        if (
          hasText || fileOffset !== 0 || fileSize < 32 + commandBytes ||
          !(u32(offset + 60) & 4)
        ) fail('invalid executable Mach-O text segment')
        hasText = true
        textSize = fileSize
      }
      if (name === '__LINKEDIT') {
        if (hasLinkedit || !fileSize) fail('invalid Mach-O linkedit segment')
        hasLinkedit = true
        linkeditOffset = fileOffset
        linkeditEnd = fileOffset + fileSize
      }
    } else if (kind === 0x32 || kind === 0x24) {
      if (
        minimum !== undefined || size < (kind === 0x32 ? 24 : 16) ||
        (kind === 0x32 &&
          (u32(offset + 8) !== 1 || size !== 24 + u32(offset + 20) * 8))
      ) fail('invalid Mach-O minimum OS command')
      minimum = u32(offset + (kind === 0x32 ? 12 : 8))
    } else if (kind === 0x1d) {
      if (signature || size !== 16) fail('invalid Mach-O signature command')
      signature = { offset: u32(offset + 8), size: u32(offset + 12) }
    } else if (kind === 0x80000028) {
      if (hasMain || size !== 24) fail('invalid Mach-O entry point')
      hasMain = true
      entryOffset = u64(offset + 8)
    } else if (kind === 0xe) {
      if (
        hasDyld || size < 16 || u32(offset + 8) < 12 ||
        u32(offset + 8) >= size ||
        cstring(offset + u32(offset + 8), offset + size) !== '/usr/lib/dyld'
      ) fail('invalid Mach-O dynamic loader')
      hasDyld = true
    } else if ([0xc, 0x20, 0x80000018, 0x8000001f, 0x80000023].includes(kind)) {
      if (size < 24 || u32(offset + 8) < 24 || u32(offset + 8) >= size) {
        fail('invalid Mach-O dylib command')
      }
      const name = cstring(offset + u32(offset + 8), offset + size)
      if (
        (!name.startsWith('/usr/lib/') &&
          !name.startsWith('/System/Library/Frameworks/')) ||
        name.split('/').some((part) => part === '..' || part === '.')
      ) fail('Mach-O loads a non-system library')
      dependencies.push(name)
    } else if (kind === 0x8000001c || kind === 0x27 || kind === 0xd) {
      fail('Mach-O contains an unreviewed dynamic loading command')
    }
    offset += size
  }
  if (
    offset !== 32 + commandBytes || minimum !== 0x000c0000 || !hasText ||
    !hasLinkedit || !hasMain || entryOffset < 32 + commandBytes ||
    entryOffset >= textSize || !hasDyld || !dependencies.length || !signature
  ) fail('incomplete Mach-O structure or minimum OS differs from 12.0')
  const sig = signature!
  if (
    sig.offset < offset || sig.offset < linkeditOffset ||
    sig.offset + sig.size !== linkeditEnd || sig.size < 20 ||
    sig.offset + sig.size !== bytes.length ||
    u32(sig.offset, false) !== 0xfade0cc0
  ) fail('invalid Mach-O embedded ad-hoc signature')
  const superLength = u32(sig.offset + 4, false),
    count = u32(sig.offset + 8, false)
  if (
    count < 1 || count > 3 || superLength > sig.size ||
    superLength < 12 + count * 8
  ) fail('invalid Mach-O signature inventory')
  for (const byte of bytes.subarray(sig.offset + superLength)) {
    if (byte !== 0) fail('nonzero Mach-O signature padding')
  }
  const blobs = new Map<number, { start: number; length: number }>()
  let blobEnd = sig.offset + 12 + count * 8
  for (let n = 0; n < count; n++) {
    const kind = u32(sig.offset + 12 + n * 8, false)
    const start = sig.offset + u32(sig.offset + 16 + n * 8, false)
    if (
      ![0, 2, 0x10000].includes(kind) || blobs.has(kind) || start !== blobEnd ||
      start + 8 > sig.offset + superLength
    ) fail('unrecognized Mach-O signature blob')
    const length = u32(start + 4, false)
    if (length < 8 || start + length > sig.offset + superLength) {
      fail('invalid Mach-O signature blob range')
    }
    if (
      kind === 2 &&
      (u32(start, false) !== 0xfade0c01 || length !== 12 ||
        u32(start + 8, false) !== 0)
    ) fail('unsupported Mach-O requirement set')
    if (
      kind === 0x10000 && (u32(start, false) !== 0xfade0b01 || length !== 8)
    ) fail('Mach-O ad-hoc signature contains CMS identity')
    blobs.set(kind, { start, length })
    blobEnd = start + length
  }
  if (blobEnd !== sig.offset + superLength || !blobs.has(0)) {
    fail('incomplete Mach-O signature blob inventory')
  }
  const cd = blobs.get(0)!.start, cdLength = blobs.get(0)!.length
  if (
    cdLength < 88 || u32(cd, false) !== 0xfade0c02 ||
    u32(cd + 8, false) !== 0x20400 ||
    ![2, 0x20002].includes(u32(cd + 12, false)) ||
    u32(cd + 44, false) !== 0 || u32(cd + 48, false) !== 0
  ) fail('unsupported Mach-O CodeDirectory')
  const hashOffset = u32(cd + 16, false),
    special = u32(cd + 24, false),
    slots = u32(cd + 28, false),
    limit = u32(cd + 32, false)
  if (
    special > 2 || (blobs.has(2) ? special !== 2 : special !== 0) ||
    limit !== sig.offset || bytes[cd + 36] !== 32 ||
    bytes[cd + 37] !== 2 || bytes[cd + 39] !== 12 ||
    hashOffset - special * 32 < 88 ||
    slots !== Math.ceil(limit / 4096) || hashOffset + slots * 32 !== cdLength ||
    u32(cd + 20, false) < 88 || u32(cd + 20, false) >= hashOffset - special * 32
  ) fail('invalid Mach-O signature coverage')
  cstring(cd + u32(cd + 20, false), cd + hashOffset - special * 32)
  for (let slot = 1; slot <= special; slot++) {
    const blob = blobs.get(slot)
    const expected = blob
      ? createHash('sha256').update(
        bytes.subarray(blob.start, blob.start + blob.length),
      ).digest()
      : new Uint8Array(32)
    const actual = bytes.subarray(
      cd + hashOffset - slot * 32,
      cd + hashOffset - (slot - 1) * 32,
    )
    if (!actual.every((value, index) => value === expected[index])) {
      fail('Mach-O signature special-slot hash differs')
    }
  }
  for (let page = 0; page < slots; page++) {
    const actual = digest(
      bytes.subarray(page * 4096, Math.min((page + 1) * 4096, limit)),
    )
    const expected = Array.from(
      bytes.subarray(
        cd + hashOffset + page * 32,
        cd + hashOffset + (page + 1) * 32,
      ),
    ).map((b) => b.toString(16).padStart(2, '0')).join('')
    if (actual !== expected) fail('Mach-O code signature page hash differs')
  }
  return {
    format: 'Mach-O-64',
    architecture: target.split('-')[0],
    minimum_os: '12.0',
    signature: 'ad-hoc-sha256-verified',
    load_commands_sha256: digest(bytes.subarray(32, 32 + commandBytes)),
    dependencies,
    native_execution: 'not_performed',
  } as const
}

export type CurrentProductReceipt = {
  schema_version: 2
  kind: 'slv-current-product-receipt'
  target: ProductTarget
  source: {
    commit: string
    ref: string
    lock_sha256: string
    graph_sha256: string
    sbom_sha256: string
    notices_sha256: string
    source_receipt_sha256: string
    engine_sha256: string
    bridge_source_sha256: string
  }
  qualification: {
    identity: string
    state: QualificationState
    baseline_denort_sha256: string
    selected_lock_sha256: string
    derived_lock_sha256: string
    native_proof_sha256: string
    build_receipt_sha256: string
  }
  producer: {
    repository: 'ValidatorsDAO/slv'
    workflow: '.github/workflows/slv-remote-build.yml'
    workflow_sha: string
    run_id: string
    run_attempt: string
    job: string
    host_os: 'linux'
    host_arch: 'x86_64' | 'aarch64'
    profile: string
  }
  frontend: {
    version: '2.9.3'
    sha256: string
    flags: string[]
    bridge_flags: string[]
  }
  output: {
    executable_sha256: string
    archive_sha256: string
    bridge_sha256: string
    verification_sha256: string
  }
  native_execution: 'passed' | 'not_performed'
}

export function parseCurrentProductReceipt(
  value: unknown,
): CurrentProductReceipt {
  const receipt = value as CurrentProductReceipt
  const keys = (value: unknown, expected: string[]) => {
    if (
      !value || typeof value !== 'object' || Array.isArray(value) ||
      !equal(Object.keys(value).sort(), expected.sort())
    ) fail('invalid current product receipt fields')
  }
  keys(receipt, [
    'schema_version',
    'kind',
    'target',
    'source',
    'qualification',
    'producer',
    'frontend',
    'output',
    'native_execution',
  ])
  keys(receipt.source, [
    'commit',
    'ref',
    'lock_sha256',
    'graph_sha256',
    'sbom_sha256',
    'notices_sha256',
    'source_receipt_sha256',
    'engine_sha256',
    'bridge_source_sha256',
  ])
  keys(receipt.qualification, [
    'identity',
    'state',
    'baseline_denort_sha256',
    'selected_lock_sha256',
    'derived_lock_sha256',
    'native_proof_sha256',
    'build_receipt_sha256',
  ])
  keys(receipt.producer, [
    'repository',
    'workflow',
    'workflow_sha',
    'run_id',
    'run_attempt',
    'job',
    'host_os',
    'host_arch',
    'profile',
  ])
  keys(receipt.frontend, ['version', 'sha256', 'flags', 'bridge_flags'])
  keys(receipt.output, [
    'executable_sha256',
    'archive_sha256',
    'bridge_sha256',
    'verification_sha256',
  ])
  if (
    receipt.schema_version !== 2 ||
    receipt.kind !== 'slv-current-product-receipt' ||
    !(TARGETS as readonly string[]).includes(receipt.target) ||
    !SHA.test(receipt.source.commit) ||
    !/^refs\/(heads\/[A-Za-z0-9._/-]+|pull\/[1-9]\d*\/merge|tags\/v[0-9.]+)$/
      .test(receipt.source.ref) ||
    !SHA.test(receipt.producer.workflow_sha) ||
    typeof receipt.producer.run_id !== 'string' ||
    typeof receipt.producer.run_attempt !== 'string' ||
    !ID.test(receipt.producer.run_id) ||
    !ID.test(receipt.producer.run_attempt) ||
    receipt.producer.repository !== 'ValidatorsDAO/slv' ||
    receipt.producer.workflow !== '.github/workflows/slv-remote-build.yml' ||
    receipt.producer.job !== `build-${receipt.target}` ||
    receipt.frontend.version !== '2.9.3' ||
    !['candidate-validation', 'final-qualified'].includes(
      receipt.qualification.state,
    )
  ) fail('invalid current product identity')
  assertProductHost(
    receipt.target,
    receipt.producer.host_os,
    receipt.producer.host_arch,
  )
  if (
    ![
      'hosted-linux',
      receipt.target === 'aarch64-unknown-linux-gnu'
        ? 'linux-arm64-4'
        : 'linux-16',
    ].includes(receipt.producer.profile) ||
    receipt.native_execution !==
      (receipt.target.endsWith('linux-gnu') ? 'passed' : 'not_performed')
  ) fail('invalid current product execution claim')
  for (
    const record of [
      receipt.source,
      receipt.qualification,
      receipt.frontend,
      receipt.output,
    ]
  ) {
    for (const [key, entry] of Object.entries(record)) {
      if (
        (key.endsWith('_sha256') || key === 'identity' || key === 'sha256') &&
        (typeof entry !== 'string' || !HASH.test(entry))
      ) fail('invalid current product digest')
    }
  }
  if (
    !equal(receipt.frontend.flags, compileFlags(receipt.target, 'product')) ||
    !equal(
      receipt.frontend.bridge_flags,
      compileFlags(receipt.target, 'bridge'),
    )
  ) fail('unreviewed product compile flags')
  return receipt
}

export const compileFlags = (
  target: ProductTarget,
  kind: 'product' | 'bridge',
) => [
  'compile',
  '--frozen',
  '--cached-only',
  '--no-prompt',
  '-A',
  '--include',
  'cli/lib/release/engine.py',
  ...(kind === 'product'
    ? ['--include', 'dist/release-inputs/THIRD_PARTY_NOTICES']
    : []),
  '--target',
  target,
  '--output',
  kind === 'product'
    ? `dist/slv-${target}-exe`
    : `dist/release-inputs/product-runtime/${target}/release-bridge-smoke`,
  kind === 'product'
    ? 'cli/src/index.ts'
    : 'cli/lib/release/compiled_bridge_smoke.ts',
]

export function embeddingRecipeSha256(): string {
  return digest(new TextEncoder().encode(canonicalReceipt({
    deno: '2.9.3',
    libsui: '0.16.3',
    runtime: 'verified-baseline-DENORT_BIN',
    targets: TARGETS.map((target) => ({
      target,
      product_flags: compileFlags(target, 'product'),
      bridge_flags: compileFlags(target, 'bridge'),
    })),
  })))
}

export type ProductIdentity = {
  sourceSha: string
  sourceRef: string
  runId: string
  runAttempt: string
  workflowSha: string
}
export async function verifyCurrentProductFiles(
  root: string,
  target: ProductTarget,
  expected: ProductIdentity,
  qualification: {
    identity: string
    state: QualificationState
    runtime: { sha256: string }
    selectedLock: { sha256: string }
    derivedLock: { sha256: string }
    proof: { sha256: string }
    buildReceipt: { sha256: string }
  },
): Promise<CurrentProductReceipt> {
  const reviewedPolicy = await checkReviewedRuntimeRevocation(
    qualification.identity,
    root,
  )
  const base = `${root}/dist/release-inputs/product-runtime/${target}`
  const r = parseCurrentProductReceipt(
    JSON.parse(await Deno.readTextFile(`${base}/product-runtime-receipt.json`)),
  )
  if (
    r.target !== target || r.source.commit !== expected.sourceSha ||
    r.source.ref !== expected.sourceRef ||
    r.producer.run_id !== expected.runId ||
    r.producer.run_attempt !== expected.runAttempt ||
    r.producer.workflow_sha !== expected.workflowSha ||
    r.qualification.identity !== qualification.identity ||
    r.qualification.state !== qualification.state ||
    r.qualification.baseline_denort_sha256 !== qualification.runtime.sha256 ||
    r.qualification.selected_lock_sha256 !==
      qualification.selectedLock.sha256 ||
    r.qualification.derived_lock_sha256 !== qualification.derivedLock.sha256 ||
    r.qualification.native_proof_sha256 !== qualification.proof.sha256 ||
    r.qualification.build_receipt_sha256 !== qualification.buildReceipt.sha256
  ) fail('current product producer or qualification differs')
  for (
    const [path, expectedHash] of [
      ['deno.lock', r.source.lock_sha256],
      ['dist/release-inputs/compiled-module-graph.json', r.source.graph_sha256],
      ['dist/release-inputs/THIRD_PARTY_NOTICES', r.source.notices_sha256],
      [
        'dist/release-inputs/source-materials-receipt.json',
        r.source.source_receipt_sha256,
      ],
      ['cli/lib/release/engine.py', r.source.engine_sha256],
      [
        'cli/lib/release/compiled_bridge_smoke.ts',
        r.source.bridge_source_sha256,
      ],
    ]
  ) {
    if (await hashFile(`${root}/${path}`) !== expectedHash) {
      fail(`current product input differs: ${path}`)
    }
  }
  const archive = `${root}/dist/slv-${target}-exe.tar.gz`
  if (
    await hashFile(archive) !== r.output.archive_sha256 ||
    await executableDigestFromArchive(archive, `slv-${target}-exe`) !==
      r.output.executable_sha256 ||
    await hashFile(`${base}/release-bridge-smoke`) !== r.output.bridge_sha256 ||
    await hashFile(`${base}/product-verification.json`) !==
      r.output.verification_sha256
  ) fail('current product output bytes differ')
  const verification = JSON.parse(
    await Deno.readTextFile(`${base}/product-verification.json`),
  )
  verifyRuntimeRevocationBinding(verification.runtime_revocation, {
    identity: qualification.identity,
    mode: qualification.state,
    reviewedPolicySha256: reviewedPolicy.policy_sha256,
    sourceCommit: expected.sourceSha,
  })
  if (qualification.state === 'final-qualified') {
    await checkFreshRuntimeRevocation(qualification.identity)
  }
  return r
}

type BuildOptions = ProductIdentity & {
  target: ProductTarget
  root: string
  qualificationDirectory: string
  state: QualificationState
  toolsReceipt?: string
  profile: string
  licenseAttempt: string
  licenseSha256: string
}
async function command(
  executable: string,
  args: string[],
  root: string,
  runtime?: string,
): Promise<Uint8Array> {
  const result = await new Deno.Command(executable, {
    args,
    cwd: root,
    clearEnv: true,
    env: {
      PATH: Deno.env.get('PATH') ?? '/usr/bin:/bin',
      HOME: Deno.env.get('HOME') ?? root,
      ...(Deno.env.get('DENO_DIR')
        ? { DENO_DIR: Deno.env.get('DENO_DIR')! }
        : {}),
      LANG: 'C',
      NO_COLOR: '1',
      ...(runtime ? { DENORT_BIN: runtime } : {}),
    },
    stdout: 'piped',
    stderr: 'piped',
    signal: AbortSignal.timeout(600_000),
  }).output()
  if (!result.success) {
    fail(`product command failed: ${executable} (exit ${result.code})`)
  }
  return result.stdout
}

export async function buildProduct(
  options: BuildOptions,
): Promise<CurrentProductReceipt> {
  const o = options, target = o.target, root = await Deno.realPath(o.root)
  const selectedQualification = await readQualificationManifest(
    `${root}/source-materials/runtime-qualification.json`,
  )
  await checkReviewedRuntimeRevocation(
    qualificationIdentity(selectedQualification),
    root,
  )
  assertProductHost(target)
  if (
    o.state === 'final-qualified' &&
    (Deno.env.get('RUNNER_ENVIRONMENT') !== 'self-hosted' ||
      o.profile !==
        (target === 'aarch64-unknown-linux-gnu' ? 'linux-arm64-4' : 'linux-16'))
  ) {
    fail(
      'final products require the declared self-hosted runner environment and exact profile',
    )
  }
  if (Deno.version.deno !== '2.9.3') {
    fail('product compiler frontend must be Deno 2.9.3')
  }
  const checkout = decode.decode(
    await command('git', ['rev-parse', 'HEAD'], root),
  ).trim()
  if (checkout !== o.sourceSha) {
    fail('product checkout differs from current source')
  }
  await verifyLicenses([
    o.sourceSha,
    o.runId,
    o.licenseAttempt,
    o.licenseSha256,
  ], { root })
  const graph = compiledModuleGraphFromDenoInfo(
    JSON.parse(
      decode.decode(
        await command(Deno.execPath(), [
          'info',
          '--json',
          '--frozen',
          'cli/src/index.ts',
        ], root),
      ),
    ),
  )
  await Deno.writeTextFile(
    `${root}/dist/release-inputs/compiled-module-graph.json`,
    JSON.stringify(graph, null, 2) + '\n',
  )
  const binding = await verifyQualificationBinding({
    directory: o.qualificationDirectory,
    repositoryRoot: root,
    target,
    mode: o.state,
  })
  const hostTarget = Deno.build.arch === 'aarch64'
    ? 'aarch64-unknown-linux-gnu'
    : 'x86_64-unknown-linux-gnu'
  if (
    await hashFile(Deno.execPath()) !==
      binding.manifest.compatibility.frontend[hostTarget].sha256 ||
    (await Deno.stat(Deno.execPath())).size !==
      binding.manifest.compatibility.frontend[hostTarget].size ||
    binding.manifest.compatibility.libsui_version !== '0.16.3' ||
    binding.manifest.compatibility.embedding_recipe_sha256 !==
      embeddingRecipeSha256()
  ) fail('compiler frontend bytes differ from qualified embedding frontend')
  const base = `${root}/dist/release-inputs/product-runtime/${target}`
  try {
    await Deno.lstat(base)
    fail('product output already exists')
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error
  }
  await Deno.mkdir(base, { recursive: true })
  const executable = `${root}/dist/slv-${target}-exe`,
    bridge = `${base}/release-bridge-smoke`
  for (const path of [executable, `${executable}.tar.gz`]) {
    try {
      await Deno.lstat(path)
      fail('product executable already exists')
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error
    }
  }
  await command(
    Deno.execPath(),
    ['check', '--frozen', 'cli/src/index.ts'],
    root,
  )
  const cleanInputs = [
    'diff',
    '--exit-code',
    'HEAD',
    '--',
    'cli',
    'cmn',
    'deno.json',
    'deno.lock',
    'source-materials',
    'source-rebuild',
    'scripts',
  ]
  await command('git', cleanInputs, root)
  for (const kind of ['product', 'bridge'] as const) {
    await command(
      Deno.execPath(),
      compileFlags(target, kind),
      root,
      binding.runtime.path,
    )
  }
  await command('git', cleanInputs, root)
  let verification: unknown
  if (target.endsWith('linux-gnu')) {
    if (!o.toolsReceipt) fail('Linux product requires pinned execution tools')
    const version = decode.decode(
      await command(executable, ['--version'], root),
    )
    if (version !== `slv ${await reviewedSourceVersion(root)}\n`) {
      fail('fresh Linux product version differs')
    }
    await command(executable, ['--help'], root)
    const notices = await command(executable, ['licenses'], root)
    if (digest(notices) !== o.licenseSha256) {
      fail('fresh product notices differ')
    }
    await command(bridge, [], root)
    const transport = await Deno.makeTempDir({ prefix: 'slv-current-runtime-' })
    try {
      await Deno.copyFile(binding.runtime.path, `${transport}/baseline-denort`)
      await Deno.copyFile(
        binding.derivedLock.path,
        `${transport}/baseline-derived-relink-Cargo.lock`,
      )
      const row = binding.manifest.targets.find((row) => row.target === target)!
      await Deno.copyFile(
        `${o.qualificationDirectory}/${row.transport_manifest}`,
        `${transport}/manifest.json`,
      )
      await command('/usr/bin/openssl', [
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-keyout',
        `${transport}/tls-ca.key`,
        '-out',
        `${transport}/tls-root-ca.pem`,
        '-days',
        '2',
        '-subj',
        '/CN=SLV local test CA',
      ], root)
      await command('/usr/bin/openssl', [
        'req',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-keyout',
        `${transport}/tls-localhost.key`,
        '-out',
        `${transport}/tls-localhost.csr`,
        '-subj',
        '/CN=localhost',
      ], root)
      await Deno.writeTextFile(
        `${transport}/extensions`,
        'subjectAltName=DNS:localhost,IP:127.0.0.1\nbasicConstraints=CA:FALSE\nextendedKeyUsage=serverAuth\n',
      )
      await command('/usr/bin/openssl', [
        'x509',
        '-req',
        '-in',
        `${transport}/tls-localhost.csr`,
        '-CA',
        `${transport}/tls-root-ca.pem`,
        '-CAkey',
        `${transport}/tls-ca.key`,
        '-CAcreateserial',
        '-out',
        `${transport}/tls-localhost.crt`,
        '-days',
        '2',
        '-extfile',
        `${transport}/extensions`,
      ], root)
      await verifyLinuxProduct({
        '--target': target,
        '--build-receipt': binding.buildReceipt.path,
        '--native-proof': binding.proof.path,
        '--runtime-dir': transport,
        '--tools-receipt': o.toolsReceipt!,
        '--executable': executable,
        '--bridge': bridge,
        '--canonical-notice': `${root}/dist/release-inputs/THIRD_PARTY_NOTICES`,
        '--current-tls': 'true',
        '--out': `${base}/linux-compatibility`,
      })
    } finally {
      await Deno.remove(transport, { recursive: true })
    }
    await Deno.copyFile(
      `${base}/linux-compatibility/linux-compatibility-receipt.json`,
      `${base}/linux-compatibility-receipt.json`,
    )
    verification = {
      kind: 'slv-current-linux-verification',
      native_execution: 'passed',
      compatibility_sha256: await hashFile(
        `${base}/linux-compatibility-receipt.json`,
      ),
      version,
      notices_sha256: digest(notices),
      help: 'passed',
      bridge: 'passed',
    }
  } else {
    verification = {
      kind: 'slv-current-darwin-verification',
      executable: inspectMachO(await Deno.readFile(executable), target),
      bridge: inspectMachO(await Deno.readFile(bridge), target),
      native_execution: 'not_performed',
    }
  }
  const runtimeRevocation = {
    reviewed_checkout_policy: await checkReviewedRuntimeRevocation(
      binding.identity,
      root,
    ),
    current_main_policy: o.state === 'final-qualified'
      ? await checkFreshRuntimeRevocation(binding.identity)
      : null,
  }
  await Deno.writeTextFile(
    `${base}/product-verification.json`,
    JSON.stringify(
      {
        ...(verification as Record<string, unknown>),
        runtime_revocation: runtimeRevocation,
      },
      null,
      2,
    ) + '\n',
  )
  await packExecutable(executable, `${executable}.tar.gz`, `slv-${target}-exe`)
  const timestamp = decode.decode(
    await command('git', ['show', '-s', '--format=%cI', o.sourceSha], root),
  ).trim()
  const sbom = JSON.stringify(
    await lockedSbom(
      root,
      await reviewedSourceVersion(root),
      o.sourceSha,
      timestamp,
      await Deno.readTextFile(
        `${root}/dist/release-inputs/source-materials-receipt.json`,
      ),
    ),
    null,
    2,
  ) + '\n'
  const receipt: CurrentProductReceipt = {
    schema_version: 2,
    kind: 'slv-current-product-receipt',
    target,
    source: {
      commit: o.sourceSha,
      ref: o.sourceRef,
      lock_sha256: await hashFile(`${root}/deno.lock`),
      sbom_sha256: digest(new TextEncoder().encode(sbom)),
      graph_sha256: await hashFile(
        `${root}/dist/release-inputs/compiled-module-graph.json`,
      ),
      notices_sha256: o.licenseSha256,
      source_receipt_sha256: await hashFile(
        `${root}/dist/release-inputs/source-materials-receipt.json`,
      ),
      engine_sha256: await hashFile(`${root}/cli/lib/release/engine.py`),
      bridge_source_sha256: await hashFile(
        `${root}/cli/lib/release/compiled_bridge_smoke.ts`,
      ),
    },
    qualification: {
      identity: binding.identity,
      state: binding.state,
      baseline_denort_sha256: binding.runtime.sha256,
      selected_lock_sha256: binding.selectedLock.sha256,
      derived_lock_sha256: binding.derivedLock.sha256,
      native_proof_sha256: binding.proof.sha256,
      build_receipt_sha256: binding.buildReceipt.sha256,
    },
    producer: {
      repository: 'ValidatorsDAO/slv',
      workflow: '.github/workflows/slv-remote-build.yml',
      workflow_sha: o.workflowSha,
      run_id: o.runId,
      run_attempt: o.runAttempt,
      job: `build-${target}`,
      host_os: 'linux',
      host_arch: Deno.build.arch as 'x86_64' | 'aarch64',
      profile: o.profile,
    },
    frontend: {
      version: '2.9.3',
      sha256: await hashFile(Deno.execPath()),
      flags: compileFlags(target, 'product'),
      bridge_flags: compileFlags(target, 'bridge'),
    },
    output: {
      executable_sha256: await hashFile(executable),
      archive_sha256: await hashFile(`${executable}.tar.gz`),
      bridge_sha256: await hashFile(bridge),
      verification_sha256: await hashFile(`${base}/product-verification.json`),
    },
    native_execution: target.endsWith('linux-gnu') ? 'passed' : 'not_performed',
  }
  parseCurrentProductReceipt(receipt)
  await Deno.writeTextFile(
    `${base}/product-runtime-receipt.json`,
    JSON.stringify(receipt, null, 2) + '\n',
  )
  return receipt
}

if (import.meta.main) {
  const [commandName, ...args] = Deno.args
  const parsed: Record<string, string> = {}
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index], value = args[index + 1]
    if (
      !flag.startsWith('--') || !value || value.startsWith('--') || parsed[flag]
    ) fail('expected unique --flag VALUE pairs')
    parsed[flag] = value
  }
  const required = (key: string) =>
    parsed[`--${key}`] || fail(`missing --${key}`)
  if (commandName !== 'compile') {
    fail(
      'usage: build-product.ts compile --target TARGET --source-sha SHA --source-ref REF --run-id ID --run-attempt ATTEMPT --workflow-sha SHA --qualification-dir DIR --qualification-state MODE --profile PROFILE --license-attempt ATTEMPT --license-sha256 DIGEST [--tools-receipt PATH]',
    )
  }
  await buildProduct({
    root: Deno.cwd(),
    target: required('target') as ProductTarget,
    sourceSha: required('source-sha'),
    sourceRef: required('source-ref'),
    runId: required('run-id'),
    runAttempt: required('run-attempt'),
    workflowSha: required('workflow-sha'),
    qualificationDirectory: required('qualification-dir'),
    state: required('qualification-state') as QualificationState,
    profile: required('profile'),
    licenseAttempt: required('license-attempt'),
    licenseSha256: required('license-sha256'),
    toolsReceipt: parsed['--tools-receipt'],
  })
}
