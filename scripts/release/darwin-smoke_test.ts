import { assertEquals, assertRejects, assertThrows } from 'jsr:@std/assert@1'
import { createHash } from 'node:crypto'
import {
  assertNativeHost,
  assertSmokeContext,
  executeSmoke,
  extractSmokeZip,
  parseSmokeInput,
  productMembers,
  sandboxExecutor,
  sandboxProfile,
  type SmokeInput,
  systemPython,
  verifySmokeFiles,
  verifySmokeOutput,
  verifySmokeProvenance,
} from './darwin-smoke.ts'
import {
  compileFlags,
  type CurrentProductReceipt,
  inspectMachO,
} from './build-product.ts'
import { canonicalReceipt, hashFile, packExecutable } from './release.ts'
import {
  qualificationIdentity,
  readQualificationManifest,
} from './runtime-qualification.ts'
import { checkReviewedRuntimeRevocation } from './runtime-revocations.ts'

const encoder = new TextEncoder(), decoder = new TextDecoder()
const digest = (value: string | Uint8Array) =>
  createHash('sha256').update(value).digest('hex')
const TARGET = 'x86_64-apple-darwin' as const
const SHA = 'a'.repeat(40), HASH = 'b'.repeat(64)
function input(): SmokeInput {
  return {
    target: TARGET,
    source_sha: SHA,
    workflow_sha: SHA,
    ref: 'refs/heads/codex/validation',
    run_id: '123',
    run_attempt: '2',
    reviewed_sha: SHA,
    title: `SLV release build validation ${SHA}`,
    qualification_identity: HASH,
    product: {
      artifact_id: '10',
      artifact_sha256: HASH,
      receipt_sha256: HASH,
      producer_attempt: '2',
    },
    notices: {
      artifact_id: '11',
      artifact_sha256: HASH,
      producer_attempt: '2',
      sha256: HASH,
    },
  }
}
function environment(i: SmokeInput): Record<string, string> {
  return {
    GITHUB_REPOSITORY: 'ValidatorsDAO/slv',
    GITHUB_EVENT_NAME: 'workflow_dispatch',
    GITHUB_SHA: i.source_sha,
    GITHUB_WORKFLOW_SHA: i.workflow_sha,
    GITHUB_REF: i.ref,
    GITHUB_WORKFLOW_REF:
      `ValidatorsDAO/slv/.github/workflows/slv-remote-build.yml@${i.ref}`,
    GITHUB_RUN_ID: i.run_id,
    GITHUB_RUN_ATTEMPT: i.run_attempt,
    GITHUB_JOB: `validation-smoke-${i.target}`,
    SLV_OPERATION: 'release-build-validation',
    SLV_RESOLVED_MODE: 'release-build-validation',
    SLV_PUBLICATION: 'none',
    SLV_RESOLVED_SOURCE_SHA: i.source_sha,
  }
}
function provenance(i: SmokeInput) {
  const run = {
    id: 123,
    run_attempt: 2,
    event: 'workflow_dispatch',
    head_sha: SHA,
    head_branch: 'codex/validation',
    path: '.github/workflows/slv-remote-build.yml',
    display_title: i.title,
    repository: { full_name: 'ValidatorsDAO/slv', id: 1 },
    head_repository: { full_name: 'ValidatorsDAO/slv' },
    status: 'in_progress',
  }
  const jobs = {
    total_count: 5,
    jobs: ['resolve', 'runtime-qualification', 'test', `build-${TARGET}`].map((
      name,
    ) => ({
      name,
      run_id: 123,
      run_attempt: 2,
      head_sha: SHA,
      status: 'completed',
      conclusion: 'success',
    })),
  }
  jobs.jobs.push({
    name: `validation-smoke-${TARGET}`,
    run_id: 123,
    run_attempt: 2,
    head_sha: SHA,
    status: 'in_progress',
    conclusion: '',
  })
  const artifact = {
    expired: false,
    expires_at: '2099-01-01T00:00:00Z',
    digest: `sha256:${HASH}`,
    size_in_bytes: 100,
    workflow_run: {
      id: 123,
      head_sha: SHA,
      repository_id: 1,
      head_repository_id: 1,
    },
  }
  return {
    run,
    jobs,
    product: { ...artifact, id: 10, name: `slv-product-${TARGET}-123-2` },
    notices: { ...artifact, id: 11, name: 'slv-license-evidence-123-2' },
  }
}
Deno.test('Darwin smoke admits only the exact nonpublishing validation context and current producer attempt', () => {
  const i = parseSmokeInput(input()), env = environment(i)
  assertSmokeContext(i, (key) => env[key])
  for (
    const [key, value] of [
      ['GITHUB_EVENT_NAME', 'pull_request'],
      ['GITHUB_EVENT_NAME', 'push'],
      ['SLV_OPERATION', 'release'],
      ['SLV_PUBLICATION', 'publish'],
      ['GITHUB_SHA', 'c'.repeat(40)],
      ['GITHUB_WORKFLOW_SHA', 'c'.repeat(40)],
      ['ACTIONS_ID_TOKEN_REQUEST_TOKEN', 'sentinel'],
      ['SLV_R2_CREDENTIALS_JSON', 'sentinel'],
    ]
  ) {
    assertThrows(() =>
      assertSmokeContext(i, (name) => name === key ? value : env[name])
    )
  }
  for (
    const change of [(v: SmokeInput) => {
      v.product.producer_attempt = '1'
    }, (v: SmokeInput) => {
      v.notices.producer_attempt = '1'
    }, (v: SmokeInput) => {
      v.product.receipt_sha256 = ''
    }, (v: SmokeInput) => {
      v.workflow_sha = 'c'.repeat(40)
    }]
  ) {
    const altered = input()
    change(altered)
    assertThrows(() => parseSmokeInput(altered))
  }
})
Deno.test('artifact metadata binds actual dispatch run, exact jobs, ZIP IDs/digests and nonexpiry', () => {
  const i = input(), p = provenance(i)
  verifySmokeProvenance(i, p.run, p.jobs, p.product, p.notices)
  for (
    const change of [
      (v: typeof p) => {
        v.product.workflow_run.id = 124
      },
      (v: typeof p) => {
        v.run.head_sha = 'c'.repeat(40)
      },
      (v: typeof p) => {
        v.product.digest = 'sha256:' + 'c'.repeat(64)
      },
      (v: typeof p) => {
        v.notices.expired = true
      },
      (v: typeof p) => {
        v.product.name = `slv-product-${TARGET}-123-1`
      },
      (v: typeof p) => {
        v.jobs.jobs[3].run_attempt = 1
      },
      (v: typeof p) => {
        v.jobs.jobs[3].conclusion = 'failure'
      },
      (v: typeof p) => {
        v.jobs.total_count++
      },
    ]
  ) {
    const altered = structuredClone(p)
    change(altered)
    assertThrows(() =>
      verifySmokeProvenance(
        i,
        altered.run,
        altered.jobs,
        altered.product,
        altered.notices,
      )
    )
  }
})

