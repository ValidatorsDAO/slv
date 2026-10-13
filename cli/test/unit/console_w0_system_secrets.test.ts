import {
  assert,
  assertEquals,
  assertFalse,
  assertStringIncludes,
} from '@std/assert'

import { classifyCommand, decideCommandGate } from '@/ai/console/commandGate.ts'
import { keyMaterialInWord } from '@/ai/console/keyMaterial.ts'
import { isReadOnlyLine } from '@/ai/console/readOnly.ts'
import { fileToolRefusal } from '@/ai/console/toolSafety.ts'
import * as tools from '@/ai/console/tools.ts'

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

const reasonsOf = (line: string): string =>
  classifyCommand(line).reasons.join(' | ')

const PASSWORD_FILES = [
  '/etc/shadow',
  '/etc/gshadow',
  '/etc/shadow-',
  '/etc/gshadow-',
]
const HOST_KEYS = [
  '/etc/ssh/ssh_host_rsa_key',
  '/etc/ssh/ssh_host_ecdsa_key',
  '/etc/ssh/ssh_host_ed25519_key',
  '/etc/ssh/ssh_host_dsa_key',
]
const MEMORY = [
  '/proc/kcore',
  '/proc/self/mem',
  '/proc/thread-self/mem',
  '/proc/1234/mem',
  '/proc/self/task/12/mem',
  '/dev/mem',
  '/dev/kmem',
  '/dev/port',
]
const REFUSED = [...PASSWORD_FILES, ...HOST_KEYS, ...MEMORY]

Deno.test('a path to a password hash file, an SSH host private key, kernel or process memory or a memory device needs a person', () => {
  for (const path of REFUSED) {
    for (
      const line of [
        `cat ${path}`,
        `head -n 1 ${path}`,
        `tail ${path}`,
        `grep x ${path}`,
        `wc -c ${path}`,
      ]
    ) needsAPerson(line)
  }
  assertStringIncludes(reasonsOf('cat /etc/shadow'), 'the password hashes')
  assertStringIncludes(reasonsOf('cat /etc/gshadow-'), 'the password hashes')
  assertStringIncludes(
    reasonsOf('cat /etc/ssh/ssh_host_ed25519_key'),
    'an SSH host private key',
  )
  assertStringIncludes(
    reasonsOf('cat /proc/kcore'),
    'the memory of the kernel',
  )
  assertStringIncludes(
    reasonsOf('head -c 8 /proc/self/mem'),
    'the memory of a process',
  )
  assertStringIncludes(
    reasonsOf('cat /dev/port'),
    'the memory or the I/O ports',
  )
})

