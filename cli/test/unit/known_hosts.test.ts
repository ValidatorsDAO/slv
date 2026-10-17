import { assertEquals } from '@std/assert'
import {
  findHostKeys,
  hostForms,
  parseScan,
  pinLines,
  withPins,
} from '/lib/ssh/knownHosts.ts'

// Host keys made with ssh-keygen; the fingerprints are what `ssh-keygen -l`
// printed for them.
const ED_1 =
  'AAAAC3NzaC1lZDI1NTE5AAAAIJey4pRQbkl/YXPZyv2N/7zA86yiJjBKa87y5SxxyeL+'
const ED_1_FINGERPRINT = 'SHA256:tug+Nsa0W463DpKSTAmfelWUhRYIv+k250avQuKO3ko'
const ED_2 =
  'AAAAC3NzaC1lZDI1NTE5AAAAINJvnBfiD9Vj3rDfZh0fZPrTa41lMuHZFPhOX2t3h8cu'
const ED_2_FINGERPRINT = 'SHA256:SHwFuOAyKZj8ZjqNCQ/vL81gV2+1z4DOqBG8tb6N29k'
const ECDSA =
  'AAAAE2VjZHNhLXNoYTItbmlzdHAyNTYAAAAIbmlzdHAyNTYAAABBBB68ouA1ARfIAE5QVraNOngbAfGa3bfKN3KChxGJaxadLEKoKm4XcL9HcBLaLtHeEbhTyVg7EnnFebM/2Q5goGE='
const ECDSA_FINGERPRINT = 'SHA256:1j1u8Q0RcXVX4di7UyVfNPwZ+Lo1EDhq0LU4xYrQGM4'
// A type that is not pinned, in a blob that says so.
const DSS = btoa(
  String.fromCharCode(
    0,
    0,
    0,
    7,
    ...new TextEncoder().encode('ssh-dss'),
    1,
    2,
    3,
  ),
)

// The line that `ssh-keygen -H` made of `[127.0.0.1]:22888 ssh-ed25519 <ED_1>`.
const HASHED =
  `|1|AA6wnhUQ5EwF0aRbtbW4LKM8EYk=|asIkW5lnKAvgLId6WtffxsbEMFM= ssh-ed25519 ${ED_1}`

Deno.test('the keys that ~/.ssh/known_hosts holds for a host are found in its plain, [host]:port and hashed forms, with the fingerprint that ssh-keygen prints', async () => {
  const text = [
    '# a comment',
    '',
    `203.0.113.7 ssh-ed25519 ${ED_1} laptop`,
    `[203.0.113.7]:2222,node.example.com ssh-ed25519 ${ED_2}`,
    `203.0.113.7 ecdsa-sha2-nistp256 ${ECDSA}`,
    HASHED,
  ].join('\n')

  assertEquals(hostForms('203.0.113.7', 22), [
    '203.0.113.7',
    '[203.0.113.7]:22',
  ])
  assertEquals(hostForms('203.0.113.7', 2222), ['[203.0.113.7]:2222'])

  assertEquals(await findHostKeys(text, '203.0.113.7', 22), [
    { keyType: 'ssh-ed25519', base64: ED_1, fingerprint: ED_1_FINGERPRINT },
    {
      keyType: 'ecdsa-sha2-nistp256',
      base64: ECDSA,
      fingerprint: ECDSA_FINGERPRINT,
    },
  ])
  assertEquals(await findHostKeys(text, '203.0.113.7', 2222), [
    { keyType: 'ssh-ed25519', base64: ED_2, fingerprint: ED_2_FINGERPRINT },
  ])
  // A hashed name is the name and the port together.
  assertEquals(
    (await findHostKeys(text, '127.0.0.1', 22888)).map((key) =>
      key.fingerprint
    ),
    [ED_1_FINGERPRINT],
  )
  assertEquals(await findHostKeys(text, '127.0.0.1', 22), [])
  assertEquals(await findHostKeys(text, '127.0.0.2', 22888), [])
})

