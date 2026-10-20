import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from '@std/assert'
import { parse } from '@std/yaml'
import {
  encryptPassword,
  type EncryptPasswordDeps,
} from '/lib/encryptPassword.ts'
import {
  type GenPasswordDeps,
  genPasswordYml,
  holdsValidHash,
  SHA512_CRYPT_HASH,
} from '/lib/genPasswordYml.ts'

const HASH =
  '$6$saltsalt$Vq8sIeY6PPp7LXVIFvUCxFTP4U5X4Nn9lp3GmBiGHwFLa5tTmD5wpDNRqkSnVMPnV4fMl4G2fuBLhYtVtzFkr0'
const PASSWORD = 'Pa ss\'w"o\\rd $HOME; & é!'

const read = async (path: string): Promise<string | null> => {
  try {
    return await Deno.readTextFile(path)
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return null
    throw error
  }
}

type World = {
  dir: string
  path: string
  deps: GenPasswordDeps
  printed: string[]
  exitCodes: number[]
  asked: () => number
}

/** The password file in a directory of its own; openssl is whatever `spawn` says. */
const world = async (
  spawn: EncryptPasswordDeps['spawn'],
): Promise<World> => {
  const dir = await Deno.makeTempDir({ prefix: 'slv-pwd-' })
  const printed: string[] = []
  const exitCodes: number[] = []
  let asked = 0
  const path = `${dir}/config.pwd.yml`
  return {
    dir,
    path,
    printed,
    exitCodes,
    asked: () => asked,
    deps: {
      path,
      readText: read,
      writeText: (file, text) => Deno.writeTextFile(file, text),
      restrictMode: (file) => Deno.chmod(file, 0o600),
      askPassword: () => {
        asked++
        return Promise.resolve(PASSWORD)
      },
      encrypt: (password) =>
        encryptPassword(password, {
          spawn,
          error: (line) => printed.push(line),
        }),
      info: (line) => printed.push(line),
      warn: (line) => printed.push(line),
      error: (line) => printed.push(line),
      setExitCode: (code) => exitCodes.push(code),
    },
  }
}

const works: EncryptPasswordDeps['spawn'] = () =>
  Promise.resolve({ success: true, stdout: `${HASH}\n` })

Deno.test('a hash is a SHA-512 crypt hash only when it is $6$, a salt, $ and a digest', () => {
  assert(SHA512_CRYPT_HASH.test(HASH))
  assert(SHA512_CRYPT_HASH.test('$6$abc$./09AZaz'))
  for (
    const text of [
      '',
      '$5$saltsalt$Vq8sIeY6PPp7',
      '$1$saltsalt$Vq8sIeY6PPp7',
      '$6$saltsalt$',
      '$6$$Vq8sIeY6PPp7',
      '$6$saltsalt$Vq8sIeY6 PPp7',
      '$6$saltsalt$Vq8sIeY6PPp7\n',
      "Failed to spawn 'openssl': entity not found",
      'Usage: passwd [options]',
      PASSWORD,
    ]
  ) {
    assertEquals(SHA512_CRYPT_HASH.test(text), false, text)
  }
  assert(holdsValidHash(`encrypted_password: ${HASH}\n`))
  for (
    const text of [
      '',
      "encrypted_password: ''\n",
      'encrypted_password: "$5$saltsalt$Vq8sIeY6PPp7"\n',
      'encrypted_password: not a hash\n',
      'other: x\n',
      'encrypted_password: [1, 2]\n',
      'encrypted_password: {\n',
    ]
  ) {
    assertEquals(holdsValidHash(text), false, text)
  }
})

