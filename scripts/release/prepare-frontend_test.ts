import { assertEquals, assertRejects, assertThrows } from 'jsr:@std/assert@1'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readQualificationManifest } from './runtime-qualification.ts'
import {
  extractVerifiedFrontend,
  FRONTEND_VERSION,
  FRONTEND_ZIP_MAX_BYTES,
  type FrontendPlan,
  frontendPlan,
  frontendTarget,
  prepareFrontendPlan,
} from './prepare-frontend.ts'
const hash = (bytes: Uint8Array) =>
  createHash('sha256').update(bytes).digest('hex')
const content = new TextEncoder().encode('reviewed frontend fixture\n')
const url =
  'https://github.com/denoland/deno/releases/download/v2.9.3/deno-x86_64-unknown-linux-gnu.zip'
async function withArchives(
  action: (
    root: string,
    archives: Record<string, Uint8Array>,
    plan: FrontendPlan,
  ) => Promise<void>,
): Promise<void> {
  const root = await Deno.realPath(
    await Deno.makeTempDir({ prefix: 'slv-frontend-test-' }),
  )
  try {
    const script = String.raw`
import os,stat,sys,zipfile
root=sys.argv[1];original=b'reviewed frontend fixture\n'
for kind in ['good','extra','traversal','directory','symlink','duplicate','suffix','wrong-bytes']:
 with zipfile.ZipFile(os.path.join(root,kind+'.zip'),'w',zipfile.ZIP_DEFLATED) as z:
  name='../deno' if kind=='traversal' else 'deno'
  row=zipfile.ZipInfo(name);row.create_system=3;row.external_attr=(stat.S_IFREG|0o755)<<16
  if kind=='directory':row.external_attr=(stat.S_IFDIR|0o755)<<16
  if kind=='symlink':row.external_attr=(stat.S_IFLNK|0o777)<<16
  payload=original+b'lts\x1e\x50\x00\x00\xf3\x02\x00\x00\x13\x00\x00\x00\x00\x00\x00\x00' if kind=='suffix' else original
  if kind=='wrong-bytes':payload=b'X'+original[1:]
  z.writestr(row,payload)
  if kind=='extra':z.writestr('extra','unexpected')
  if kind=='duplicate':z.writestr('deno',original)
`
    const result = await new Deno.Command('python3', {
      args: ['-c', script, root],
      stdin: 'null',
      stdout: 'null',
      stderr: 'null',
    }).output()
    if (!result.success) throw new Error('archive fixture creation failed')
    const archives: Record<string, Uint8Array> = {}
    for (
      const kind of [
        'good',
        'extra',
        'traversal',
        'directory',
        'symlink',
        'duplicate',
        'suffix',
        'wrong-bytes',
      ]
    ) archives[kind] = await Deno.readFile(join(root, kind + '.zip'))
    const plan: FrontendPlan = {
      target: 'x86_64-unknown-linux-gnu',
      version: FRONTEND_VERSION,
      url,
      archive_sha256: hash(archives.good),
      binary_sha256: hash(content),
      binary_size: content.length,
    }
    await action(root, archives, plan)
  } finally {
    await Deno.remove(root, { recursive: true })
  }
}
Deno.test('frontend plan binds both exact Linux GitHub transports and executable identities', async () => {
  const m = await readQualificationManifest(
    fileURLToPath(
      new URL(
        '../../source-materials/runtime-qualification.json',
        import.meta.url,
      ),
    ),
  )
  const pins = await Deno.readFile(
    new URL('../../source-rebuild/tool-prereqs.json', import.meta.url),
  )
  const x64 = frontendPlan(m, pins, 'x86_64-unknown-linux-gnu'),
    arm = frontendPlan(m, pins, 'aarch64-unknown-linux-gnu')
  assertEquals(
    x64.archive_sha256,
    '8101865641cbede56f08ad19c0a67a87df84bce127fee0d3e3e1f7467717ffa6',
  )
  assertEquals(
    arm.archive_sha256,
    '753937db98a4b56cbbbd26e8f00eb4b789191a229afec93f74bcfa4e79bc2c8b',
  )
  for (const plan of [x64, arm]) {
    assertEquals(
      plan.binary_sha256,
      m.compatibility.frontend[plan.target].sha256,
    )
    assertEquals(plan.binary_size, m.compatibility.frontend[plan.target].size)
  }
  assertThrows(
    () =>
      frontendPlan(m, new Uint8Array(pins.length), 'x86_64-unknown-linux-gnu'),
    Error,
    'prerequisites differ',
  )
  const altered = structuredClone(m)
  altered.compatibility.frontend['x86_64-unknown-linux-gnu'].sha256 = 'f'
    .repeat(64)
  assertThrows(
    () => frontendPlan(altered, pins, 'x86_64-unknown-linux-gnu'),
    Error,
    'pins differ',
  )
  assertEquals(frontendTarget('linux', 'x86_64'), 'x86_64-unknown-linux-gnu')
  assertEquals(frontendTarget('linux', 'aarch64'), 'aarch64-unknown-linux-gnu')
  for (
    const args of [['darwin', 'aarch64'], ['linux', 'arm'], [
      'windows',
      'x86_64',
    ]]
  ) {
    assertThrows(
      () => frontendTarget(...args as [string, string]),
      Error,
      'native Linux',
    )
  }
})
Deno.test('verified frontend is installed only after transport and inner-byte checks without executing it', () =>
  withArchives(async (root, archives, plan) => {
    const output = join(root, 'installed')
    let requests = 0
    const receipt = await prepareFrontendPlan(plan, output, {
      fetch: (input, init) => {
        assertEquals(String(input), plan.url)
        assertEquals(init?.credentials, 'omit')
        assertEquals(init?.redirect, 'manual')
        assertEquals(new Headers(init?.headers).has('authorization'), false)
        requests++
        return Promise.resolve(new Response(archives.good.slice()))
      },
    })
    assertEquals(requests, 1)
    assertEquals(receipt.executable_sha256, hash(content))
    assertEquals(await Deno.readFile(join(output, 'deno')), content)
    assertEquals((await Deno.stat(join(output, 'deno'))).mode! & 0o777, 0o755)
    assertEquals(
      Array.from(await Array.fromAsync(Deno.readDir(output))).map((x) =>
        x.name
      ),
      ['deno'],
    )
    for await (const entry of Deno.readDir(root)) {
      assertEquals(entry.name.startsWith('.slv-frontend-'), false)
    }
  }))