Deno.test('a line with a wildcard, a marker, another host, a type that is not pinned or a blob that is not its type gives no key, and a revoked key is dropped', async () => {
  const text = [
    `*.example.com ssh-ed25519 ${ED_1}`,
    `node.example.com,!node.example.com ssh-ed25519 ${ED_1}`,
    `@cert-authority 203.0.113.7 ssh-ed25519 ${ED_2}`,
    `203.0.113.8 ssh-ed25519 ${ED_2}`,
    `203.0.113.7 ssh-dss ${DSS}`,
    `203.0.113.7 ssh-rsa ${ED_1}`,
    `203.0.113.7 ssh-ed25519 not-base64!`,
    `203.0.113.7 ssh-ed25519`,
  ].join('\n')
  assertEquals(await findHostKeys(text, '203.0.113.7', 22), [])
  assertEquals(await findHostKeys(text, 'node.example.com', 22), [])
  assertEquals(await findHostKeys(text, 'a.example.com', 22), [])

  const revoked = [
    `203.0.113.7 ssh-ed25519 ${ED_1}`,
    `203.0.113.7 ssh-ed25519 ${ED_2}`,
    `@revoked * ssh-ed25519 ${ED_1}`,
  ].join('\n')
  assertEquals(
    (await findHostKeys(revoked, '203.0.113.7', 22)).map((key) =>
      key.fingerprint
    ),
    [ED_2_FINGERPRINT],
  )
})

Deno.test('ssh-keyscan output is read key by key, and the lines of a pin are added to the pins once', async () => {
  const scan = [
    '# 127.0.0.1:22888 SSH-2.0-OpenSSH_9.6p1',
    `[127.0.0.1]:22888 ssh-ed25519 ${ED_1}`,
    `[127.0.0.1]:22888 ecdsa-sha2-nistp256 ${ECDSA}`,
    `[127.0.0.1]:22888 ssh-ed25519 ${ED_1}`,
    `[127.0.0.1]:22888 ssh-dss ${DSS}`,
    'a line that is no key',
  ].join('\n')
  const keys = await parseScan(scan)
  assertEquals(keys.map((key) => key.fingerprint), [
    ED_1_FINGERPRINT,
    ECDSA_FINGERPRINT,
  ])
  assertEquals(await parseScan('# only a comment\n'), [])

  const alias = '[127.0.0.1]:22888'
  const lines = pinLines(alias, keys)
  assertEquals(lines, [
    `${alias} ssh-ed25519 ${ED_1}`,
    `${alias} ecdsa-sha2-nistp256 ${ECDSA}`,
  ])
  const once = withPins(null, lines)
  assertEquals(once, `${lines.join('\n')}\n`)
  // Adding them again changes nothing; a file without a final newline gets one.
  assertEquals(withPins(once, lines), once)
  assertEquals(
    withPins('[10.0.0.1]:22 ssh-ed25519 AAAA', lines),
    `[10.0.0.1]:22 ssh-ed25519 AAAA\n${lines.join('\n')}\n`,
  )
})

Deno.test('ssh-keygen finds the pin lines under the alias, which is how ssh looks them up', async () => {
  const alias = '[127.0.0.1]:22888'
  const dir = await Deno.makeTempDir()
  try {
    const file = `${dir}/known_hosts`
    await Deno.writeTextFile(
      file,
      withPins(
        null,
        pinLines(alias, await parseScan(`${alias} ssh-ed25519 ${ED_1}`)),
      ),
    )
    const found = await new Deno.Command('ssh-keygen', {
      args: ['-F', alias, '-f', file],
      stdout: 'piped',
      stderr: 'piped',
    }).output()
    assertEquals(found.success, true)
    assertEquals(
      new TextDecoder().decode(found.stdout).includes(
        `${alias} ssh-ed25519 ${ED_1}`,
      ),
      true,
    )
    // The port is part of the name: the bare address is not the same host.
    const bare = await new Deno.Command('ssh-keygen', {
      args: ['-F', '127.0.0.1', '-f', file],
      stdout: 'piped',
      stderr: 'piped',
    }).output()
    assertEquals(bare.success, false)
  } finally {
    await Deno.remove(dir, { recursive: true })
  }
})
