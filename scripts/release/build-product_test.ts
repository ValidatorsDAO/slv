import { assertEquals, assertRejects, assertThrows } from 'jsr:@std/assert@1'
import { createHash } from 'node:crypto'
import { guardDraftManifest } from './workflow.ts'
import {
  assertProductHost,
  compileFlags,
  type CurrentProductReceipt,
  inspectMachO,
  parseCurrentProductReceipt,
  verifyCurrentProductFiles,
} from './build-product.ts'
import {
  canonicalReceipt,
  hashFile,
  manifest,
  packExecutable,
  payloadSpecs,
  validateQualificationReference,
} from './release.ts'

import { checkReviewedRuntimeRevocation } from './runtime-revocations.ts'
const TARGET = 'x86_64-apple-darwin' as const
const hash = (value: Uint8Array | string) =>
  createHash('sha256').update(value).digest('hex')
const SHA = 'a'.repeat(40), DIGEST = 'b'.repeat(64)
const identity = {
  sourceSha: SHA,
  sourceRef: 'refs/pull/1/merge',
  runId: '123',
  runAttempt: '2',
  workflowSha: SHA,
}

function signedMachO(): Uint8Array {
  const commands: Uint8Array[] = []
  const command = (kind: number, length: number) => {
    const bytes = new Uint8Array(length), view = new DataView(bytes.buffer)
    view.setUint32(0, kind, true)
    view.setUint32(4, length, true)
    commands.push(bytes)
    return { bytes, view }
  }
  const text = command(0x19, 72)
  text.bytes.set(new TextEncoder().encode('__TEXT'), 8)
  text.view.setBigUint64(48, 512n, true)
  text.view.setUint32(60, 5, true)
  const linkedit = command(0x19, 72)
  linkedit.bytes.set(new TextEncoder().encode('__LINKEDIT'), 8)
  linkedit.view.setBigUint64(40, 512n, true)
  linkedit.view.setBigUint64(48, 146n, true)
  const minimum = command(0x32, 24)
  minimum.view.setUint32(8, 1, true)
  minimum.view.setUint32(12, 0xc0000, true)
  command(0x80000028, 24).view.setBigUint64(8, 400n, true)
  const dyld = command(0xe, 32)
  dyld.view.setUint32(8, 12, true)
  dyld.bytes.set(new TextEncoder().encode('/usr/lib/dyld'), 12)
  const dylib = command(0xc, 56)
  dylib.view.setUint32(8, 24, true)
  dylib.bytes.set(new TextEncoder().encode('/usr/lib/libSystem.B.dylib'), 24)
  const signature = command(0x1d, 16)
  signature.view.setUint32(8, 512, true)
  signature.view.setUint32(12, 146, true)
  const bytes = new Uint8Array(658), view = new DataView(bytes.buffer)
  view.setUint32(0, 0xfeedfacf, true)
  view.setUint32(4, 0x1000007, true)
  view.setUint32(12, 2, true)
  view.setUint32(16, commands.length, true)
  view.setUint32(20, commands.reduce((n, c) => n + c.length, 0), true)
  let offset = 32
  for (const command of commands) {
    bytes.set(command, offset)
    offset += command.length
  }
  view.setUint32(512, 0xfade0cc0)
  view.setUint32(516, 146)
  view.setUint32(520, 1)
  view.setUint32(528, 20)
  const cd = 532
  for (
    const [offset, value] of [
      [0, 0xfade0c02],
      [4, 126],
      [8, 0x20400],
      [12, 2],
      [16, 94],
      [20, 88],
      [28, 1],
      [32, 512],
    ]
  ) view.setUint32(cd + offset, value)
  bytes[cd + 36] = 32
  bytes[cd + 37] = 2
  bytes[cd + 39] = 12
  bytes.set(new TextEncoder().encode('a.out\0'), cd + 88)
  bytes.set(
    createHash('sha256').update(bytes.subarray(0, 512)).digest(),
    cd + 94,
  )
  return bytes
}

