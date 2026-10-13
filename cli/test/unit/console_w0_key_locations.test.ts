import {
  assert,
  assertEquals,
  assertFalse,
  assertStringIncludes,
} from '@std/assert'

import { classifyCommand, decideCommandGate } from '@/ai/console/commandGate.ts'
import { isReadOnlyLine } from '@/ai/console/readOnly.ts'
import {
  fileToolRefusal,
  REDACTED_SECRET_KEY,
  redactSecretKeys,
} from '@/ai/console/toolSafety.ts'
import {
  buildExcludeList,
  KEY_MATERIAL_EXCLUDES,
  secretExcludes,
  WALLET_EXCLUDES,
} from '@/backup/excludes.ts'
import {
  backupPatterns,
  expandForBackup,
  KEY_LOCATIONS,
} from '/lib/keyLocations.ts'
import type { KeyLocation } from '/lib/keyLocations.ts'
import { withHome } from '/test/unit/_credentialFixtures.ts'

/** What run_command decides for a line with auto-execute on. */
const decide = (line: string, hasTerminal: boolean) =>
  decideCommandGate({
    gated: classifyCommand(line).gated,
    autoExecute: true,
    hasTerminal,
    readOnly: isReadOnlyLine(line).readOnly,
  })

/** The line needs a person: a terminal confirms it, none refuses it. */
const needsAPerson = (line: string): void => {
  assert(classifyCommand(line).gated, `not held: ${line}`)
  assertEquals(decide(line, true), 'confirm', line)
  assertEquals(decide(line, false), 'refuse', line)
}

const runsAlone = (line: string): void => {
  assertEquals(decide(line, false), 'run', line)
  assertEquals(decide(line, true), 'run', line)
}

/** Programs that print a file as it is or in another encoding. */
const READERS = ['cat', 'base64', 'xxd', 'od', 'strings']

/** The path is refused by the three file tools. */
const assertRefusedByFileTools = async (path: string): Promise<void> => {
  for (const tool of ['read_file', 'list_files', 'write_file'] as const) {
    const refusal = await fileToolRefusal(tool, path)
    assert(refusal !== null, `${tool} handles ${path}`)
    assertStringIncludes(refusal, 'Error')
  }
  for (const tool of ['read_file', 'list_files'] as const) {
    const refusal = await fileToolRefusal(tool, path)
    assertStringIncludes(refusal ?? '', `${tool} does not`)
  }
}

/** The path is gated for each of the readers. */
const assertGated = (path: string): void => {
  for (const reader of READERS) needsAPerson(`${reader} ${path}`)
}

/** The path is handled by the file tools and not gated. */
const assertOpen = async (path: string): Promise<void> => {
  assertEquals(await fileToolRefusal('read_file', path), null, path)
  assertEquals(await fileToolRefusal('list_files', path), null, path)
  for (const reader of READERS) runsAlone(`${reader} ${path}`)
}

/** A pattern of the shared list as a path: `*` is one name, `**` two directories. */
const concrete = (pattern: string): string =>
  pattern.replace(/\*\*/g, 'deep/er').replace(/\*/g, 'x')

/** The paths of a location under each home, with one inside a directory. */
const instances = (location: KeyLocation, homes: string[]): string[] => {
  const paths: string[] = []
  for (const pattern of location.paths) {
    const own = concrete(pattern)
    const bases = pattern.startsWith('/')
      ? [own]
      : homes.map((home) => `${home}/${own}`)
    for (const base of bases) {
      paths.push(base)
      if (location.kind === 'directory') paths.push(`${base}/inside.json`)
      if (location.copies) paths.push(`${base}.bak`)
    }
  }
  return paths
}

Deno.test('every location of the backup lists is refused by the file tools and gated for cat, base64, xxd, od and strings, under every home', async () => {
  await withHome(null, async (home) => {
    // the lists of the backup are the expansion of the shared list
    assertEquals(
      KEY_LOCATIONS.filter((l) => l.group === 'key' && !l.consoleOnly)
        .flatMap(expandForBackup),
      [...KEY_MATERIAL_EXCLUDES],
    )
    assertEquals(
      KEY_LOCATIONS.filter((l) => l.group === 'wallet' && !l.consoleOnly)
        .flatMap(expandForBackup),
      [...WALLET_EXCLUDES],
    )
    let checked = 0
    for (const location of KEY_LOCATIONS) {
      for (
        const path of instances(location, ['/home/alice', '/root', home])
      ) {
        await assertRefusedByFileTools(path)
        assertGated(path)
        checked++
      }
    }
    // every entry of both lists was one of those instantiated
    assert(checked >= 80, `only ${checked} paths were checked`)
    for (const pattern of [...KEY_MATERIAL_EXCLUDES, ...WALLET_EXCLUDES]) {
      const path = concrete(pattern.replace('/home/*', '/home/alice'))
      await assertRefusedByFileTools(path)
      assertGated(path)
    }
  })
})