Deno.test('the same paths are held in the other ways a line can name them', () => {
  for (
    const line of [
      // spelling
      'cat //etc//shadow',
      'cat /etc/./shadow',
      'cat /etc/x/../shadow',
      'cat /ETC/SHADOW',
      "cat '/etc/shadow'",
      'cat "/etc/shadow"',
      'cat /etc/sha\\dow',
      'cat --file=/etc/shadow',
      'cat /proc/self/root/etc/shadow',
      'cat /proc/1/root/etc/ssh/ssh_host_rsa_key',
      'cat /proc/$$/mem',
      'cat /proc/${PPID}/task/$$/mem',
      // braces and globs
      'cat /etc/{shadow,passwd}',
      'cat /etc/shad*',
      'cat /etc/shadow?',
      'cat /etc/gshadow?',
      'cat /etc/gshad*',
      'cat /etc/sh[a]dow',
      'cat /etc/shad?w',
      'cat /etc/shad?w-',
      'cat /etc/gshad?w',
      'cat /etc/gshad?w-',
      'cat /e*/shadow',
      'cat /etc/s*',
      'cat /etc/ssh/ssh_host_*',
      'cat /etc/ssh/ssh_host_r*',
      'cat /etc/ssh/ssh_host_d*',
      'cat /etc/ssh/ssh_host_ec*',
      'cat /etc/ssh/ssh_host_ed*',
      'cat /etc/ssh/*_key',
      'cat /etc/ssh/ssh_host_*_key',
      'cat /proc/k*',
      'cat /proc/kc?re',
      'cat /proc/*/mem',
      'cat /proc/s*/mem',
      'cat /proc/t*/mem',
      'cat /proc/1*/mem',
      'cat /proc/self/task/*/mem',
      'cat /proc/self/t*/*/mem',
      'cat /proc/2*/task/1*/mem',
      'cat /proc/self/task/12*/mem',
      'cat /proc/[0-9]/mem',
      'cat /p*/2970430/mem',
      'cat /proc/29*0/mem',
      'cat /pr[o]c/[0-9]*/task/*/mem',
      'cat /proc/self/root/etc/?sh/ssh_host_rsa_key',
      'cat /proc/self/root/etc/s[sx]h/ssh_host_*',
      'cat /proc/1/root/p[rx]oc/self/mem',
      'cat /e*/s*',
      'cat /*/shadow',
      // a relative word that writes out part of the path, or climbs to the root
      'cat etc/s*',
      'cat etc/*',
      'cat ../../../etc/shad*',
      'cat ../../../etc/sh[a]dow',
      'cat ../../../e*/shad*',
      'cat ../../../../../../../../e*/s*',
      'cat ../../dev/m*',
      'cat ../../proc/k*',
      'cat /dev/m*',
      'cat /dev/k*',
      'cat /dev/p*',
      'cat /dev/m?m',
      'cat /dev/[k]mem',
      // another program, a redirection, a shell, a directory the line changed to
      'sort /etc/shadow',
      'cut -d: -f1,2 /etc/shadow',
      'strings /dev/mem',
      'xxd /proc/kcore',
      'cat < /etc/shadow',
      'xargs cat < /etc/gshadow',
      'echo /etc/shadow',
      "bash -c 'cat /etc/shadow'",
      'cd /etc && cat shadow',
      'cd /etc; head gshadow-',
      'cd /etc/ssh && cat ssh_host_ed25519_key',
      'cd /etc/ssh && cat ssh_host_*',
      'cd /proc && cat kcore',
      'cd /dev; head -c 4 mem',
    ]
  ) needsAPerson(line)
})

Deno.test('what lies next to those paths stays readable', () => {
  for (
    const line of [
      'cat /etc/passwd',
      'cat /etc/group',
      'cat /etc/hosts',
      'cat /etc/ssh/sshd_config',
      'cat /etc/ssh/ssh_config',
      'cat /etc/ssh/ssh_host_ed25519_key.pub',
      'cat /etc/ssh/ssh_host_*.pub',
      'cat /etc/ssh/ssh_host_rsa_key-cert.pub',
      'cat /etc/*release',
      'cat /etc/s*release',
      'cat /etc/*.conf',
      'cat /etc/ssh/*.conf',
      'ls /etc/ssh/sshd_config.d/*',
      'cat /proc/*/status',
      'cat /proc/[0-9]*/cmdline',
      'cat /proc/*/maps',
      'cat /proc/a*/mem',
      'cat /proc//m*',
      'cat /proc/[a-z]1/mem',
      'cat */*',
      'ls */*',
      'cat docs/*/*.md',
      'grep -n x src/*/*.ts',
      'cat ../*/*.md',
      'cat ../src/*',
      'cat /proc/cpuinfo',
      'cat /proc/meminfo',
      'cat /proc/self/status',
      'cat /proc/self/maps',
      'cat /proc/self/memory',
      'cat /proc/kcore2',
      'cat /dev/null',
      'cat /dev/memory',
      'cat /dev/ports',
      'head -c 4 /dev/urandom',
      'ls /dev/sd*',
      'ls /etc/ssh',
      'grep root /etc/passwd',
    ]
  ) runsAlone(line)
})