function unsignedIntelMachO(): Uint8Array {
  const bytes = signedMachO().slice(0, 576), view = new DataView(bytes.buffer)
  const commandBytes = view.getUint32(20, true)
  view.setUint32(16, view.getUint32(16, true) - 1, true)
  view.setUint32(20, commandBytes - 16, true)
  bytes.fill(0, 32 + commandBytes - 16, 32 + commandBytes)
  view.setBigUint64(32 + 72 + 48, 64n, true)
  bytes.fill(0, 512)
  return bytes
}

// Header-only replay of the pinned-runtime bridge compiled on Linux ARM64 at
// 1545c86b. The body is zero-filled and is never executed; separate tests bind
// full executable bytes to their product receipt.
Deno.test('real Linux-produced Intel bridge header records its unsigned state', () => {
  const header = Uint8Array.from(
    atob(
      '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' +
        'AAAAAF9fYnNzAAAAAAAAAAAAAABfX0RBVEEAAAAAAAAAAAAAgDTvBAEAAAB45QIAAAAAAAAAAAAH' +
        'AAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAAAAX19jb21tb24AAAAAAAAAAF9fREFUQQAAAAAAAAAA' +
        'AAAAGvIEAQAAABETAAAAAAAAAAAAAAQAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAZAAAASAAA' +
        'AF9fTElOS0VESVQAAAAAAAAAMPIEAQAAANl/7AEAAAAAADDvBAAAAADZf+wBAAAAAAEAAAABAAAA' +
        'AAAAAAAAAAA0AACAEAAAAAAw7wT4JwAAMwAAgBAAAAD4V+8EeBIAAAIAAAAYAAAASKXyBEXtCgCw' +
        'iaEFKSY6AQsAAABQAAAAAAAAAG7qCgBu6goA1QAAAEPrCgACAgAAAAAAAAAAAAAAAAAAAAAAAAAA' +
        'AAAAAAAAmHmhBQYEAAAAAAAAAAAAAAAAAAAAAAAADgAAACAAAAAMAAAAL3Vzci9saWIvZHlsZAAA' +
        'AAAAAAAbAAAAGAAAADpHNGJ5DD7btaY9a4vaiKwyAAAAIAAAAAEAAAAAAAwAAAIPAAEAAAADAAAA' +
        'AwdbBCoAAAAQAAAAAAAAAAAAAAAoAACAGAAAAJDOAwAAAAAAAAAAAAAAAAAMAAAAaAAAABgAAAAC' +
        'AAAAAACIDAAAlgAvU3lzdGVtL0xpYnJhcnkvRnJhbWV3b3Jrcy9Db3JlRm91bmRhdGlvbi5mcmFt' +
        'ZXdvcmsvVmVyc2lvbnMvQS9Db3JlRm91bmRhdGlvbgAAAAwAAABoAAAAGAAAAAIAAAAAAMoEAAAB' +
        'AC9TeXN0ZW0vTGlicmFyeS9GcmFtZXdvcmtzL0NvcmVTZXJ2aWNlcy5mcmFtZXdvcmsvVmVyc2lv' +
        'bnMvQS9Db3JlU2VydmljZXMAAAAAAAAADAAAADAAAAAYAAAAAgAAAAwCAQAAAAEAL3Vzci9saWIv' +
        'bGliei4xLmR5bGliAAAADAAAADgAAAAYAAAAAgAAAAAARwUAAAEAL3Vzci9saWIvbGliU3lzdGVt' +
        'LkIuZHlsaWIAAAAAAAAYAACAYAAAABgAAAACAAAAAAsBAAACAQAvU3lzdGVtL0xpYnJhcnkvRnJh' +
        'bWV3b3Jrcy9RdWFydHpDb3JlLmZyYW1ld29yay9WZXJzaW9ucy9BL1F1YXJ0ekNvcmUAAAAYAACA' +
        'WAAAABgAAAACAAAAAAZvAQAAAQAvU3lzdGVtL0xpYnJhcnkvRnJhbWV3b3Jrcy9NZXRhbC5mcmFt' +
        'ZXdvcmsvVmVyc2lvbnMvQS9NZXRhbAAAAAAADAAAAGAAAAAYAAAAAgAAAAAAiAwAACwBL1N5c3Rl' +
        'bS9MaWJyYXJ5L0ZyYW1ld29ya3MvRm91bmRhdGlvbi5mcmFtZXdvcmsvVmVyc2lvbnMvQy9Gb3Vu' +
        'ZGF0aW9uAAAADAAAADgAAAAYAAAAAgAAAAAA5AAAAAEAL3Vzci9saWIvbGlib2JqYy5BLmR5bGli' +
        'AAAAAAAAAAAMAAAAOAAAABgAAAACAAAAAAAHAAAABwAvdXNyL2xpYi9saWJpY29udi4yLmR5bGli' +
        'AAAAAAAAABgAAIB4AAAAGAAAAAIAAAAAAoAAAAABAC9TeXN0ZW0vTGlicmFyeS9GcmFtZXdvcmtz' +
        'L01ldGFsUGVyZm9ybWFuY2VTaGFkZXJzLmZyYW1ld29yay9WZXJzaW9ucy9BL01ldGFsUGVyZm9y' +
        'bWFuY2VTaGFkZXJzABgAAIBoAAAAGAAAAAIAAAAHAmEHAABAAC9TeXN0ZW0vTGlicmFyeS9GcmFt' +
        'ZXdvcmtzL0NvcmVHcmFwaGljcy5mcmFtZXdvcmsvVmVyc2lvbnMvQS9Db3JlR3JhcGhpY3MAAAAA' +
        'AAAAJgAAABAAAABwau8E2DoDACkAAAAQAAAASKXyBAAAAAA=',
    ),
    (character) => character.charCodeAt(0),
  )
  const bytes = new Uint8Array(115060697)
  bytes.set(header)
  const report = inspectMachO(bytes, TARGET)
  assertEquals(report.signature, 'unsigned')
  assertEquals(report.architecture, 'x86_64')
  assertEquals(report.minimum_os, '12.0')
  assertEquals(
    report.load_commands_sha256,
    '7e3827009087b96b4e9143374d7238b4223f530834827b733bb195893afa0f08',
  )
  assertEquals(report.native_execution, 'not_performed')
})