Deno.test('the wallets and the four system key directories are refused and gated', async () => {
  await withHome(null, async (home) => {
    const homes = ['/home/alice', '/root', '/Users/alice', home]
    for (const base of homes) {
      for (
        const path of [
          `${base}/.config/solana/id.json`,
          `${base}/slv/wallet.json`,
          `${base}/slv/bot/wallet.json`,
          `${base}/slv/a/b/c/wallet.json.bak.1700000000`,
          `${base}/slv/bot/wallet-1.json`,
          `${base}/.slv/wallet-rescue/a.json`,
          `${base}/.slv/wallet-rescue/2026/b.json`,
        ]
      ) {
        await assertRefusedByFileTools(path)
        assertGated(path)
      }
    }
    for (
      const path of [
        '/etc/wireguard/wg0.conf',
        '/etc/wireguard/keys/peer.key',
        '/etc/doublezero/keys/id.json',
        '/etc/ssl/private/ssl-cert-snakeoil.key',
        '/etc/nginx/ssl/site.key',
      ]
    ) {
      await assertRefusedByFileTools(path)
      assertGated(path)
    }
    // the directories themselves cannot be read or listed either
    for (
      const dir of [
        '/etc/wireguard',
        '/etc/doublezero/keys',
        '/etc/ssl/private',
        '/etc/nginx/ssl',
        `${home}/.slv/wallet-rescue`,
      ]
    ) {
      await assertRefusedByFileTools(dir)
      assertGated(dir)
    }
    // what lies next to them is handled
    for (
      const path of [
        `${home}/.config/solana/cli/config.yml`,
        `${home}/slv/bot/config.json`,
        `${home}/slv/README.md`,
        `${home}/slv-old/wallet-notes.txt`,
        '/etc/ssl/certs/ca-certificates.crt',
        '/etc/ssl/openssl.cnf',
        '/etc/nginx/nginx.conf',
        '/etc/doublezero/config.yml',
      ]
    ) await assertOpen(path)
  })
})

Deno.test('an SSH private key is recognised under any name, and the public keys, known_hosts, authorized_keys and config stay readable', async () => {
  await withHome(null, async (home) => {
    for (
      const path of [
        `${home}/.ssh/deploy_key`,
        `${home}/.ssh/work/github`,
        `${home}/.ssh/work/deep/er/key`,
        '/home/alice/.ssh/mykey',
        '/root/.ssh/mykey',
        '/Users/alice/.ssh/mykey',
        `${home}/.ssh/id_ed25519`,
        `${home}/.ssh/id_rsa`,
        `${home}/.ssh/mykey.bak`,
        `${home}/.ssh/config.bak`,
      ]
    ) {
      await assertRefusedByFileTools(path)
      assertGated(path)
    }
    for (
      const path of [
        `${home}/.ssh/id_ed25519.pub`,
        `${home}/.ssh/mykey.pub`,
        `${home}/.ssh/work/github.pub`,
        `${home}/.ssh/known_hosts`,
        `${home}/.ssh/known_hosts.old`,
        `${home}/.ssh/config`,
        `${home}/.ssh/authorized_keys`,
        `${home}/.ssh/authorized_keys2`,
        '/home/alice/.ssh/known_hosts',
        '/home/alice/.ssh/id_ed25519.pub',
      ]
    ) await assertOpen(path)
    // the directory itself can be listed
    assertEquals(await fileToolRefusal('list_files', `${home}/.ssh`), null)
    runsAlone('ls ~/.ssh')
    runsAlone('ls -la /home/alice/.ssh/')
  })
})