Deno.test('when openssl is missing, stops with an error, prints no hash or prints something that is no hash, no password file is written, the install guidance is printed, and the exit code is 1', async () => {
  const cases: [string, EncryptPasswordDeps['spawn']][] = [
    [
      'openssl is missing',
      () => Promise.reject(new Deno.errors.NotFound('spawn openssl')),
    ],
    [
      'openssl stops with an error (the openssl of macOS has no passwd -6)',
      () => Promise.resolve({ success: false, stdout: 'Usage: passwd\n' }),
    ],
    [
      'openssl prints nothing',
      () => Promise.resolve({ success: true, stdout: '\n' }),
    ],
    [
      'openssl prints something that is no SHA-512 crypt hash',
      () =>
        Promise.resolve({ success: true, stdout: 'Usage: passwd [options]\n' }),
    ],
  ]
  for (const [name, spawn] of cases) {
    const w = await world(spawn)
    try {
      assertEquals(await genPasswordYml(w.deps), false, name)
      assertEquals(await read(w.path), null, `${name}: a file was written`)
      assertEquals(w.exitCodes, [1], name)
      assertEquals(w.asked(), 1, name)
      const text = w.printed.join('\n')
      assertStringIncludes(
        text,
        'Please install openssl (MacOS: brew install openssl)',
        name,
      )
      assertStringIncludes(text, 'LibreSSL', name)
      assertStringIncludes(text, "Homebrew's openssl", name)
      assertStringIncludes(text, 'was not saved', name)
      assertEquals(text.includes('Password saved'), false, name)
      for (const piece of [PASSWORD, "ss'w", '$HOME']) {
        assertEquals(text.includes(piece), false, `${name}: ${piece}`)
      }
    } finally {
      await Deno.remove(w.dir, { recursive: true })
    }
  }
})

Deno.test('a password file with an empty value, a value that is no SHA-512 crypt hash or no YAML does not count as existing: it says so, asks again, and is replaced with a valid hash only', async () => {
  const unusable: [string, string][] = [
    ['an empty value', "encrypted_password: ''\n"],
    ['no value', 'encrypted_password:\n'],
    [
      'text in place of a hash',
      'encrypted_password: Failed to spawn openssl\n',
    ],
    ['a SHA-256 crypt hash', 'encrypted_password: $5$saltsalt$Vq8sIeY6PPp7\n'],
    ['an empty file', ''],
    ['no YAML', 'encrypted_password: {\n'],
  ]
  for (const [name, content] of unusable) {
    const good = await world(works)
    try {
      await Deno.writeTextFile(good.path, content)
      assertEquals(await genPasswordYml(good.deps), true, name)
      assertEquals(good.asked(), 1, name)
      assertStringIncludes(
        good.printed.join('\n'),
        'no valid password hash',
        name,
      )
      assertEquals(
        good.printed.join('\n').includes('already exists'),
        false,
        name,
      )
      assertEquals(
        (parse(await Deno.readTextFile(good.path)) as Record<string, string>)
          .encrypted_password,
        HASH,
        name,
      )
      assertEquals(good.exitCodes, [], name)
    } finally {
      await Deno.remove(good.dir, { recursive: true })
    }

    // And when openssl cannot make the hash, the file is left as it was.
    const bad = await world(() =>
      Promise.resolve({ success: false, stdout: '' })
    )
    try {
      await Deno.writeTextFile(bad.path, content)
      assertEquals(await genPasswordYml(bad.deps), false, name)
      assertEquals(await Deno.readTextFile(bad.path), content, name)
      assertEquals(bad.exitCodes, [1], name)
    } finally {
      await Deno.remove(bad.dir, { recursive: true })
    }
  }
})

Deno.test('a valid hash is written as before, and a file that holds one is kept without a question', async () => {
  const w = await world(works)
  try {
    assertEquals(await genPasswordYml(w.deps), true)
    // The way the YAML writer of the project has always written it.
    assertEquals(await read(w.path), `encrypted_password: >-\n  ${HASH}\n`)
    assertEquals(
      (parse((await read(w.path))!) as Record<string, string>)
        .encrypted_password,
      HASH,
    )
    assertEquals(w.asked(), 1)
    assertStringIncludes(w.printed.join('\n'), 'Password saved to')
    assertEquals(w.exitCodes, [])

    // The next run finds it and asks nothing.
    const again = await world(works)
    try {
      await Deno.writeTextFile(again.path, `encrypted_password: ${HASH}\n`)
      assertEquals(await genPasswordYml(again.deps), true)
      assertEquals(again.asked(), 0)
      assertStringIncludes(again.printed.join('\n'), 'already exists')
      assertEquals(await read(again.path), `encrypted_password: ${HASH}\n`)
    } finally {
      await Deno.remove(again.dir, { recursive: true })
    }
  } finally {
    await Deno.remove(w.dir, { recursive: true })
  }
})

Deno.test('a password file that cannot be read stops the run with exit code 1', async () => {
  const w = await world(works)
  try {
    w.deps.readText = () => Promise.reject(new Error('permission denied'))
    assertEquals(await genPasswordYml(w.deps), false)
    assertEquals(w.exitCodes, [1])
    assertEquals(w.asked(), 0)
    assertStringIncludes(
      w.printed.join('\n'),
      'cannot be read: permission denied',
    )
    await assertRejects(() => Deno.stat(w.path), Deno.errors.NotFound)
  } finally {
    await Deno.remove(w.dir, { recursive: true })
  }
})