async function zip(
  path: string,
  entries: Array<{ name: string; mode?: number; content?: string }>,
): Promise<void> {
  const child = new Deno.Command('/usr/bin/python3', {
    args: [
      '-I',
      '-c',
      "import json,sys,zipfile;z=zipfile.ZipFile(sys.argv[1],'w');\nfor r in json.load(sys.stdin):\n i=zipfile.ZipInfo(r['name']);i.external_attr=r.get('mode',33152)<<16;z.writestr(i,r.get('content','bytes'))\nz.close()",
      path,
    ],
    stdin: 'piped',
    stdout: 'null',
    stderr: 'null',
  }).spawn()
  const writer = child.stdin.getWriter()
  await writer.write(encoder.encode(JSON.stringify(entries)))
  await writer.close()
  if (!(await child.status).success) throw new Error('fixture ZIP failed')
}
Deno.test('ZIP boundary rejects traversal, symlinks, extras, duplicates and file ancestors before extraction', async () => {
  const root = await Deno.makeTempDir()
  try {
    const members = productMembers(TARGET),
      good = Object.keys(members).map((name) => ({ name }))
    for (
      const [index, entries] of [
        good,
        [...good, { name: '../escape' }],
        [...good, { name: '/absolute' }],
        [...good, { name: 'bad\\path' }],
        [...good, { ...good[0] }],
        [...good, { name: 'extra' }],
        good.map((entry, index) =>
          index === 0 ? { ...entry, mode: 0o120777 } : entry
        ),
        [...good, { name: 'release-inputs', mode: 0o100600 }],
      ].entries()
    ) {
      const path = `${root}/${index}.zip`, out = `${root}/out-${index}`
      await Deno.mkdir(out)
      await zip(path, entries)
      if (!index) await extractSmokeZip(path, out, members, 4096)
      else {
        await assertRejects(() => extractSmokeZip(path, out, members, 4096))
        assertEquals(Array.from(Deno.readDirSync(out)).length, 0)
      }
    }
  } finally {
    await Deno.remove(root, { recursive: true })
  }
})