Deno.test('a run of 64 integers from 0 to 255 is redacted whatever separates the numbers, with or without brackets', async () => {
  const numbers = Array.from({ length: 64 }, (_, i) => (i * 7 + 3) % 256)
  for (
    const text of [
      numbers.join(','),
      numbers.join(', '),
      numbers.join(' , '),
      numbers.join(' '),
      numbers.join('\n'),
      numbers.join(',\n'),
      `[${numbers.join(',')}]`,
      `[ ${numbers.join('\n  ')} ]`,
      JSON.stringify(numbers),
      JSON.stringify(numbers, null, 2),
    ]
  ) {
    assertEquals(await redactSecretKeys(text), REDACTED_SECRET_KEY, text)
  }
  // inside other text, what stands around the run is kept
  assertEquals(
    await redactSecretKeys(`key:\n${numbers.join('\n')}\nend\n`),
    `key:\n${REDACTED_SECRET_KEY}\nend\n`,
  )
  assertEquals(
    await redactSecretKeys(`a ${numbers.join(' ')} b ${numbers.join(',')} c`),
    `a ${REDACTED_SECRET_KEY} b ${REDACTED_SECRET_KEY} c`,
  )
  // 63 numbers, 65 numbers, or a number above 255 are not a key
  for (
    const text of [
      numbers.slice(0, 63).join(','),
      numbers.slice(0, 63).join('\n'),
      [...numbers, 1].join(' '),
      numbers.map((n, i) => (i === 10 ? 256 : n)).join(','),
      numbers.map((n, i) => (i === 63 ? 1000 : n)).join('\n'),
      numbers.map((n, i) => (i === 5 ? -5 : n)).join(' '),
      numbers.map((n, i) => (i === 5 ? '1.5' : n)).join(' '),
      numbers.join('; '),
      // a number that is written with more than three digits
      numbers.map((n, i) => (i === 7 ? '0001' : n)).join(' '),
      // a number that is part of a decimal or of a word does not count
      `${numbers.slice(0, 63).join(' ')} 1.5`,
      `${numbers.slice(0, 63).join(' ')} 4x`,
    ]
  ) {
    assertEquals(await redactSecretKeys(text), text, text.slice(0, 40))
  }
})

Deno.test('the exclude lists of tar, restic and rsync are those of the lists written before the shared definition', () => {
  const key = [
    '/root/.slv/keys',
    '/home/*/.slv/keys',
    '/root/*keypair*.json',
    '/home/*/*keypair*.json',
    '/root/*identity*.json',
    '/home/*/*identity*.json',
    '/root/.slv/api.yml',
    '/home/*/.slv/api.yml',
    '/root/.slv/gateway/gateway.json',
    '/home/*/.slv/gateway/gateway.json',
    '/root/.slv/backup.env',
    '/home/*/.slv/backup.env',
    '/root/.slv/restic-password',
    '/home/*/.slv/restic-password',
    '/root/.ssh/id_*',
    '/home/*/.ssh/id_*',
    '/etc/ssh/ssh_host_*_key',
    '/etc/shadow',
    '/etc/shadow-',
    '/etc/gshadow',
    '/etc/gshadow-',
    '/etc/wireguard',
    '/etc/doublezero/keys',
    '/etc/ssl/private',
    '/etc/nginx/ssl',
  ]
  const wallet = [
    '/root/slv/wallet*.json*',
    '/root/slv/**/wallet*.json*',
    '/home/*/slv/wallet*.json*',
    '/home/*/slv/**/wallet*.json*',
    '/root/.slv/wallet-rescue',
    '/home/*/.slv/wallet-rescue',
    '/root/.config/solana/id.json',
    '/home/*/.config/solana/id.json',
  ]
  assertEquals([...KEY_MATERIAL_EXCLUDES], key)
  assertEquals([...WALLET_EXCLUDES], wallet)
  assertEquals(backupPatterns('key'), key)
  assertEquals(backupPatterns('wallet'), wallet)
  // tar and rsync never carry wallets, restic keeps them
  assertEquals(secretExcludes('tar'), [...key, ...wallet])
  assertEquals(secretExcludes('rsync'), [...key, ...wallet])
  assertEquals(secretExcludes('restic'), key)
  assertEquals(secretExcludes('restic', false), [...key, ...wallet])
  for (const tool of ['tar', 'rsync', 'restic'] as const) {
    const list = buildExcludeList({ tool })
    const secrets = secretExcludes(tool)
    // rsync applies the first rule that matches: its secret entries come first
    const placed = tool === 'rsync'
      ? list.slice(0, secrets.length)
      : list.slice(list.length - secrets.length)
    assertEquals(placed, secrets, tool)
  }
})

