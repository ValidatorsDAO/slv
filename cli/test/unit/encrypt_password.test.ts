import { assert, assertEquals, assertStringIncludes } from '@std/assert'
import {
  encryptPassword,
  type EncryptPasswordDeps,
} from '/lib/encryptPassword.ts'

// Spaces, both kinds of quote, a backslash, $, ; and & and a letter outside
// ASCII: a password that an argument list or a shell would not take as typed.
const PASSWORD = 'Pa ss\'w"o\\rd $HOME; & é!'

type Call = { command: string; args: string[]; stdin: string }

/** The real openssl with `stdin` as its input, or null when there is none to run. */
const openssl = async (
  args: string[],
  stdin: string,
): Promise<{ success: boolean; stdout: string } | null> => {
  try {
    const child = new Deno.Command('openssl', {
      args,
      stdin: 'piped',
      stdout: 'piped',
      stderr: 'null',
    }).spawn()
    const writer = child.stdin.getWriter()
    await writer.write(new TextEncoder().encode(stdin))
    await writer.close()
    const { success, stdout } = await child.output()
    return { success, stdout: new TextDecoder().decode(stdout) }
  } catch (_error) {
    return null
  }
}

Deno.test('encryptPassword gives the password to openssl on stdin and in no argument, and returns the hash without its newline', async () => {
  const calls: Call[] = []
  const printed: string[] = []
  const hash = await encryptPassword(PASSWORD, {
    spawn: (command, args, stdin) => {
      calls.push({ command, args, stdin })
      return Promise.resolve({ success: true, stdout: '$6$salt$digest\n' })
    },
    error: (line) => printed.push(line),
  })
  assertEquals(hash, '$6$salt$digest')
  assertEquals(printed, [])
  assertEquals(calls.length, 1)
  // openssl itself, not a shell, and nothing of the password in the arguments
  // that the list of processes shows.
  assertEquals(calls[0].command, 'openssl')
  assertEquals(calls[0].args, ['passwd', '-6', '-stdin'])
  // The password reaches openssl as the one line it reads, as typed.
  assertEquals(calls[0].stdin, `${PASSWORD}\n`)

  // With the real openssl, when there is one that makes $6$ hashes, the hash is
  // the one of the password as typed.
  const probe = await openssl(
    ['passwd', '-6', '-salt', 'probe', '-stdin'],
    'x\n',
  )
  if (probe === null || !probe.success) return
  const real = await encryptPassword(PASSWORD)
  const [, id, salt, digest] = real.split('$')
  assertEquals(id, '6')
  assert(salt.length > 0 && digest.length > 0, real)
  assertEquals(real.includes('\n'), false)
  const again = await openssl(
    ['passwd', '-6', '-salt', salt, '-stdin'],
    `${PASSWORD}\n`,
  )
  assertEquals(again?.stdout.trim(), real)
})

Deno.test('encryptPassword says how to install openssl and returns nothing when openssl is missing, stops with an error or makes no hash, and prints no password', async () => {
  const cases: [string, EncryptPasswordDeps['spawn']][] = [
    [
      'openssl is missing',
      () => Promise.reject(new Deno.errors.NotFound('spawn openssl')),
    ],
    [
      'openssl stops with an error',
      () => Promise.resolve({ success: false, stdout: 'Usage: passwd\n' }),
    ],
    [
      'openssl makes no hash',
      () => Promise.resolve({ success: true, stdout: '\n' }),
    ],
  ]
  for (const [name, spawn] of cases) {
    const printed: string[] = []
    const hash = await encryptPassword(PASSWORD, {
      spawn,
      error: (line) => printed.push(line),
    })
    assertEquals(hash, '', name)
    const text = printed.join('\n')
    assertStringIncludes(
      text,
      'Please install openssl (MacOS: brew install openssl)',
      name,
    )
    // Not the password, and not a piece of it.
    for (const piece of [PASSWORD, "ss'w", '$HOME']) {
      assertEquals(text.includes(piece), false, `${name}: ${piece}`)
    }
  }
})