Deno.test('unsigned Intel Mach-O keeps structural gates and never substitutes for an ARM signature', () => {
  const report = inspectMachO(unsignedIntelMachO(), TARGET)
  assertEquals(report.signature, 'unsigned')
  assertEquals(report.minimum_os, '12.0')
  assertEquals(report.native_execution, 'not_performed')
  const unsignedArm = unsignedIntelMachO()
  new DataView(unsignedArm.buffer).setUint32(4, 0x100000c, true)
  assertThrows(
    () => inspectMachO(unsignedArm, 'aarch64-apple-darwin'),
    Error,
    'requires an embedded ad-hoc signature',
  )
  for (
    const mutate of [
      (v: DataView) => v.setUint32(32 + 144 + 12, 0xd0000, true),
      (v: DataView) => v.setUint32(32 + 144 + 24, 0x1b, true),
      (v: DataView) => v.setBigUint64(32 + 144 + 24 + 8, 64n, true),
      (v: DataView) => v.setUint32(32 + 144 + 24 + 24, 0x22, true),
      (v: DataView) => v.setUint32(32 + 144 + 24 + 24, 0x8000001c, true),
      (v: DataView) => v.setBigUint64(32 + 72 + 40, 400n, true),
      (v: DataView) => v.setBigUint64(32 + 72 + 48, 63n, true),
      (v: DataView) => v.setUint32(4, 0x100000c, true),
    ]
  ) {
    const bytes = unsignedIntelMachO()
    mutate(new DataView(bytes.buffer))
    assertThrows(() => inspectMachO(bytes, TARGET))
  }
  const dependency = unsignedIntelMachO()
  dependency.set(
    new TextEncoder().encode('/tmp/lib/'),
    32 + 144 + 24 + 24 + 32 + 24,
  )
  assertThrows(
    () => inspectMachO(dependency, TARGET),
    Error,
    'non-system library',
  )
  assertThrows(() => inspectMachO(unsignedIntelMachO().slice(0, -1), TARGET))
  const trailing = new Uint8Array(577)
  trailing.set(unsignedIntelMachO())
  assertThrows(() => inspectMachO(trailing, TARGET), Error, 'extent differs')
})

