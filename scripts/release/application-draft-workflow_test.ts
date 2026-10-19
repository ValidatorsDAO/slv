import { assert, assertEquals } from 'jsr:@std/assert@1'
import { fileURLToPath } from 'node:url'

const SOURCE = 'a'.repeat(40)
const TAG = 'v2026.10.19.0750'
const decoder = new TextDecoder()
function step(workflow: string, name: string): string {
  const part = workflow.slice(workflow.indexOf(`      - name: ${name}\n`))
  const body = part.slice(
    part.indexOf('        run: |\n') + '        run: |\n'.length,
  )
  return body.split('\n').slice(
    0,
    body.split('\n').findIndex((line) =>
      line && !line.startsWith('          ')
    ),
  )
    .map((line) => line.slice(10)).join('\n')
}

Deno.test('actual application publisher retains draft ID and uses numeric asset lookup with a tag-404 provider', async () => {
  const workflow = await Deno.readTextFile(
    new URL('../../.github/workflows/slv-remote-build.yml', import.meta.url),
  )
  const create = step(
    workflow,
    'Create or guard the exact tag and draft release',
  )
  const recover = step(
    workflow,
    'Recover only matching draft payloads, then stage missing payloads',
  )
  assert(create.includes('application-draft.ts find'))
  assert(recover.includes('releases/$release_id'))
  assert(!create.includes('releases/tags/'))
  assert(!recover.includes('releases/tags/'))
  const final = step(
    workflow,
    'Re-download every staged asset and verify provenance before publication',
  )
  assert(final.indexOf('application-draft.ts complete') >= 0)
  assert(
    final.indexOf('application-draft.ts complete') <
      final.indexOf('gh release download'),
  )
  assert(
    final.indexOf('application-draft.ts verify') >
      final.indexOf('gh attestation verify'),
  )
  assert(
    final.indexOf('application-draft.ts verify') <
      final.indexOf('gh release edit'),
  )
  const root = await Deno.makeTempDir({
    prefix: 'slv-application-draft-shell-',
  })
  try {
    const bin = `${root}/bin`
    await Deno.mkdir(bin)
    const bridge = `${root}/bridge.ts`
    await Deno.writeTextFile(
      bridge,
      `
import { applicationDraftCommand } from ${
        JSON.stringify(new URL('./application-draft.ts', import.meta.url).href)
      }
` + `
const api = { release: async (_tag: string) => {
  if (Deno.env.get('LOOKUP_ERROR') === 'true') throw new Error('metadata unavailable')
  return JSON.parse(await Deno.readTextFile(Deno.env.get('REMOTE')!))
} }
console.log(JSON.stringify(await applicationDraftCommand(Deno.args, api)))
`,
    )
    await Deno.writeTextFile(
      `${bin}/deno`,
      `#!/usr/bin/env python3
import os,sys
args=sys.argv[1:]
i=next(i for i,x in enumerate(args) if x.endswith('scripts/release/application-draft.ts'))
os.execve(os.environ['REAL_DENO'],[os.environ['REAL_DENO'],'run','--cached-only','--frozen','--no-prompt','--config',os.environ['ROOT_CONFIG'],'--allow-read','--allow-env',os.environ['BRIDGE'],*args[i+1:]],os.environ)
`,
    )
    await Deno.writeTextFile(
      `${bin}/gh`,
      String.raw`#!/usr/bin/env python3
import os,sys,json,hashlib,pathlib,shutil
a=sys.argv[1:];p=pathlib.Path(os.environ['REMOTE']);r=json.loads(p.read_text())
with open(os.environ['CALL_LOG'],'a') as f:f.write(json.dumps(a)+'\n')
if a[0]=='api':
 if '/git/ref/tags/' in a[1]:print(json.dumps({'object':{'type':'commit','sha':os.environ['SOURCE_SHA']}}))
 elif a[1].endswith('/releases/17'):
  assert r['id']==17
  print('\n'.join(x['name'] for x in r['assets']))
 else:sys.exit(91) # the published-tag endpoint does not expose drafts
elif a[:2]==['release','create']:
 assert r is None
 p.write_text(json.dumps({'id':17,'tag_name':os.environ['TAG'],'target_commitish':os.environ['SOURCE_SHA'],'draft':True,'prerelease':False,'immutable':False,'assets':[]}))
elif a[:2]==['release','download']:
 name=a[a.index('--pattern')+1];dest=pathlib.Path(a[a.index('--dir')+1])
 shutil.copyfile(pathlib.Path('release')/name,dest/name)
elif a[:2]==['release','upload']:
 f=pathlib.Path(a[-1]);data=f.read_bytes();assert all(x['name']!=f.name for x in r['assets'])
 r['assets'].append({'id':100+len(r['assets']),'name':f.name,'size':len(data),'digest':'sha256:'+hashlib.sha256(data).hexdigest()})
 p.write_text(json.dumps(r))
else:sys.exit(92)
`,
    )
    await Deno.chmod(`${bin}/deno`, 0o700)
    await Deno.chmod(`${bin}/gh`, 0o700)
    for (const mode of ['create', 'resume', 'unavailable']) {
      const work = `${root}/${mode}`,
        remote = `${work}/remote.json`,
        log = `${work}/calls`
      await Deno.mkdir(`${work}/release`, { recursive: true })
      await Deno.writeTextFile(
        `${work}/release/payload`,
        'verified fixture bytes',
      )
      await Deno.writeTextFile(
        `${work}/release/release-manifest.json`,
        JSON.stringify({ assets: [{ name: 'payload' }] }),
      )
      await Deno.writeTextFile(
        `${work}/release/SHA256SUMS`,
        'fixture checksum inventory',
      )
      const bytes = new TextEncoder().encode('verified fixture bytes')
      const hash = [
        ...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)),
      ].map((n) => n.toString(16).padStart(2, '0')).join('')
      await Deno.writeTextFile(
        remote,
        JSON.stringify(
          mode === 'resume'
            ? {
              id: 17,
              tag_name: TAG,
              target_commitish: SOURCE,
              draft: true,
              prerelease: false,
              immutable: false,
              assets: [{
                id: 99,
                name: 'payload',
                size: bytes.length,
                digest: `sha256:${hash}`,
              }],
            }
            : null,
        ),
      )
      await Deno.writeTextFile(log, '')
      const result = await new Deno.Command('/bin/bash', {
        args: ['-ceu', create + '\n' + recover],
        cwd: work,
        clearEnv: true,
        env: {
          PATH: `${bin}:${Deno.env.get('PATH') ?? '/usr/bin:/bin'}`,
          ...Object.fromEntries(
            ['DENO_DIR', 'HOME', 'XDG_CACHE_HOME'].flatMap((key) =>
              Deno.env.has(key) ? [[key, Deno.env.get(key)!]] : []
            ),
          ),
          ROOT_CONFIG: fileURLToPath(
            new URL('../../deno.json', import.meta.url),
          ),
          REAL_DENO: Deno.execPath(),
          BRIDGE: bridge,
          REMOTE: remote,
          CALL_LOG: log,
          LOOKUP_ERROR: String(mode === 'unavailable'),
          SOURCE_SHA: SOURCE,
          TAG,
          GH_REPO: 'ValidatorsDAO/slv',
        },
        stdout: 'piped',
        stderr: 'piped',
      }).output()
      assertEquals(
        result.success,
        mode !== 'unavailable',
        decoder.decode(result.stderr),
      )
      const calls = (await Deno.readTextFile(log)).split('\n').filter(Boolean)
        .map((line) => JSON.parse(line) as string[])
      if (mode === 'unavailable') {
        assertEquals(calls, [])
        continue
      }
      assertEquals(
        calls.filter((args) => args[0] === 'release' && args[1] === 'create')
          .length,
        mode === 'create' ? 1 : 0,
      )
      assertEquals(
        calls.filter((args) =>
          args[0] === 'api' && args[1].endsWith('/releases/17')
        ).length,
        1,
      )
      assert(!calls.some((args) => args.join(' ').includes('releases/tags/')))
      const uploaded = calls.filter((args) =>
        args[0] === 'release' && args[1] === 'upload'
      ).map((args) => args.at(-1)!.split('/').at(-1))
      assertEquals(
        uploaded,
        mode === 'create'
          ? ['payload', 'release-manifest.json', 'SHA256SUMS']
          : ['release-manifest.json', 'SHA256SUMS'],
      )
      const selected = JSON.parse(
        await Deno.readTextFile(`${work}/application-draft.json`),
      )
      const final = JSON.parse(await Deno.readTextFile(remote))
      assertEquals(selected.id, 17)
      if (mode === 'resume') {
        assertEquals(
          final.assets.find((x: { name: string }) => x.name === 'payload').id,
          99,
        )
      }
    }
  } finally {
    await Deno.remove(root, { recursive: true })
  }
})