Deno.test('every init that sets the password stops when it was not saved', async () => {
  for (
    const path of [
      'src/validator/init/initMainnetConfig.ts',
      'src/validator/init/initTestnetConfig.ts',
      'src/rpc/init/devnetInitRpc.ts',
      'src/rpc/init/mainnetInitRpc.ts',
      'src/rpc/init/testnetInitRpc.ts',
    ]
  ) {
    const source = await Deno.readTextFile(
      new URL(`../../${path}`, import.meta.url),
    )
    assertStringIncludes(source, 'if (!await genPasswordYml()) return', path)
  }
})

Deno.test('validator init password failure returns before inventory, versions and server mutations in both networks', async () => {
  const dir = await Deno.makeTempDir({ prefix: 'slv-init-password-' })
  try {
    const mocks = new URL('./_initPasswordMocks.ts', import.meta.url).href
    const imports: Record<string, string> = {
      '@cmn/': new URL('../../../cmn/', import.meta.url).href,
    }
    for (
      const name of [
        '/src/validator/init/accounts.ts',
        '/src/validator/init/inventory.ts',
        '/lib/genPasswordYml.ts',
        '/lib/genOrReadVersions.ts',
        '/src/validator/init/genSolvUser.ts',
        '/lib/optimizeNode.ts',
        '/lib/addMainnetInventory.ts',
        '/lib/fdctlMainnetGuard.ts',
        '/lib/jito/findNearestRegion.ts',
        '/lib/jito/jitoRegions.ts',
        '/lib/snapshot/findNearestSnapshot.ts',
        '/src/validator/init/promptXdpConfig.ts',
        '/src/validator/init/setupPlan.ts',
        '@cliffy/colors',
        '@cliffy/prompt',
        '@cmn/constants/path.ts',
        '@cmn/constants/config.ts',
        '@cmn/prompt/checkSSHConnection.ts',
      ]
    ) imports[name] = mocks
    const importMap = `${dir}/imports.json`
    await Deno.writeTextFile(importMap, JSON.stringify({ imports }))
    const runner = `${dir}/scenario.ts`
    const mainnet =
      new URL('../../src/validator/init/initMainnetConfig.ts', import.meta.url)
        .href
    const testnet =
      new URL('../../src/validator/init/initTestnetConfig.ts', import.meta.url)
        .href
    await Deno.writeTextFile(
      runner,
      `
import { initMainnetConfig } from ${JSON.stringify(mainnet)}
import { initTestnetConfig } from ${JSON.stringify(testnet)}
import { calls, reset } from ${JSON.stringify(mocks)}
const connection = { ip: '203.0.113.1', username: 'operator', rsa_key_path: '/tmp/unused-key' }
for (const init of [initMainnetConfig, initTestnetConfig]) {
 for (const advanced of [false, true]) {
  for (const saved of [false, true]) {
    reset(saved)
    await init(connection, false, { advanced })
    const expected = saved
      ? ['accounts', 'password', 'versions', 'save', 'server-user', ...(advanced ? ['optimize'] : [])]
      : ['accounts', 'password']
    if (JSON.stringify(calls) !== JSON.stringify(expected)) {
      throw new Error(init.name + ': password saved=' + saved + ', calls=' + JSON.stringify(calls))
    }
  }
 }
}
`,
    )
    const result = await new Deno.Command(Deno.execPath(), {
      args: [
        'run',
        '--check',
        '--no-config',
        '--import-map',
        importMap,
        runner,
      ],
      stdin: 'null',
      stdout: 'piped',
      stderr: 'piped',
    }).output()
    assert(result.success, new TextDecoder().decode(result.stderr))
  } finally {
    await Deno.remove(dir, { recursive: true })
  }
})

// ---------------------------------------------------------------------------
// The salt of a hash, and the mode of the file
// ---------------------------------------------------------------------------

const DIGEST =
  'Vq8sIeY6PPp7LXVIFvUCxFTP4U5X4Nn9lp3GmBiGHwFLa5tTmD5wpDNRqkSnVMPnV4fMl4G2fuBLhYtVtzFkr0'