Deno.test('Darwin inspection verifies actual ad-hoc pages without claiming native execution', () => {
  const report = inspectMachO(signedMachO(), TARGET)
  assertEquals(report.signature, 'ad-hoc-sha256-verified')
  assertEquals(report.minimum_os, '12.0')
  assertEquals(report.native_execution, 'not_performed')
  for (
    const mutate of [
      (b: Uint8Array) => {
        b[4] = 12
      },
      (b: Uint8Array) => {
        new DataView(b.buffer).setUint32(32 + 144 + 12, 0xd0000, true)
      },
      (b: Uint8Array) => {
        b[400] ^= 1
      },
      (b: Uint8Array) => {
        b[b.length - 1] ^= 1
      },
      (b: Uint8Array) => {
        new DataView(b.buffer).setUint32(36, 0xfffffff8, true)
      },
      (b: Uint8Array) => {
        new DataView(b.buffer).setUint32(532 + 32, 128)
      },
    ]
  ) {
    const bytes = signedMachO()
    mutate(bytes)
    assertThrows(() => inspectMachO(bytes, TARGET))
  }
  assertThrows(() => inspectMachO(signedMachO().subarray(0, 657), TARGET))
  assertThrows(() => inspectMachO(signedMachO(), 'aarch64-apple-darwin'))
  const arm = signedMachO()
  new DataView(arm.buffer).setUint32(4, 0x100000c, true)
  arm.set(createHash('sha256').update(arm.subarray(0, 512)).digest(), 532 + 94)
  assertEquals(
    inspectMachO(arm, 'aarch64-apple-darwin').signature,
    'ad-hoc-sha256-verified',
  )
  arm[400] ^= 1
  assertThrows(() => inspectMachO(arm, 'aarch64-apple-darwin'))
  const malformedPresentSignature = signedMachO()
  new DataView(malformedPresentSignature.buffer).setUint32(
    32 + 72 + 72 + 24 + 24 + 32 + 56 + 8,
    0,
    true,
  )
  assertThrows(() => inspectMachO(malformedPresentSignature, TARGET))
})

Deno.test('all products compile on Linux; ARM Linux executes only on native ARM', () => {
  assertProductHost(TARGET, 'linux', 'x86_64')
  assertProductHost('aarch64-apple-darwin', 'linux', 'x86_64')
  assertProductHost('aarch64-unknown-linux-gnu', 'linux', 'aarch64')
  assertThrows(() =>
    assertProductHost('aarch64-unknown-linux-gnu', 'linux', 'x86_64')
  )
  assertThrows(() => assertProductHost(TARGET, 'darwin', 'x86_64'))
})

function receipt(): CurrentProductReceipt {
  return {
    schema_version: 2,
    kind: 'slv-current-product-receipt',
    target: TARGET,
    source: {
      commit: SHA,
      ref: identity.sourceRef,
      lock_sha256: DIGEST,
      graph_sha256: DIGEST,
      sbom_sha256: DIGEST,
      notices_sha256: DIGEST,
      source_receipt_sha256: DIGEST,
      engine_sha256: DIGEST,
      bridge_source_sha256: DIGEST,
    },
    qualification: {
      identity: DIGEST,
      state: 'candidate-validation',
      baseline_denort_sha256: DIGEST,
      selected_lock_sha256: DIGEST,
      derived_lock_sha256: DIGEST,
      native_proof_sha256: DIGEST,
      build_receipt_sha256: DIGEST,
    },
    producer: {
      repository: 'ValidatorsDAO/slv',
      workflow: '.github/workflows/slv-remote-build.yml',
      workflow_sha: SHA,
      run_id: identity.runId,
      run_attempt: identity.runAttempt,
      job: `build-${TARGET}`,
      host_os: 'linux',
      host_arch: 'x86_64',
      profile: 'hosted-linux',
    },
    frontend: {
      version: '2.9.3',
      sha256: DIGEST,
      flags: compileFlags(TARGET, 'product'),
      bridge_flags: compileFlags(TARGET, 'bridge'),
    },
    output: {
      executable_sha256: DIGEST,
      archive_sha256: DIGEST,
      bridge_sha256: DIGEST,
      verification_sha256: DIGEST,
    },
    native_execution: 'not_performed',
  }
}