Deno.test('the console reads no second list of the places: the sources outside the shared definition name none of them', async () => {
  const names = [
    'restic-password',
    'backup.env',
    'gateway.json',
    'wallet-rescue',
    'solana/id.json',
    '/etc/wireguard',
    '/etc/doublezero',
    'nginx/ssl',
    'ssl/private',
    'ssh_host_',
    '*keypair*',
    '*identity*',
    'a keypair file',
    'an identity key file',
  ]
  for (
    const file of [
      '../../src/backup/excludes.ts',
      '../../src/ai/console/keyMaterial.ts',
      '../../src/ai/console/toolSafety.ts',
      '../../src/ai/console/commandGate.ts',
      '../../src/ai/console/readOnly.ts',
      '../../src/ai/console/recursiveRead.ts',
    ]
  ) {
    const text = await Deno.readTextFile(new URL(file, import.meta.url))
    for (const name of names) {
      // the files that belong to one machine are another list of the backup
      if (file.endsWith('excludes.ts') && name === 'ssh_host_') continue
      assertFalse(text.includes(name), `${file} names ${name}`)
    }
  }
  const definition = await Deno.readTextFile(
    new URL('../../lib/keyLocations.ts', import.meta.url),
  )
  for (const name of names.slice(0, 11)) assertStringIncludes(definition, name)
})

Deno.test('the new locations are held in the spellings the older classes are held in: globs, braces, dots, prefixes, expansions, cd, redirections and shells', () => {
  for (
    const line of [
      // globs and brackets
      'cat ~/.config/solana/id.*',
      'cat ~/.config/solana/i?.json',
      'cat ~/.config/*/id.json',
      'cat ~/.c*/solana/id.json',
      'cat ~/slv/*/wallet.json',
      'cat ~/slv/**/wallet.json',
      'cat ~/slv/*/*/wallet*.json',
      'cat ~/slv/bot/wallet*',
      'cat ~/slv/bot/w*',
      'cat ~/slv/bot/*.json',
      'cat ~/slv/*/wallet.json.bak.*',
      'cat ~/.slv/wallet-rescue/*',
      'cat ~/.slv/wallet-*/a.json',
      'cat ~/.slv/wallet-resc[u]e/a.json',
      'cat /home/*/.config/solana/id.json',
      'cat /home/al*/slv/bot/wallet.json',
      'cat /etc/ssl/pri*/*',
      'cat /etc/ssl/priv*',
      'cat /etc/wire*/wg0.conf',
      'cat /etc/doublezero/ke*/id.json',
      'cat /etc/nginx/ss?/x.key',
      'cat /etc/*/private/x.key',
      'cat ~/.ssh/*',
      'cat ~/.ssh/dep*',
      'cat ~/.s?h/id_rsa',
      'cat ~/.ssh/work/*',
      'cat ~/.s?h/[m]ykey',
      'cat ~/$X/my*',
      // a name with something added by a copy
      'cat ~/.s?v/api.yml.l?ck',
      'cat ~/.s?v/api.yml.tm[p]',
      'cat ~/.s?v/api.yml[~]',
      'cat ~/.conf*/solana/id.json.ba?',
      'cat ~/.s?v/restic-password.or?g',
      'cat ~/.s?v/backup.env.ol?',
      'cat /e?c/shadow.ol?',
      // a relative word that starts like a place under a home, or climbs to the root
      'cat .config/solana/id.*',
      'cat .slv/wallet-rescue/*',
      'cat slv/bot/wallet*',
      'cat .ssh/my*',
      'cat ../../../home/alice/s*/bot/wallet.json',
      // braces
      'cat ~/.config/solana/{id.json,x}',
      'cat ~/slv/{bot,x}/wallet.json',
      'cat /etc/{ssl,x}/private/x.key',
      // dots, doubled slashes, a path through another root
      'cat ~/./.config/./solana/id.json',
      'cat ~/x/../.config/solana/id.json',
      'cat //home//alice//slv//bot//wallet.json',
      'cat /proc/self/root/home/alice/.config/solana/id.json',
      'cat ../../../etc/ssl/private/x.key',
      'cat ../../../etc/ssl/pri*/*',
      'cat ../../../home/alice/slv/bot/wallet.json',
      // expansions
      'cat $HOME/.config/solana/id.json',
      'cat "$HOME/slv/bot/wallet.json"',
      'cat ${HOME}/.slv/wallet-rescue/a',
      'cat $d/solana/id.json',
      'cat $d/wallet.json',
      // a directory the line changed to
      'cd ~/.config/solana && cat id.json',
      'cd ~/.config && cat solana/id.json',
      'cd ~/slv/bot && cat wallet.json',
      'cd ~/slv/bot; head wallet.json.bak.1',
      'cd /etc/ssl/private && cat x.key',
      'cd /etc/wireguard; cat wg0.conf',
      // a redirection, another program, a shell
      'cat < ~/.config/solana/id.json',
      'xargs cat < /etc/wireguard/wg0.conf',
      'sort ~/slv/bot/wallet.json',
      "bash -c 'cat ~/.config/solana/id.json'",
      'echo ~/.slv/wallet-rescue/a',
    ]
  ) needsAPerson(line)
})