/** Hashes that `openssl passwd -6 -stdin` made of the passwords fixture-password-1, -2 and -3. */
const REAL_HASHES: [string, string, string][] = [
  [
    'fixture-password-1',
    'tevPzUfuOPD9EYnb',
    '$6$tevPzUfuOPD9EYnb$poD8dOuIWbfquzPKHHk3rZA7rR4hAhKq9ZJcQP/di7CeJDCENCG1se0Jbges34qBwcqMRBFg/sH08eQp2IrvS1',
  ],
  [
    'fixture-password-2',
    'Kdi5DjzOFjQ6r.0F',
    '$6$Kdi5DjzOFjQ6r.0F$yyM4jIrx3Pz8K359QDnQdJMZ4cErJnOEtpZVwChiVMuGX198vE.VKltvT8c7U3r0vsfjOO6tyMpmgYFikIokn.',
  ],
  [
    'fixture-password-3',
    '1dI6Xtg7.KEpZLv3',
    '$6$1dI6Xtg7.KEpZLv3$L6WleAE.wZE5XeYIb1BIfKb16ZlDEbGc6mkxB4tP4hQ8JJKyFFb7beeIowyT3NaCWajFdBWQNRCSYRG8rqfp61',
  ],
]

/** The hash that the openssl of this machine makes of a password, or null when it makes none (the openssl of macOS has no -6). */
const opensslHash = async (
  password: string,
  salt?: string,
): Promise<string | null> => {
  try {
    const child = new Deno.Command('openssl', {
      args: [
        'passwd',
        '-6',
        ...(salt === undefined ? [] : ['-salt', salt]),
        '-stdin',
      ],
      stdin: 'piped',
      stdout: 'piped',
      stderr: 'null',
    }).spawn()
    const writer = child.stdin.getWriter()
    await writer.write(new TextEncoder().encode(password))
    await writer.close()
    const out = await child.output()
    const text = new TextDecoder().decode(out.stdout).trim()
    return out.success && text.startsWith('$6$') ? text : null
  } catch (_error) {
    return null
  }
}
const OPENSSL_MAKES_HASHES = await opensslHash('probe') !== null

const BAD_SALTS: [string, string][] = [
  ['a colon', 'sa:lt'],
  ['a newline', 'sa\nlt'],
  ['a carriage return', 'sa\rlt'],
  ['a space', 'sa lt'],
  ['a dollar sign', 'sa$lt'],
  ['an equals sign (rounds=5000)', 'rounds=5000'],
  ['a comma', 'sa,lt'],
  ['17 characters', 'a'.repeat(17)],
  ['a character that is not ASCII', 'saé'],
  ['no character', ''],
]

Deno.test('a hash has a salt of 1 to 16 characters of ./0-9A-Za-z: a colon, a newline or any other character in the salt, or 17 characters, make the text no hash, in the pattern and in a password file, while the hashes that openssl passwd -6 makes still pass', async () => {
  for (const [name, salt] of BAD_SALTS) {
    const hash = `$6$${salt}$${DIGEST}`
    assertEquals(SHA512_CRYPT_HASH.test(hash), false, name)
    assertEquals(
      holdsValidHash(`encrypted_password: ${JSON.stringify(hash)}\n`),
      false,
      `${name}: in a file`,
    )
  }
  for (
    const salt of [
      'a',
      'saltsalt',
      'a'.repeat(16),
      './09AZaz',
      'Z./z9A0.Z/z9A0.Z',
    ]
  ) {
    const hash = `$6$${salt}$${DIGEST}`
    assert(SHA512_CRYPT_HASH.test(hash), salt)
    assert(
      holdsValidHash(`encrypted_password: ${hash}\n`),
      `${salt}: in a file`,
    )
  }
  // The hashes that openssl passwd -6 makes: three real ones, and more made now when this openssl can.
  for (const [, , hash] of REAL_HASHES) {
    assert(SHA512_CRYPT_HASH.test(hash), hash)
    assert(holdsValidHash(`encrypted_password: ${hash}\n`), hash)
  }
  if (!OPENSSL_MAKES_HASHES) return
  // The fixtures are what openssl makes of those passwords with those salts.
  for (const [password, salt, hash] of REAL_HASHES) {
    assertEquals(await opensslHash(password, salt), hash, password)
  }
  // Every salt that openssl makes by itself is 16 characters of the alphabet.
  for (let i = 0; i < 25; i++) {
    const hash = (await opensslHash(`password ${i}`))!
    assert(SHA512_CRYPT_HASH.test(hash), hash)
  }
})