Deno.test('current receipt rejects fake native Darwin claims, matrix identity and unreviewed flags', () => {
  parseCurrentProductReceipt(receipt())
  for (
    const mutate of [
      (r: CurrentProductReceipt) => {
        r.native_execution = 'passed'
      },
      (r: CurrentProductReceipt) => {
        r.producer.job = 'build'
      },
      (r: CurrentProductReceipt) => {
        r.frontend.flags.splice(2, 1)
      },
      (r: CurrentProductReceipt) => {
        r.qualification.state = 'qualified' as never
      },
      (r: CurrentProductReceipt) => {
        r.producer.run_attempt = '0'
      },
      (r: CurrentProductReceipt) => {
        r.producer.run_attempt = 2 as never
      },
      (r: CurrentProductReceipt) => {
        r.output.bridge_sha256 = ''
      },
    ]
  ) {
    const r = receipt()
    mutate(r)
    assertThrows(() => parseCurrentProductReceipt(r))
  }
})

async function checkCurrentProductGate(
  signing: 'signed' | 'unsigned',
): Promise<void> {
  const root = await Deno.makeTempDir()
  try {
    const base = `${root}/dist/release-inputs/product-runtime/${TARGET}`
    await Deno.mkdir(base, { recursive: true })
    await Deno.mkdir(`${root}/cli/lib/release`, { recursive: true })
    const r = receipt()
    const files = {
      'deno.lock': 'lock',
      'dist/release-inputs/compiled-module-graph.json': 'graph',
      'dist/release-inputs/THIRD_PARTY_NOTICES': 'notice',
      'dist/release-inputs/source-materials-receipt.json': 'source',
      'cli/lib/release/engine.py': 'engine',
      'cli/lib/release/compiled_bridge_smoke.ts': 'bridge source',
    }
    for (const [path, value] of Object.entries(files)) {
      await Deno.writeTextFile(`${root}/${path}`, value)
    }
    for (
      const [field, path] of Object.entries({
        lock_sha256: 'deno.lock',
        graph_sha256: 'dist/release-inputs/compiled-module-graph.json',
        notices_sha256: 'dist/release-inputs/THIRD_PARTY_NOTICES',
        source_receipt_sha256:
          'dist/release-inputs/source-materials-receipt.json',
        engine_sha256: 'cli/lib/release/engine.py',
        bridge_source_sha256: 'cli/lib/release/compiled_bridge_smoke.ts',
      })
    ) {
      ;(r.source as unknown as Record<string, string>)[field] = await hashFile(
        `${root}/${path}`,
      )
    }
    const exe = `${root}/dist/slv-${TARGET}-exe`
    await Deno.writeFile(
      exe,
      signing === 'signed' ? signedMachO() : unsignedIntelMachO(),
    )
    await packExecutable(exe, `${exe}.tar.gz`, `slv-${TARGET}-exe`)
    await Deno.writeTextFile(`${base}/release-bridge-smoke`, 'fresh bridge')
    await Deno.mkdir(`${root}/source-materials`, { recursive: true })
    await Deno.writeTextFile(
      `${root}/source-materials/runtime-revocations.json`,
      '{"schema_version":1,"revoked_identities":[]}',
    )
    await Deno.writeTextFile(
      `${base}/product-verification.json`,
      JSON.stringify({
        runtime_revocation: {
          reviewed_checkout_policy: await checkReviewedRuntimeRevocation(
            DIGEST,
            root,
          ),
          current_main_policy: null,
        },
      }),
    )
    r.output = {
      executable_sha256: await hashFile(exe),
      archive_sha256: await hashFile(`${exe}.tar.gz`),
      bridge_sha256: await hashFile(`${base}/release-bridge-smoke`),
      verification_sha256: await hashFile(
        `${base}/product-verification.json`,
      ),
    }
    await Deno.writeTextFile(
      `${base}/product-runtime-receipt.json`,
      JSON.stringify(r),
    )
    const qualified = {
      identity: DIGEST,
      state: 'candidate-validation' as const,
      runtime: { sha256: DIGEST },
      selectedLock: { sha256: DIGEST },
      derivedLock: { sha256: DIGEST },
      proof: { sha256: DIGEST },
      buildReceipt: { sha256: DIGEST },
    }
    await verifyCurrentProductFiles(root, TARGET, identity, qualified)
    for (const [path, value] of Object.entries(files)) {
      await Deno.writeTextFile(`${root}/${path}`, value + ' tampered')
      await assertRejects(() =>
        verifyCurrentProductFiles(root, TARGET, identity, qualified)
      )
      await Deno.writeTextFile(`${root}/${path}`, value)
    }
    for (
      const changed of [
        { ...identity, sourceSha: 'c'.repeat(40) },
        { ...identity, runAttempt: '3' },
        { ...identity, runId: '124' },
        { ...identity, workflowSha: 'd'.repeat(40) },
      ]
    ) {
      await assertRejects(() =>
        verifyCurrentProductFiles(root, TARGET, changed, qualified)
      )
    }
    await assertRejects(() =>
      verifyCurrentProductFiles(root, TARGET, identity, {
        ...qualified,
        runtime: { sha256: 'c'.repeat(64) },
      })
    )
    await assertRejects(() =>
      verifyCurrentProductFiles(root, TARGET, identity, {
        ...qualified,
        state: 'final-qualified',
      })
    )
    await Deno.writeTextFile(
      `${base}/release-bridge-smoke`,
      'stale old bridge',
    )
    await assertRejects(() =>
      verifyCurrentProductFiles(root, TARGET, identity, qualified)
    )
    await Deno.writeTextFile(`${base}/release-bridge-smoke`, 'fresh bridge')
    if (signing === 'unsigned') {
      const changed = unsignedIntelMachO()
      changed[400] ^= 1
      // Static shape is not a code signature: the separately bound executable
      // digest still rejects changed bytes, even with an updated archive digest.
      assertEquals(inspectMachO(changed, TARGET).signature, 'unsigned')
      await Deno.writeFile(exe, changed)
      await packExecutable(exe, `${exe}.tar.gz`, `slv-${TARGET}-exe`)
      r.output.archive_sha256 = await hashFile(`${exe}.tar.gz`)
      await Deno.writeTextFile(
        `${base}/product-runtime-receipt.json`,
        JSON.stringify(r),
      )
      await assertRejects(
        () => verifyCurrentProductFiles(root, TARGET, identity, qualified),
        Error,
        'output bytes differ',
      )
    }
    await Deno.writeTextFile(`${exe}.tar.gz`, 'different archive')
    await assertRejects(() =>
      verifyCurrentProductFiles(root, TARGET, identity, qualified)
    )
  } finally {
    await Deno.remove(root, { recursive: true })
  }
}