Deno.test('a recursive search of /etc, /etc/ssh or /dev needs a person, one of their subdirectories does not', () => {
  for (
    const line of [
      'grep -r root /etc',
      'grep -r root /etc/',
      'grep -rn root /etc/ssh',
      'rg root /etc',
      'rg --hidden root /etc/ssh',
      'diff -r /etc /tmp/etc-copy',
      'grep -r x /dev',
      'grep -r x /dev/',
      'grep -r x /etc/ssh/..',
      'grep -r x /ETC',
    ]
  ) needsAPerson(line)
  assertStringIncludes(reasonsOf('grep -r root /etc'), '/etc')
  for (
    const line of [
      'grep -r Port /etc/ssh/sshd_config.d',
      'grep -r x /etc/systemd',
      'rg x /etc/nginx',
      'grep -r x /dev/shm',
    ]
  ) runsAlone(line)
})

Deno.test('read_file, list_files and write_file refuse those paths and handle the ones next to them', async () => {
  for (const path of REFUSED) {
    const read = await fileToolRefusal('read_file', path)
    assert(
      read !== null && read.startsWith('Error: read_file does not read '),
      `read_file ${path}: ${read}`,
    )
    const list = await fileToolRefusal('list_files', path)
    assert(
      list !== null && list.startsWith('Error: list_files does not list '),
      `list_files ${path}: ${list}`,
    )
    const write = await fileToolRefusal('write_file', path)
    assert(write !== null && write.startsWith('Error'), `write_file ${path}`)
  }
  for (
    const path of [
      '//etc//shadow',
      '/etc/x/../shadow',
      '/ETC/SHADOW',
      '/etc/./ssh/ssh_host_rsa_key',
      '/dev/../dev/mem',
    ]
  ) {
    const read = await fileToolRefusal('read_file', path)
    assert(read !== null, `read_file ${path}`)
  }
  for (
    const path of [
      '/etc/passwd',
      '/etc/ssh',
      '/etc/ssh/sshd_config',
      '/etc/ssh/ssh_host_ed25519_key.pub',
      '/proc/cpuinfo',
      '/proc/self/status',
      '/dev/null',
      '/dev',
    ]
  ) {
    assertEquals(await fileToolRefusal('read_file', path), null, path)
    assertEquals(await fileToolRefusal('list_files', path), null, path)
  }
  // the tool itself refuses before it opens the file
  for (const path of ['/etc/shadow', '/etc/ssh/ssh_host_ed25519_key']) {
    const content = await tools.executeTool('read_file', { path })
    assertStringIncludes(content, 'read_file does not read ')
  }
})

Deno.test('read_file follows a link to those paths', {
  ignore: Deno.build.os !== 'linux',
}, async () => {
  const through = await fileToolRefusal(
    'read_file',
    '/proc/self/root/etc/shadow',
  )
  assert(through !== null, 'read_file through /proc/self/root')
  const dir = await Deno.makeTempDir({ prefix: 'console-w0-system-' })
  try {
    await Deno.symlink('/proc/kcore', `${dir}/innocent.txt`)
    const linked = await fileToolRefusal('read_file', `${dir}/innocent.txt`)
    assert(linked !== null, 'read_file through a link to /proc/kcore')
  } finally {
    await Deno.remove(dir, { recursive: true })
  }
})

Deno.test('the command gate and the file tools name the same paths, for the same reason', async () => {
  for (const path of REFUSED) {
    const gate = keyMaterialInWord(path)
    assert(gate !== null, `the command gate does not name ${path}`)
    const refusal = await fileToolRefusal('read_file', path)
    assert(refusal !== null, `the file tools do not refuse ${path}`)
    assertStringIncludes(refusal, gate)
  }
  for (
    const path of [
      '/etc/passwd',
      '/etc/ssh/sshd_config',
      '/etc/ssh/ssh_host_ed25519_key.pub',
      '/proc/cpuinfo',
      '/dev/null',
    ]
  ) {
    assertEquals(keyMaterialInWord(path), null, path)
    assertEquals(await fileToolRefusal('read_file', path), null, path)
  }
  assertFalse(classifyCommand('cat /etc/passwd').gated)
})