Deno.test('a hash with such a salt is not saved when openssl prints it, and a file that holds one counts as missing', async () => {
  for (const [name, salt] of BAD_SALTS.slice(0, 3)) {
    const bad = `$6$${salt}$${DIGEST}`
    const printing = await world(() =>
      Promise.resolve({ success: true, stdout: `${bad}\n` })
    )
    try {
      assertEquals(await genPasswordYml(printing.deps), false, name)
      assertEquals(
        await read(printing.path),
        null,
        `${name}: a file was written`,
      )
      assertEquals(printing.exitCodes, [1], name)
      assertStringIncludes(printing.printed.join('\n'), 'was not saved', name)
    } finally {
      await Deno.remove(printing.dir, { recursive: true })
    }

    const existing = await world(works)
    try {
      await Deno.writeTextFile(
        existing.path,
        `encrypted_password: ${JSON.stringify(bad)}\n`,
      )
      assertEquals(await genPasswordYml(existing.deps), true, name)
      assertEquals(
        existing.asked(),
        1,
        `${name}: the password was not asked again`,
      )
      assertStringIncludes(
        existing.printed.join('\n'),
        'no valid password hash',
        name,
      )
      assertEquals(
        (parse(await Deno.readTextFile(existing.path)) as Record<
          string,
          string
        >)
          .encrypted_password,
        HASH,
        name,
      )
    } finally {
      await Deno.remove(existing.dir, { recursive: true })
    }
  }
})

Deno.test('a password file that holds a valid hash is kept as it is with mode 0600, also when it had another mode, and the run stops when the mode cannot be set', async () => {
  for (const before of [0o600, 0o644, 0o666]) {
    const w = await world(works)
    try {
      await Deno.writeTextFile(w.path, `encrypted_password: ${HASH}\n`)
      await Deno.chmod(w.path, before)
      // The mode setter of the project, not the one of the test.
      const { restrictMode: _restrictMode, ...withTheDefaultSetter } = w.deps
      assertEquals(await genPasswordYml(withTheDefaultSetter), true)
      assertEquals(w.asked(), 0)
      assertEquals(w.exitCodes, [])
      assertEquals(
        ((await Deno.stat(w.path)).mode! & 0o777).toString(8),
        '600',
        before.toString(8),
      )
      assertEquals(await read(w.path), `encrypted_password: ${HASH}\n`)
    } finally {
      await Deno.remove(w.dir, { recursive: true })
    }
  }
  // A mode that cannot be set is an error with exit code 1, not a file left readable.
  const stuck = await world(works)
  try {
    await Deno.writeTextFile(stuck.path, `encrypted_password: ${HASH}\n`)
    stuck.deps.restrictMode = () =>
      Promise.reject(new Error('Operation not permitted'))
    assertEquals(await genPasswordYml(stuck.deps), false)
    assertEquals(stuck.exitCodes, [1])
    assertEquals(stuck.asked(), 0)
    const text = stuck.printed.join('\n')
    assertStringIncludes(text, 'Operation not permitted')
    assertStringIncludes(text, `chmod 600 ${stuck.path}`)
    assertEquals(text.includes('already exists'), false)
  } finally {
    await Deno.remove(stuck.dir, { recursive: true })
  }
})

Deno.test('the password file is written with mode 0600, also over a file that had another mode, and no other file is left beside it', async () => {
  for (const before of [null, 0o644, 0o666]) {
    const w = await world(works)
    try {
      if (before !== null) {
        // A file without a valid hash counts as missing and is replaced.
        await Deno.writeTextFile(w.path, "encrypted_password: ''\n")
        await Deno.chmod(w.path, before)
      }
      // The writer of the project, not the one of the test.
      const { writeText: _writeText, ...withTheDefaultWriter } = w.deps
      assertEquals(await genPasswordYml(withTheDefaultWriter), true)
      const mode = (await Deno.stat(w.path)).mode!
      assertEquals((mode & 0o777).toString(8), '600', String(before))
      assertEquals(await read(w.path), `encrypted_password: >-\n  ${HASH}\n`)
      assertEquals(
        [...Deno.readDirSync(w.dir)].map((entry) => entry.name),
        ['config.pwd.yml'],
      )
    } finally {
      await Deno.remove(w.dir, { recursive: true })
    }
  }
})