for (const signing of ['signed', 'unsigned'] as const) {
  Deno.test(`current ${signing} product gate rejects changed app inputs, archive, bridge, producer and runtime`, () =>
    checkCurrentProductGate(signing))
}

Deno.test('signed qualification reference binds four complete receipts and rejects candidate release', async () => {
  const targets = [
    'x86_64-unknown-linux-gnu',
    'aarch64-unknown-linux-gnu',
    'x86_64-apple-darwin',
    'aarch64-apple-darwin',
  ] as const
  const products = targets.map((target) => {
    const r = receipt()
    r.target = target
    r.producer.job = `build-${target}`
    r.producer.host_arch = target === 'aarch64-unknown-linux-gnu'
      ? 'aarch64'
      : 'x86_64'
    r.native_execution = target.endsWith('linux-gnu')
      ? 'passed'
      : 'not_performed'
    r.frontend.flags = compileFlags(target, 'product')
    r.frontend.bridge_flags = compileFlags(target, 'bridge')
    return { receipt: r, receipt_sha256: hash(canonicalReceipt(r)) }
  })
  const q = {
    identity: DIGEST,
    tag: `runtime-deno-v2.9.3-${DIGEST}`,
    manifest_sha256: DIGEST,
    state: 'candidate-validation' as const,
    products,
  }
  validateQualificationReference(q, { ...identity, release: false })
  assertThrows(() =>
    validateQualificationReference(q, { ...identity, release: true })
  )
  assertThrows(() =>
    validateQualificationReference({ ...q, products: products.slice(1) })
  )
  const changed = structuredClone(q)
  changed.products[0].receipt.output.executable_sha256 = 'd'.repeat(64)
  assertThrows(() => validateQualificationReference(changed))
  const assets = payloadSpecs().map((spec) => ({
    ...spec,
    sha256: DIGEST,
    size: 1,
  }))
  assertThrows(() =>
    manifest('2026.10.18.1234', SHA, 'refs/heads/main', '123', '2', assets, q)
  )
  const final = {
    ...q,
    state: 'final-qualified' as const,
    products: products.map(({ receipt }) => {
      const r = structuredClone(receipt)
      r.qualification.state = 'final-qualified'
      r.source.ref = 'refs/heads/main'
      r.producer.run_attempt = '1'
      r.producer.profile = r.target === 'aarch64-unknown-linux-gnu'
        ? 'linux-arm64-4'
        : 'linux-16'
      return { receipt: r, receipt_sha256: hash(canonicalReceipt(r)) }
    }),
  }
  const published = manifest(
    '2026.10.18.1234',
    SHA,
    'refs/heads/main',
    '123',
    '2',
    assets,
    final,
  )
  assertEquals(published.schema_version, 2)
  for (
    const mutate of [
      (r: CurrentProductReceipt) => {
        r.producer.profile = 'hosted-linux'
      },
      (r: CurrentProductReceipt) => {
        r.source.sbom_sha256 = 'c'.repeat(64)
      },
      (r: CurrentProductReceipt) => {
        r.source.graph_sha256 = 'c'.repeat(64)
      },
    ]
  ) {
    const bad = structuredClone(final)
    mutate(bad.products[0].receipt)
    bad.products[0].receipt_sha256 = hash(
      canonicalReceipt(bad.products[0].receipt),
    )
    assertThrows(() =>
      manifest(
        '2026.10.18.1234',
        SHA,
        'refs/heads/main',
        '123',
        '2',
        assets,
        bad,
      )
    )
  }

  const future = structuredClone(final)
  future.products[0].receipt.producer.run_attempt = '3'
  future.products[0].receipt_sha256 = hash(
    canonicalReceipt(future.products[0].receipt),
  )
  assertThrows(() =>
    manifest(
      '2026.10.18.1234',
      SHA,
      'refs/heads/main',
      '123',
      '2',
      assets,
      future,
    )
  )
  const temporary = await Deno.makeTempDir()
  try {
    const existing = `${temporary}/existing.json`,
      staged = `${temporary}/staged.json`
    await Deno.writeTextFile(existing, JSON.stringify(published))
    await Deno.writeTextFile(staged, JSON.stringify(published))
    await guardDraftManifest(existing, staged)
    const changed = structuredClone(final)
    changed.products[0].receipt.output.bridge_sha256 = 'c'.repeat(64)
    changed.products[0].receipt_sha256 = hash(
      canonicalReceipt(changed.products[0].receipt),
    )
    await Deno.writeTextFile(
      staged,
      JSON.stringify(
        manifest(
          '2026.10.18.1234',
          SHA,
          'refs/heads/main',
          '123',
          '2',
          assets,
          changed,
        ),
      ),
    )
    await assertRejects(() => guardDraftManifest(existing, staged))
    await Deno.writeTextFile(
      staged,
      JSON.stringify(
        manifest(
          '2026.10.18.1234',
          SHA,
          'refs/heads/main',
          '123',
          '3',
          assets,
          final,
        ),
      ),
    )
    await assertRejects(() => guardDraftManifest(existing, staged))
  } finally {
    await Deno.remove(temporary, { recursive: true })
  }
})
