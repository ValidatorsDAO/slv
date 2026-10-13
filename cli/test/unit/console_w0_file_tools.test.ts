import {
  assert,
  assertEquals,
  assertFalse,
  assertStringIncludes,
} from '@std/assert'

import * as tools from '@/ai/console/tools.ts'
import { withHome } from '/test/unit/_credentialFixtures.ts'

const read = (path: string) =>
  tools.executeTool('read_file', { path, refresh: true })
const list = (path: string) => tools.executeTool('list_files', { path })
const write = (path: string, content: string) =>
  tools.executeTool('write_file', { path, content })

const exists = async (path: string): Promise<boolean> => {
  try {
    await Deno.lstat(path)
    return true
  } catch {
    return false
  }
}

// Made-up key material. None of these is a real key.
const KEY_BYTES = Array.from({ length: 64 }, (_, i) => (i * 7 + 3) % 256)
const KEY_JSON = JSON.stringify(KEY_BYTES)
const PEM = [
  '-----BEGIN OPENSSH PRIVATE KEY-----',
  'b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gtZW',
  '-----END OPENSSH PRIVATE KEY-----',
  '',
].join('\n')

type Layout = { home: string; paths: Record<string, string> }

/** A home holding each kind of file the file tools handle. */
const withLayout = async (fn: (layout: Layout) => Promise<void>) => {
  await withHome({ slv: { api_key: 'unused' } }, async (home) => {
    const files: Record<string, string> = {
      keys: `${home}/.slv/keys`,
      keysIdentity: `${home}/.slv/keys/node-a-identity.json`,
      keysVote: `${home}/.slv/keys/node-a-vote.json`,
      keysOther: `${home}/.slv/keys/notes.txt`,
      keypair: `${home}/work/testnet-validator-keypair.json`,
      identity: `${home}/work/unstaked-identity.json`,
      sshId: `${home}/.ssh/id_ed25519`,
      sshRsa: `${home}/.ssh/id_rsa`,
      sshPem: `${home}/.ssh/deploy`,
      sshPub: `${home}/.ssh/id_ed25519.pub`,
      sshConfig: `${home}/.ssh/config`,
      gateway: `${home}/.slv/gateway/gateway.json`,
      backupEnv: `${home}/.slv/backup.env`,
      restic: `${home}/.slv/restic-password`,
      agentConfig: `${home}/.slv/agent/config.yml`,
      template: `${home}/.slv/template/2026.1.1/ansible/cmn/play.yml`,
      knownHosts: `${home}/.slv/known_hosts`,
      bin: `${home}/.slv/bin/geyserbench`,
      memory: `${home}/.slv/agent/MEMORY.md`,
      inventory: `${home}/.slv/inventory.testnet.validators.yml`,
      notes: `${home}/work/notes.txt`,
    }
    const secret = 'SECRET-CONTENT-MARKER'
    for (const [name, path] of Object.entries(files)) {
      if (name === 'keys') continue
      await Deno.mkdir(path.slice(0, path.lastIndexOf('/')), {
        recursive: true,
      })
      let content = `${secret} ${name}\n`
      if (name === 'sshId' || name === 'sshRsa' || name === 'sshPem') {
        content = PEM
      }
      if (name === 'keysIdentity' || name === 'keysVote') content = KEY_JSON
      if (name === 'sshPub') content = 'ssh-ed25519 AAAAC3Nza public\n'
      await Deno.writeTextFile(path, content)
    }
    await fn({ home, paths: files })
  })
}

Deno.test('read_file, list_files and write_file refuse key material', async () => {
  await withLayout(async ({ home, paths }) => {
    const refused = [
      'keys',
      'keysIdentity',
      'keysVote',
      'keysOther',
      'keypair',
      'identity',
      'sshId',
      'sshRsa',
      'sshPem',
      'gateway',
      'backupEnv',
      'restic',
    ]
    for (const name of refused) {
      const path = paths[name]
      const isDir = name === 'keys'
      const before = isDir ? '' : await Deno.readTextFile(path)

      if (!isDir) {
        const content = await read(path)
        assert(content.startsWith('Error'), `read ${name}: ${content}`)
        assertFalse(content.includes('SECRET-CONTENT-MARKER'), name)
        assertFalse(content.includes('OPENSSH'), name)
        assertFalse(content.includes(KEY_JSON), name)
      }

      const listing = await list(path)
      assert(listing.startsWith('Error'), `list ${name}: ${listing}`)

      const written = await write(path, 'overwritten\n')
      assert(written.startsWith('Error'), `write ${name}: ${written}`)
      if (!isDir) assertEquals(await Deno.readTextFile(path), before, name)
    }
    // the api.yml rule applies to all three tools
    const apiYml = `${home}/.slv/api.yml`
    const apiBefore = await Deno.readTextFile(apiYml)
    assert((await read(apiYml)).startsWith('Error'))
    assert((await list(apiYml)).startsWith('Error'))
    assert((await write(apiYml, 'slv: {}\n')).startsWith('Error'))
    assertEquals(await Deno.readTextFile(apiYml), apiBefore)

    // the parent directory can still be listed
    assertStringIncludes(await list(`${paths.keys}/..`), 'keys')

    // ordinary files are still handled
    assertStringIncludes(await read(paths.notes), 'notes')
    assertStringIncludes(await read(paths.sshPub), 'ssh-ed25519')
    assertStringIncludes(await read(paths.sshConfig), 'sshConfig')
    assertStringIncludes(await read(paths.memory), 'memory')
    assertStringIncludes(await list(`${home}/.ssh`), 'config')
    assertStringIncludes(await list(`${home}/work`), 'notes.txt')

    const result = await write(paths.inventory, 'testnet_validators: {}\n')
    assertStringIncludes(result, 'Successfully')
    assertEquals(
      await Deno.readTextFile(paths.inventory),
      'testnet_validators: {}\n',
    )
    assertStringIncludes(
      await write(`${home}/.slv/agent/NEW.md`, 'x'),
      'Successfully',
    )
  })
})