function macho(): Uint8Array {
  const commands: Uint8Array[] = []
  const cmd = (kind: number, size: number) => {
    const bytes = new Uint8Array(size), view = new DataView(bytes.buffer)
    view.setUint32(0, kind, true)
    view.setUint32(4, size, true)
    commands.push(bytes)
    return { bytes, view }
  }
  const text = cmd(0x19, 72)
  text.bytes.set(encoder.encode('__TEXT'), 8)
  text.view.setBigUint64(48, 512n, true)
  text.view.setUint32(60, 5, true)
  const link = cmd(0x19, 72)
  link.bytes.set(encoder.encode('__LINKEDIT'), 8)
  link.view.setBigUint64(40, 512n, true)
  link.view.setBigUint64(48, 146n, true)
  const minimum = cmd(0x32, 24)
  minimum.view.setUint32(8, 1, true)
  minimum.view.setUint32(12, 0xc0000, true)
  cmd(0x80000028, 24).view.setBigUint64(8, 400n, true)
  const dyld = cmd(0xe, 32)
  dyld.view.setUint32(8, 12, true)
  dyld.bytes.set(encoder.encode('/usr/lib/dyld'), 12)
  const library = cmd(0xc, 56)
  library.view.setUint32(8, 24, true)
  library.bytes.set(encoder.encode('/usr/lib/libSystem.B.dylib'), 24)
  const signature = cmd(0x1d, 16)
  signature.view.setUint32(8, 512, true)
  signature.view.setUint32(12, 146, true)
  const bytes = new Uint8Array(658), view = new DataView(bytes.buffer)
  for (
    const [offset, value] of [[0, 0xfeedfacf], [4, 0x1000007], [12, 2], [
      16,
      commands.length,
    ], [20, commands.reduce((sum, bytes) => sum + bytes.length, 0)]]
  ) view.setUint32(offset, value, true)
  let offset = 32
  for (const command of commands) {
    bytes.set(command, offset)
    offset += command.length
  }
  for (
    const [offset, value] of [
      [512, 0xfade0cc0],
      [516, 146],
      [520, 1],
      [528, 20],
      [532, 0xfade0c02],
      [536, 126],
      [540, 0x20400],
      [544, 2],
      [548, 94],
      [552, 88],
      [560, 1],
      [564, 512],
    ]
  ) view.setUint32(offset, value)
  bytes[568] = 32
  bytes[569] = 2
  bytes[571] = 12
  bytes.set(encoder.encode('a.out\0'), 620)
  bytes.set(createHash('sha256').update(bytes.subarray(0, 512)).digest(), 626)
  return bytes
}
async function fixture() {
  const parent = await Deno.realPath(await Deno.makeTempDir()),
    root = `${parent}/repo`,
    work = `${parent}/work`,
    output = `${parent}/receipt.json`
  await Deno.mkdir(root)
  await Deno.mkdir(work, { mode: 0o700 })
  const copy = async (path: string) => {
    await Deno.mkdir(`${root}/${path.slice(0, path.lastIndexOf('/'))}`, {
      recursive: true,
    })
    await Deno.copyFile(path, `${root}/${path}`)
  }
  const descriptor = await readQualificationManifest(
    'source-materials/runtime-qualification.json',
  )
  for (
    const path of [
      ...Object.keys(descriptor.compatibility.runtime_inputs),
      'source-materials/runtime-qualification.json',
      'source-materials/runtime-revocations.json',
      'deno.lock',
      'cli/lib/release/engine.py',
      'cli/lib/release/compiled_bridge_smoke.ts',
      'cli/deno.json',
      'cmn/constants/version.ts',
    ]
  ) await copy(path)
  const i = input()
  i.qualification_identity = qualificationIdentity(descriptor)
  await Deno.writeTextFile(`${work}/product.zip`, 'product ZIP pinned fixture')
  await Deno.writeTextFile(`${work}/notices.zip`, 'notices ZIP pinned fixture')
  i.product.artifact_sha256 = await hashFile(`${work}/product.zip`)
  i.notices.artifact_sha256 = await hashFile(`${work}/notices.zip`)
  const notice = 'Current canonical notices\n'
  await Deno.writeTextFile(`${work}/THIRD_PARTY_NOTICES`, notice)
  i.notices.sha256 = digest(notice)
  await Deno.writeTextFile(
    `${work}/license-bundle.json`,
    JSON.stringify({
      schema_version: 1,
      source_sha: SHA,
      producer_run_id: '123',
      producer_run_attempt: 2,
      filename: 'THIRD_PARTY_NOTICES',
      size: encoder.encode(notice).length,
      sha256: i.notices.sha256,
    }),
  )
  const bytes = macho()
  await Deno.writeFile(`${work}/input`, bytes)
  await packExecutable(
    `${work}/input`,
    `${work}/product.tar.gz`,
    `slv-${TARGET}-exe`,
  )
  await Deno.remove(`${work}/input`)
  await Deno.writeFile(`${work}/bridge`, bytes)
  await Deno.writeTextFile(
    `${work}/product-verification.json`,
    JSON.stringify({
      kind: 'slv-current-darwin-verification',
      executable: inspectMachO(bytes, TARGET),
      bridge: inspectMachO(bytes, TARGET),
      native_execution: 'not_performed',
      runtime_revocation: {
        reviewed_checkout_policy: await checkReviewedRuntimeRevocation(
          i.qualification_identity,
          root,
        ),
        current_main_policy: null,
      },
    }),
  )
  const target = descriptor.targets.find((row) => row.target === TARGET)!
  const receipt: CurrentProductReceipt = {
    schema_version: 2,
    kind: 'slv-current-product-receipt',
    target: TARGET,
    source: {
      commit: SHA,
      ref: i.ref,
      lock_sha256: await hashFile(`${root}/deno.lock`),
      graph_sha256: HASH,
      sbom_sha256: HASH,
      notices_sha256: i.notices.sha256,
      source_receipt_sha256: HASH,
      engine_sha256: await hashFile(`${root}/cli/lib/release/engine.py`),
      bridge_source_sha256: await hashFile(
        `${root}/cli/lib/release/compiled_bridge_smoke.ts`,
      ),
    },
    qualification: {
      identity: i.qualification_identity,
      state: 'candidate-validation',
      baseline_denort_sha256: descriptor.assets[target.runtime].sha256,
      selected_lock_sha256:
        descriptor.assets[descriptor.source.selected_lock].sha256,
      derived_lock_sha256: descriptor.assets[target.derived_lock].sha256,
      native_proof_sha256: descriptor.assets[target.proof].sha256,
      build_receipt_sha256: descriptor.assets[target.build_receipt].sha256,
    },
    producer: {
      repository: 'ValidatorsDAO/slv',
      workflow: '.github/workflows/slv-remote-build.yml',
      workflow_sha: SHA,
      run_id: '123',
      run_attempt: '2',
      job: `build-${TARGET}`,
      host_os: 'linux',
      host_arch: 'x86_64',
      profile: 'linux-16',
    },
    frontend: {
      version: '2.9.3',
      sha256:
        descriptor.compatibility.frontend['x86_64-unknown-linux-gnu'].sha256,
      flags: compileFlags(TARGET, 'product'),
      bridge_flags: compileFlags(TARGET, 'bridge'),
    },
    output: {
      executable_sha256: digest(bytes),
      archive_sha256: await hashFile(`${work}/product.tar.gz`),
      bridge_sha256: digest(bytes),
      verification_sha256: await hashFile(`${work}/product-verification.json`),
    },
    native_execution: 'not_performed',
  }
  await Deno.writeTextFile(
    `${work}/product-runtime-receipt.json`,
    JSON.stringify(receipt),
  )
  i.product.receipt_sha256 = await hashFile(
    `${work}/product-runtime-receipt.json`,
  )
  await Deno.writeTextFile(
    `${work}/prepared.json`,
    JSON.stringify({
      input_sha256: digest(canonicalReceipt(i)),
      receipt: { status: 'prepared', cases: [] },
    }),
  )
  return { parent, root, work, output, i, receipt, notice }
}
Deno.test('wrong-byte/source/attempt/target fixtures are rejected before any executable is invoked', async () => {
  const f = await fixture(),
    saved: Record<string, string | undefined> = {},
    env = environment(f.i)
  for (const [key, value] of Object.entries(env)) {
    saved[key] = Deno.env.get(key)
    Deno.env.set(key, value)
  }
  let executed = 0
  const executor = async () => {
    executed++
    return {
      exit_code: 0,
      timed_out: false,
      duration_ms: 1,
      stdout: new Uint8Array(),
      stderr: new Uint8Array(),
    }
  }
  try {
    await verifySmokeFiles(f.i, f.root, f.work)
    for (
      const name of [
        'product.zip',
        'product.tar.gz',
        'bridge',
        'executable',
        'THIRD_PARTY_NOTICES',
        'product-verification.json',
      ]
    ) {
      const path = `${f.work}/${name}`, original = await Deno.readFile(path)
      const altered = original.slice()
      altered[0] ^= 1
      await Deno.writeFile(path, altered)
      await assertRejects(() =>
        executeSmoke(f.i, f.root, f.work, f.output, { executor })
      )
      assertEquals(executed, 0)
      await Deno.writeFile(path, original)
    }
    const original = await Deno.readTextFile(
      `${f.work}/product-runtime-receipt.json`,
    )
    for (
      const mutate of [(r: CurrentProductReceipt) => {
        r.source.commit = 'c'.repeat(40)
      }, (r: CurrentProductReceipt) => {
        r.producer.run_attempt = '1'
      }, (r: CurrentProductReceipt) => {
        r.target = 'aarch64-apple-darwin'
      }, (r: CurrentProductReceipt) => {
        r.source.bridge_source_sha256 = 'c'.repeat(64)
      }, (r: CurrentProductReceipt) => {
        r.qualification.identity = 'c'.repeat(64)
      }]
    ) {
      const r = structuredClone(f.receipt)
      mutate(r)
      await Deno.writeTextFile(
        `${f.work}/product-runtime-receipt.json`,
        JSON.stringify(r),
      )
      const alteredInput = structuredClone(f.i)
      alteredInput.product.receipt_sha256 = await hashFile(
        `${f.work}/product-runtime-receipt.json`,
      )
      await Deno.writeTextFile(
        `${f.work}/prepared.json`,
        JSON.stringify({
          input_sha256: digest(canonicalReceipt(alteredInput)),
          receipt: { status: 'prepared', cases: [] },
        }),
      )
      await assertRejects(() =>
        executeSmoke(alteredInput, f.root, f.work, f.output, { executor })
      )
      assertEquals(executed, 0)
    }
    await Deno.writeTextFile(`${f.work}/product-runtime-receipt.json`, original)
    await Deno.writeTextFile(
      `${f.work}/prepared.json`,
      JSON.stringify({
        input_sha256: digest(canonicalReceipt(f.i)),
        receipt: { status: 'prepared', cases: [], injected_path: f.parent },
      }),
    )
    const argsSeen: string[][] = []
    const version =
      JSON.parse(await Deno.readTextFile(`${f.root}/cli/deno.json`)).version
    await executeSmoke(f.i, f.root, f.work, f.output, {
      host: async () => ({
        os: 'darwin',
        architecture: 'x86_64',
        process_architecture: 'x86_64',
        os_version: '15.7.1',
        os_build: '24G231',
        translated: false,
        translation_probe: 'native',
      }),
      executor: async (request) => {
        argsSeen.push(request.args)
        const output = request.args[0] === '--version'
          ? `slv ${version}\n`
          : request.args[0] === '--help'
          ? 'Usage: slv\nslv is a Toolkit for Solana Developers\nlicenses\n'
          : request.args[0] === 'licenses'
          ? f.notice
          : 'release bridge smoke passed (compiled)\n'
        assertEquals(request.timeout_ms, 30_000)
        if (request.args[0] === 'licenses') {
          assertEquals(
            request.maximum_output,
            encoder.encode(f.notice).length + 1,
          )
        }
        return {
          exit_code: 0,
          timed_out: false,
          duration_ms: 1,
          stdout: encoder.encode(output),
          stderr: new Uint8Array(),
        }
      },
    })
    assertEquals(argsSeen, [['--version'], ['--help'], ['licenses'], []])
    const reported = await Deno.readTextFile(f.output)
    assertEquals(JSON.parse(reported).status, 'passed')
    assertEquals(reported.includes(f.parent), false)
    assertEquals(JSON.parse(reported).cases.length, 4)
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) Deno.env.delete(key)
      else Deno.env.set(key, value)
    }
    await Deno.remove(f.parent, { recursive: true })
  }
})
Deno.test('native identity rejects translated Intel and inverse architecture independent of Mach-O format', () => {
  const intel = {
    os: 'darwin',
    arch: 'x86_64',
    uname: 'x86_64',
    hardwareArm: '0',
    translated: '',
    translatedExit: 1,
    version: '15.7.1',
    build: '24G231',
  }
  assertEquals(
    assertNativeHost(TARGET, intel).translation_probe,
    'unavailable-native-intel',
  )
  assertThrows(() =>
    assertNativeHost(TARGET, {
      ...intel,
      hardwareArm: '1',
      translated: '1',
      translatedExit: 0,
    })
  )
  assertThrows(() => assertNativeHost('aarch64-apple-darwin', intel))
  assertThrows(() => assertNativeHost(TARGET, { ...intel, os: 'linux' }))
})
Deno.test('each native command requires explicit output, including notices larger than one MiB', () => {
  const notices = encoder.encode('N'.repeat(2 * 1024 * 1024))
  const result = (text: string | Uint8Array) => ({
    exit_code: 0,
    timed_out: false,
    duration_ms: 1,
    stdout: typeof text === 'string' ? encoder.encode(text) : text,
    stderr: new Uint8Array(),
  })
  verifySmokeOutput(
    'version',
    result('slv 2026.10.17.2011\n'),
    '2026.10.17.2011',
    notices,
  )
  verifySmokeOutput(
    'help',
    result('Usage: slv\nslv is a Toolkit for Solana Developers\nlicenses\n'),
    '2026.10.17.2011',
    notices,
  )
  verifySmokeOutput('licenses', result(notices), '2026.10.17.2011', notices)
  verifySmokeOutput(
    'bridge',
    result('release bridge smoke passed (compiled)\n'),
    '2026.10.17.2011',
    notices,
  )
  assertThrows(() =>
    verifySmokeOutput(
      'version',
      result('slv 2026.6.6.2026\n'),
      '2026.10.17.2011',
      notices,
    )
  )
  assertThrows(() =>
    verifySmokeOutput('help', result('hello'), '2026.10.17.2011', notices)
  )
  assertThrows(() =>
    verifySmokeOutput('bridge', result('passed\n'), '2026.10.17.2011', notices)
  )
  assertThrows(() =>
    verifySmokeOutput(
      'licenses',
      result('N'.repeat(notices.length + 1)),
      '2026.10.17.2011',
      notices,
    )
  )
  assertThrows(() =>
    verifySmokeOutput(
      'bridge',
      {
        ...result('release bridge smoke passed (compiled)\n'),
        timed_out: true,
      },
      '',
      notices,
    )
  )
})