Deno.test('frontend ZIP validation rejects extra paths, links, duplicate entries, modified content and LTS suffix', () =>
  withArchives(async (root, archives, plan) => {
    for (
      const kind of ['extra', 'traversal', 'directory', 'symlink', 'duplicate']
    ) {
      await assertRejects(
        () =>
          extractVerifiedFrontend(
            join(root, kind + '.zip'),
            join(root, kind + '-output'),
            { ...plan, archive_sha256: hash(archives[kind]) },
          ),
        Error,
        'unsafe or mismatched',
      )
    }
    await assertRejects(
      () =>
        extractVerifiedFrontend(
          join(root, 'suffix.zip'),
          join(root, 'suffix-output'),
          { ...plan, archive_sha256: hash(archives.suffix) },
        ),
      Error,
      'unsafe or mismatched',
    )
    await assertRejects(
      () =>
        extractVerifiedFrontend(
          join(root, 'wrong-bytes.zip'),
          join(root, 'wrong-output'),
          { ...plan, archive_sha256: hash(archives['wrong-bytes']) },
        ),
      Error,
      'executable bytes differ',
    )
    for (const kind of ['suffix', 'wrong-bytes']) {
      const output = join(root, 'install-' + kind)
      await assertRejects(
        () =>
          prepareFrontendPlan(plan, output, {
            fetch: () => Promise.resolve(new Response(archives[kind].slice())),
          }),
        Error,
        'ZIP digest differs',
      )
      await assertRejects(() => Deno.stat(output), Deno.errors.NotFound)
    }
    const corrupt = archives.good.slice()
    corrupt[0] ^= 1
    await assertRejects(
      () =>
        prepareFrontendPlan(plan, join(root, 'corrupt'), {
          fetch: () => Promise.resolve(new Response(corrupt)),
        }),
      Error,
      'ZIP digest differs',
    )
  }))
Deno.test('frontend output collisions remain intact and failure removes only owned scratch', () =>
  withArchives(async (root, archives, plan) => {
    const existing = join(root, 'existing')
    await Deno.mkdir(existing)
    await Deno.writeTextFile(join(existing, 'marker'), 'preserve')
    let fetched = false
    await assertRejects(
      () =>
        prepareFrontendPlan(plan, existing, {
          fetch: () => {
            fetched = true
            return Promise.resolve(new Response(archives.good.slice()))
          },
        }),
      Error,
      'already exists',
    )
    assertEquals(fetched, false)
    assertEquals(await Deno.readTextFile(join(existing, 'marker')), 'preserve')
    const raced = join(root, 'raced')
    await assertRejects(() =>
      prepareFrontendPlan(plan, raced, {
        fetch: async () => {
          await Deno.mkdir(raced)
          await Deno.writeTextFile(join(raced, 'marker'), 'preserve')
          return new Response(archives.good.slice())
        },
      })
    )
    assertEquals(await Deno.readTextFile(join(raced, 'marker')), 'preserve')
    const destination = join(root, 'destination')
    await Deno.writeTextFile(destination, 'preserve')
    await assertRejects(() =>
      extractVerifiedFrontend(join(root, 'good.zip'), destination, plan)
    )
    assertEquals(await Deno.readTextFile(destination), 'preserve')
    for await (const entry of Deno.readDir(root)) {
      assertEquals(entry.name.startsWith('.slv-frontend-'), false)
    }
  }))