Deno.test('write_file also refuses the agent config, the template, known_hosts and bin paths', async () => {
  await withLayout(async ({ home, paths }) => {
    for (const name of ['agentConfig', 'template', 'knownHosts', 'bin']) {
      const before = await Deno.readTextFile(paths[name])
      const result = await write(paths[name], 'changed\n')
      assert(result.startsWith('Error'), `${name}: ${result}`)
      assertEquals(await Deno.readTextFile(paths[name]), before, name)
    }
    for (
      const path of [
        `${home}/.slv/template/new-file.yml`,
        `${home}/.slv/template/2026.1.1/ansible/new/play.yml`,
        `${home}/.slv/bin/new-binary`,
        `${home}/.slv/known_hosts.old`,
        `${home}/.slv/agent/../template/x.yml`,
        `${home}/.slv/./bin/x`,
      ]
    ) {
      const result = await write(path, 'x')
      assert(result.startsWith('Error'), `${path}: ${result}`)
      assertFalse(
        await exists(path.replace('/agent/..', '').replace('/./', '/')),
        path,
      )
    }
    // reading the same paths is allowed
    assertStringIncludes(await read(paths.agentConfig), 'agentConfig')
    assertStringIncludes(await read(paths.template), 'template')
    assertStringIncludes(await read(paths.bin), 'bin')
  })
})

Deno.test('the file tools follow a symlink to the path that is refused', async () => {
  const outside = await Deno.makeTempDir({ prefix: 'console-w0-outside-' })
  try {
    await withLayout(async ({ home, paths }) => {
      await Deno.symlink(paths.keysIdentity, `${home}/work/innocent.txt`)
      await Deno.symlink(`${home}/.slv/keys`, `${home}/work/keydir`)
      await Deno.symlink(`${home}/.slv/keys`, `${home}/.slv/keylink`)
      await Deno.symlink(`${home}/.slv/template`, `${home}/.slv/shortcut`)
      await Deno.symlink(outside, `${home}/.slv/outside`)

      assert((await read(`${home}/work/innocent.txt`)).startsWith('Error'))
      assert(
        (await read(`${home}/work/keydir/node-a-vote.json`)).startsWith(
          'Error',
        ),
      )
      assert((await list(`${home}/work/keydir`)).startsWith('Error'))
      const throughKeys = await write(`${home}/.slv/keylink/new.json`, 'x')
      assert(throughKeys.startsWith('Error'), throughKeys)
      assertFalse(await exists(`${home}/.slv/keys/new.json`))
      const throughTemplate = await write(
        `${home}/.slv/shortcut/2026.1.1/new.yml`,
        'x',
      )
      assert(throughTemplate.startsWith('Error'), throughTemplate)
      assertFalse(await exists(`${home}/.slv/template/2026.1.1/new.yml`))
      const escaped = await write(`${home}/.slv/outside/escape.txt`, 'x')
      assert(escaped.startsWith('Error'), escaped)
      assertFalse(await exists(`${outside}/escape.txt`))
    })
  } finally {
    await Deno.remove(outside, { recursive: true })
  }
})

Deno.test('read_file refuses a private key whatever the file is called', async () => {
  await withLayout(async ({ home }) => {
    const elsewhere = `${home}/work/server.pem`
    await Deno.writeTextFile(elsewhere, PEM)
    const odd = `${home}/.ssh/work-laptop`
    await Deno.writeTextFile(odd, `\n${PEM}`)
    for (const path of [elsewhere, odd]) {
      const content = await read(path)
      assert(content.startsWith('Error'), `${path}: ${content}`)
      assertFalse(content.includes('b3BlbnNzaC1rZXk'), path)
    }
    // a certificate or a public key is not a private key
    const cert = `${home}/work/server.crt`
    await Deno.writeTextFile(
      cert,
      '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n',
    )
    assertStringIncludes(await read(cert), 'CERTIFICATE')
  })
})

Deno.test('read_file refuses the environment of a process', async () => {
  const own = await read('/proc/self/environ')
  assert(own.startsWith('Error'), 'read_file returned the process environment')
  const byPid = await read(`/proc/${Deno.pid}/environ`)
  assert(
    byPid.startsWith('Error'),
    'read_file returned the process environment',
  )
})