Deno.test('what a glob cannot reach in a key or wallet location stays readable', () => {
  for (
    const line of [
      // a glob does not match a name that starts with a dot, so none of these reaches .ssh
      'cat ~/*/notes.txt',
      'ls ~/*/*.log',
      'grep x ~/*/logs/*.log',
      'cat ~/?/x',
      'cat ~/[a-z]*/y',
      // the neighbours of the locations
      'cat ~/.config/gh/hosts.yml',
      'cat ~/.config/solana/cli/config.yml',
      'ls ~/.config/solana',
      'cat ~/slv/*/*.md',
      'cat ~/slv/bot/src/*.ts',
      'cat ~/slv/README.md',
      'cat ~/slv-old/wallet.json',
      'cat ~/slvx/wallet.json',
      'cat /etc/ssl/certs/*',
      'cat /etc/nginx/conf.d/*.conf',
      'cat /etc/ssl/openssl.cnf',
      // public keys and the files that hold no private key
      'cat ~/.ssh/*.pub',
      'cat ~/.ssh/id_*.pub',
      'cat ~/.ssh/known_hosts',
      'cat ~/.ssh/config',
      'ls ~/.ssh',
      // the name of a place is not the end of another name
      'cat ~/xslv/wallet.json',
      'cat ~/my.ssh/id_rsa',
      'cat /var/netc/shadow',
      'cat /opt/xdev/mem',
      'cat /tmp/sdev/port',
      // a glob does not match a dot, so a class or a name of a dot alone cannot be .ssh
      'cat ~/.s?h/[.]x',
      'cat ~/[.]ssh/mykey',
      'ls -d ~/.ss?',
      // one letter written out names no file in the directory the console runs in
      'cat i*',
      'ls k*',
      'cat [i]*',
      'cat wallet*',
      'cat wallet.js*',
      // an expansion stands for a directory, not for whatever it is followed by
      'cat $HOME/bin/tool',
      'cat "$DIR/x.json"',
    ]
  ) runsAlone(line)
})

Deno.test('a recursive search of a directory above or inside a key or wallet location needs a person, one beside it does not', () => {
  for (
    const line of [
      'grep -r x ~/slv',
      'grep -r x ~/slv/bot',
      'grep -r x ~/slv/bot/src',
      'rg x /home/alice/slv',
      'grep -r x /root/slv',
      'grep -r x ~/.config',
      'grep -r x ~/.config/solana',
      'grep -r x /Users/alice/.config',
      'grep -r x /etc',
      'grep -r x /etc/ssl',
      'grep -r x /etc/nginx',
      'grep -r x /etc/doublezero',
      'grep -r x /etc/wireguard',
      'grep -r x /etc/ssh',
      'grep -r x /dev',
      'diff -r /etc/ssl /tmp/x',
      // inside a directory that is a location
      'grep -r x /etc/wireguard/keys',
      'grep -r x /etc/ssl/private/sub',
      'grep -r x /etc/doublezero/keys/old',
      'grep -r x ~/.slv/wallet-rescue/2026',
    ]
  ) needsAPerson(line)
  for (
    const line of [
      'grep -r x ~/.cache',
      'grep -r x ~/.config/gh',
      'grep -r x ~/slv-old',
      'grep -r x /etc/ssl/certs',
      'grep -r x /etc/nginx/conf.d',
      'grep -r x /etc/systemd',
      'grep -r x /dev/shm',
    ]
  ) runsAlone(line)
})