Deno.test({
  name:
    'Mac sandbox permits scratch, denies outside writes/read/network and kills timeout descendants',
  ignore: Deno.build.os !== 'darwin',
  fn: async () => {
    const root = await Deno.realPath(await Deno.makeTempDir()),
      payload = `${root}/payload`,
      scratch = `${root}/scratch`
    await Deno.mkdir(payload)
    await Deno.mkdir(scratch)
    await Deno.writeTextFile(`${root}/credential-sentinel`, 'not a secret')
    try {
      const python = await systemPython(),
        profile = sandboxProfile(payload, scratch)
      const source =
        `import json,socket,sys\nr={}\nopen(sys.argv[1],'w').write('ok')\nr['scratch_write']=True\nfor key,path,mode in [('outside_write_denied',sys.argv[2],'w'),('credential_read_denied',sys.argv[3],'r')]:\n try:open(path,mode);r[key]=False\n except PermissionError:r[key]=True\ns=socket.socket()\ntry:s.connect(('127.0.0.1',9));r['network_denied']=False\nexcept PermissionError:r['network_denied']=True\nfinally:s.close()\nprint(json.dumps(r))`
      const base = {
        executable: python.executable,
        profile,
        cwd: scratch,
        temporary: scratch,
        timeout_ms: 2_000,
        maximum_output: 4096,
      }
      const result = await sandboxExecutor({
        ...base,
        args: [
          '-I',
          '-c',
          source,
          `${scratch}/allowed`,
          `${root}/outside`,
          `${root}/credential-sentinel`,
        ],
      })
      assertEquals(result.exit_code, 0)
      assertEquals(JSON.parse(decoder.decode(result.stdout)), {
        scratch_write: true,
        outside_write_denied: true,
        credential_read_denied: true,
        network_denied: true,
      })
      const timed = await sandboxExecutor({
        ...base,
        args: [
          '-I',
          '-c',
          "import subprocess,sys,time;p=subprocess.Popen([sys.executable,'-I','-c','import time;time.sleep(20)']);open(sys.argv[1],'w').write(str(p.pid));time.sleep(20)",
          `${scratch}/descendant-pid`,
        ],
        timeout_ms: 200,
      })
      assertEquals(timed.timed_out, true)
      const pid = (await Deno.readTextFile(`${scratch}/descendant-pid`)).trim()
      if (!/^[1-9]\d*$/.test(pid)) throw new Error('invalid fixture process ID')
      let gone = false
      for (let attempt = 0; attempt < 20; attempt++) {
        const process = await new Deno.Command('/bin/ps', {
          args: ['-p', pid, '-o', 'stat='],
          stdout: 'piped',
          stderr: 'null',
        }).output()
        if (!decoder.decode(process.stdout).trim()) {
          gone = true
          break
        }
        await new Promise((resolve) => setTimeout(resolve, 25))
      }
      assertEquals(gone, true)
      await assertRejects(() =>
        sandboxExecutor({
          ...base,
          args: ['-I', '-c', "print('x'*10000)"],
          maximum_output: 100,
        })
      )
    } finally {
      await Deno.remove(root, { recursive: true })
    }
  },
})