Deno.test('frontend transport permits only bounded public GitHub redirects and rejects unavailable/oversized downloads', () =>
  withArchives(async (root, archives, plan) => {
    let requests = 0
    await prepareFrontendPlan(plan, join(root, 'redirected'), {
      fetch: (input, init) => {
        requests++
        assertEquals(new Headers(init?.headers).has('authorization'), false)
        if (requests === 1) {
          return Promise.resolve(
            new Response(null, {
              status: 302,
              headers: {
                location:
                  'https://release-assets.githubusercontent.com/public-asset',
              },
            }),
          )
        }
        assertEquals(
          String(input),
          'https://release-assets.githubusercontent.com/public-asset',
        )
        return Promise.resolve(new Response(archives.good.slice()))
      },
    })
    assertEquals(requests, 2)
    for (
      const location of [
        'https://dl.deno.land/release/v2.9.3/deno.zip',
        'http://github.com/file',
        'https://example.com/file',
        'https://user:password@github.com/file',
      ]
    ) {
      await assertRejects(
        () =>
          prepareFrontendPlan(plan, join(root, 'unsafe-redirect'), {
            fetch: () =>
              Promise.resolve(
                new Response(null, { status: 302, headers: { location } }),
              ),
          }),
        Error,
        'approved public HTTPS',
      )
    }
    for (const status of [204, 304, 403, 404, 500]) {
      await assertRejects(
        () =>
          prepareFrontendPlan(plan, join(root, 'unavailable-' + status), {
            fetch: () => Promise.resolve(new Response(null, { status })),
          }),
        Error,
        'HTTP 200',
      )
    }
    await assertRejects(
      () =>
        prepareFrontendPlan(plan, join(root, 'offline'), {
          fetch: () => Promise.reject(new TypeError('unavailable')),
        }),
      Error,
      'download failed',
    )
    await assertRejects(
      () =>
        prepareFrontendPlan(plan, join(root, 'oversized-header'), {
          fetch: () =>
            Promise.resolve(
              new Response(archives.good.slice(), {
                headers: {
                  'content-length': String(FRONTEND_ZIP_MAX_BYTES + 1),
                },
              }),
            ),
        }),
      Error,
      'size bound',
    )
    let cancelled = false
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new Uint8Array(FRONTEND_ZIP_MAX_BYTES + 1))
      },
      cancel() {
        cancelled = true
      },
    })
    await assertRejects(
      () =>
        prepareFrontendPlan(plan, join(root, 'oversized-stream'), {
          fetch: () => Promise.resolve(new Response(stream)),
        }),
      Error,
      'size bound',
    )
    assertEquals(cancelled, true)
    for await (const entry of Deno.readDir(root)) {
      assertEquals(entry.name.startsWith('.slv-frontend-'), false)
    }
  }))

Deno.test('frontend download deadline aborts stalled headers/body and cleans unpublished files', () =>
  withArchives(async (root, archives, plan) => {
    let headerAborted = false, bodyAborted = false, bodyCancelled = false
    const header = prepareFrontendPlan(plan, join(root, 'stalled-headers'), {
      deadlineMs: 20,
      fetch: (_input, init) =>
        new Promise((_resolve, reject) => {
          init!.signal!.addEventListener('abort', () => {
            headerAborted = true
            reject(new DOMException('aborted', 'AbortError'))
          }, { once: true })
        }),
    })
    const body = prepareFrontendPlan(plan, join(root, 'stalled-body'), {
      deadlineMs: 20,
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
      assertRejects(() => header, Error, 'timed out'),
      assertRejects(() => body, Error, 'timed out'),
    ])
    assertEquals(headerAborted, true)
    assertEquals(bodyAborted, true)
    assertEquals(bodyCancelled, true)
    await assertRejects(
      () => Deno.stat(join(root, 'stalled-headers')),
      Deno.errors.NotFound,
    )
    await assertRejects(
      () => Deno.stat(join(root, 'stalled-body')),
      Deno.errors.NotFound,
    )
    for (const deadlineMs of [0, -1, 120001, 1.5, NaN]) {
      await assertRejects(
        () =>
          prepareFrontendPlan(plan, join(root, 'invalid-deadline'), {
            deadlineMs,
            fetch: () => Promise.resolve(new Response(archives.good.slice())),
          }),
        Error,
        'invalid download deadline',
      )
    }
    for await (const entry of Deno.readDir(root)) {
      assertEquals(entry.name.startsWith('.slv-frontend-'), false)
    }
  }))