Deno.test('each location is marked as what its patterns are', () => {
  for (const location of KEY_LOCATIONS) {
    for (const path of location.paths) {
      if (location.kind === 'glob') {
        assert(path.includes('*'), `${path} is marked as a glob`)
      } else {
        assertFalse(path.includes('*'), `${path} is marked as ${location.kind}`)
      }
    }
    // the patterns of one location are all home-relative or all absolute
    assertEquals(
      new Set(location.paths.map((path) => path.startsWith('/'))).size,
      1,
      location.paths.join(' '),
    )
  }
})

Deno.test('a path is read as it is written: the process of the path, the homes the caller names and the name of a place under a link', async () => {
  const { refusedPathReason } = await import('@/ai/console/keyMaterial.ts')
  // a process by name or by number, a thread by number
  for (
    const path of [
      '/proc/self/mem',
      '/proc/thread-self/mem',
      '/proc/12/mem',
      '/proc/12/task/34/mem',
      '/proc/self/environ',
      '/proc/thread-self/environ',
      '/proc/12/task/34/environ',
    ]
  ) assert(refusedPathReason(path) !== null, path)
  // what is not a path to the place
  for (
    const path of [
      '/etc/shadow/x',
      '/etc/ssh/ssh_host_dir/sub_key',
      '/root/.config/solana/id.json/x',
      '/proc/self/memory',
      '/proc/self/task/mem',
      '/proc/12/task/34/56/mem',
      '/etc/ssl/privatex',
    ]
  ) assertEquals(refusedPathReason(path), null, path)
  // the homes of the caller are homes, and no other directory is
  const place = '/srv/people/zed/.config/solana/id.json'
  assertEquals(refusedPathReason(place), null)
  assert(refusedPathReason(place, ['/srv/people/zed']) !== null)
  await withHome(null, async (home) => {
    assertEquals(refusedPathReason(place), null)
    assertEquals(await fileToolRefusal('read_file', place), null)
    Deno.env.set('HOME', '/srv/people/zed')
    try {
      assert(refusedPathReason(place) !== null)
      assert((await fileToolRefusal('read_file', place)) !== null)
    } finally {
      Deno.env.set('HOME', home)
    }
  })
  // the ERPC login says how to change it
  await withHome(null, async (home) => {
    assertStringIncludes(
      (await fileToolRefusal('read_file', `${home}/.slv/api.yml`)) ?? '',
      'do not handle ~/.slv/api.yml',
    )
    assertStringIncludes(
      (await fileToolRefusal('write_file', `${home}/.slv/api.yml`)) ?? '',
      'slv login',
    )
    assertStringIncludes(
      (await fileToolRefusal('read_file', `${home}/.slv/api.yml.lock`)) ?? '',
      'do not handle ~/.slv/api.yml',
    )
  })
})

Deno.test('a home that is reached through a link is a home, and a link to a place is the place', async () => {
  const real = await Deno.makeTempDir({ prefix: 'console-w0-real-' })
  const parent = await Deno.makeTempDir({ prefix: 'console-w0-link-' })
  const link = `${parent}/home`
  try {
    await Deno.symlink(real, link)
    await Deno.mkdir(`${real}/.ssh`, { recursive: true })
    await Deno.mkdir(`${real}/.config/solana`, { recursive: true })
    await Deno.writeTextFile(`${real}/.config/solana/id.json`, '[]')
    const before = Deno.env.get('HOME')
    const sudo = Deno.env.get('SUDO_USER')
    Deno.env.set('HOME', link)
    Deno.env.delete('SUDO_USER')
    try {
      // the home as the link names it, and as the system resolves it
      await assertRefusedByFileTools(`${link}/.ssh/mykey`)
      await assertRefusedByFileTools(`${real}/.ssh/mykey`)
      await assertRefusedByFileTools(`${real}/.config/solana/id.json`)
      // a link to a place from a directory that is no place
      await Deno.symlink(`${real}/.config/solana/id.json`, `${real}/innocent`)
      await assertRefusedByFileTools(`${link}/innocent`)
    } finally {
      if (before === undefined) Deno.env.delete('HOME')
      else Deno.env.set('HOME', before)
      if (sudo !== undefined) Deno.env.set('SUDO_USER', sudo)
    }
  } finally {
    await Deno.remove(parent, { recursive: true })
    await Deno.remove(real, { recursive: true })
  }
})
