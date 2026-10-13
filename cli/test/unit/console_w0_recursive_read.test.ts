import {
  assert,
  assertEquals,
  assertFalse,
  assertStringIncludes,
} from '@std/assert'

import { classifyCommand, decideCommandGate } from '@/ai/console/commandGate.ts'
import { isReadOnlyLine } from '@/ai/console/readOnly.ts'

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
  assertEquals(decide(line, true), 'confirm', line)
  assertEquals(decide(line, false), 'refuse', line)
}

const runsAlone = (line: string): void => {
  assertEquals(decide(line, false), 'run', line)
  assertEquals(decide(line, true), 'run', line)
}

const reasonsOf = (line: string): string =>
  classifyCommand(line).reasons.join(' | ')

/** `fn` with HOME set to `home`, and HOME put back. */
const withOwnHome = async (
  home: string,
  fn: () => void | Promise<void>,
): Promise<void> => {
  const before = Deno.env.get('HOME')
  Deno.env.set('HOME', home)
  try {
    await fn()
  } finally {
    if (before === undefined) Deno.env.delete('HOME')
    else Deno.env.set('HOME', before)
  }
}

Deno.test('a recursive reader of a directory that holds a refused class needs a person, and one of a directory elsewhere runs', () => {
  for (
    const line of [
      'grep -r token ~/.slv',
      'rg token ~/.slv',
      'grep -r token ~',
      'rg --hidden token ~',
      'grep -rn . /home/solv/.slv/',
      'diff -r ~/.slv /tmp/x',
      'grep -r x ~/.ssh',
      'rg token',
      'grep -rn x .',
    ]
  ) needsAPerson(line)
  runsAlone('grep -r error /home/solv/logs')
  assertStringIncludes(reasonsOf('grep -r token ~/.slv'), 'recursive grep')
  assertStringIncludes(reasonsOf('rg token'), 'working directory')
})

Deno.test('every spelling of a recursive search is read: -r, -R, the long options, -d recurse and clusters', () => {
  for (
    const line of [
      'grep -r x ~/.slv',
      'grep -R x ~/.slv',
      'grep --recursive x ~/.slv',
      'grep --dereference-recursive x ~/.slv',
      'grep --rec x ~/.slv',
      'grep -d recurse x ~/.slv',
      'grep -drecurse x ~/.slv',
      'grep --directories=recurse x ~/.slv',
      'grep --directories recurse x ~/.slv',
      'grep -rn x ~/.slv',
      'grep -nr x ~/.slv',
      'grep -Eir x ~/.slv',
      'grep x -r ~/.slv',
      'grep x ~/.slv -r',
      'grep -e x -r ~/.slv',
      'grep -r -e x ~/.slv',
      'grep -rf patterns ~/.slv',
      'grep -r --include=*.yml x ~/.slv',
      'grep -r --include *.yml x ~/.slv',
      'grep -r -A 2 -m 3 x ~/.slv',
      'egrep -r x ~/.slv',
      'fgrep -R x ~/.slv',
      'rgrep x ~/.slv',
      'diff -r ~/.slv /srv/b',
      'diff -R ~/.slv /srv/b',
      'diff --recursive ~/.slv /srv/b',
      'diff --rec ~/.slv /srv/b',
      'diff -ru ~/.slv /srv/b',
      'diff -rq ~/.slv /srv/b',
      'diff -Nr ~/.slv /srv/b',
      'diff -r -x "*.o" ~/.slv /srv/b',
      'diff /srv/b ~/.slv -r',
      'rg -n token ~/.slv',
      'rg -i -e token -e secret ~/.slv',
      'rg -g "*.yml" token ~/.slv',
      'rg --glob "*.yml" token ~/.slv',
      'rg --glob="*.yml" token ~/.slv',
      'rg -t yaml token ~/.slv',
      'rg -uu token ~/.slv',
      'rg -l token ~/.slv',
      'rg -- token ~/.slv',
    ]
  ) {
    assert(classifyCommand(line).gated, `not held: ${line}`)
    needsAPerson(line)
  }
})

Deno.test('every kind of operand that is or may be a directory holding a refused class is read', () => {
  const held = [
    '/',
    '/home',
    '/home/',
    '/Users',
    '/root',
    '/root/',
    '~',
    '~/',
    '~root',
    '/home/alice',
    '/home/alice/',
    '/Users/alice',
    '/home/solv',
    '/home/solv/logs/..',
    '/home/solv/./',
    '/home//solv',
    '/home/solv/.slv',
    '/home/solv/.slv/keys',
    '/home/solv/.slv/gateway',
    '/home/alice/.SLV/x',
    '/root/.ssh',
    '/Users/alice/.ssh/keys',
    '/mnt/backup/.slv',
    '/home/solv/.slv/../logs',
    '~/.slv',
    '~/.ssh',
    '/proc',
    '/proc/',
    '/proc/self',
    '/proc/self/task/1',
    '/proc/1',
    '/proc/thread-self',
    '/proc/net/..',
    '.',
    '..',
    './',
    'logs',
    './logs',
    '../logs',
    '~+',
    '~-/x',
    '$HOME',
    '"$LOGDIR"',
    '${HOME}/logs',
    '/home/*',
    '/home/solv/*',
    '/var/log/*.log',
    '/srv/code?',
    '/srv/{a,b}',
    '/srv/[ab]',
  ]
  for (const operand of held) {
    needsAPerson(`grep -r x ${operand}`)
    needsAPerson(`rg x ${operand}`)
    needsAPerson(`diff -r ${operand} /srv/b`)
    needsAPerson(`diff -r /srv/b ${operand}`)
  }
  // with another operand that is fine, one that is held is enough
  needsAPerson('grep -r x /srv/a /home/alice')
  needsAPerson('rg x /srv/a /srv/b ~')
  // no operand at all searches the working directory
  for (
    const line of [
      'grep -r x',
      'grep -r -e x',
      'grep -r x --',
      'grep -rn --include=*.log x',
      'egrep -r x',
      'rgrep x',
      'rg x',
      'rg -n x',
      'rg -e x',
      'rg -e x -e y',
      'rg -f patterns',
    ]
  ) needsAPerson(line)
})

Deno.test('a recursive reader of a literal absolute path elsewhere, and a search that is not recursive, run', () => {
  const held = 'grep -r x ~/.slv'
  needsAPerson(held)
  for (
    const line of [
      'grep -r error /home/solv/logs',
      'grep -rn error /home/solv/agave/',
      'grep -r error /home/alice/work/src',
      'grep -r error /Users/alice/logs',
      'grep -r error ~/logs',
      'grep -r error ~/.cache',
      'grep -r error ~solv/ledger-logs',
      'grep -r error /var/log',
      'grep -r error /var/log/syslog /var/log/auth.log',
      'grep -r error /home/solv/logs/sub/../other',
      'grep -r error /proc/sys/net',
      'grep -rn --include="*.log" error /var/log',
      "grep -r --include '*.log' error /var/log",
      'grep -r --exclude-dir=.git todo /srv/code',
      'grep -r -e foo -e bar /srv/code',
      'grep -r -- -weird /srv/code',
      'grep -d recurse x /srv/x',
      'grep --rec x /srv/x',
      'grep --exclude-d=.git -r x /srv/x',
      'egrep -r x /srv/x',
      'fgrep -R x /srv/y',
      'rg -e foo /srv/code',
      'rg --no-heading --no-line-number foo /srv/code',
      'rg panic /mnt/ledger/logs',
      "rg -g '*.log' panic /mnt/ledger/logs",
      'rg -e foo -e bar /srv/code /srv/more',
      'rg --glob "*.rs" --max-count 3 todo /srv/code',
      'rg --files /home/solv',
      'rg --files',
      'rg --version',
      'diff -r /srv/a /srv/b',
      'diff -ru /srv/a /srv/b',
      'diff -r -x "*.o" /srv/a /srv/b',
      // not recursive
      'ps aux | grep agave',
      'grep -n identity /home/solv/start-validator.sh',
      'grep -i error /var/log/syslog',
      'grep error /home/solv/logs/a.log /home/solv/logs/b.log',
      'journalctl -u solv | grep -c error',
      'tail -n 100 /home/solv/solana-validator.log | grep -i error',
      'grep -E "a|b" /etc/hosts',
      'grep -e x -f /srv/patterns /srv/data',
      'diff /etc/a /etc/b',
      'diff -u /home/solv/a.conf /home/solv/b.conf',
    ]
  ) runsAlone(line)
  // a listing of names is not a read of contents
  for (
    const line of [
      'ls -R ~/.slv',
      'ls -laR /home/solv',
      'du -a ~/.slv',
      'du -sh ~',
    ]
  ) runsAlone(line)
})

Deno.test('a recursive reader is read behind wrappers, paths, shells and assignments', () => {
  for (
    const line of [
      'sudo grep -r token ~/.slv',
      'nice rg token ~/.slv',
      'env grep -r x .',
      'timeout 5 rg token ~',
      'xargs grep -r x',
      'bash -c "grep -r x ~/.ssh"',
      "sh -c 'rg token ~'",
      '/usr/bin/grep -r x ~',
      '/usr/local/bin/rg token ~',
      'FOO=1 grep -r x ~',
      'time grep -r x ~',
      'echo x | rg y ~/.slv',
      'cd /srv && grep -r x ~/.slv',
      '{ grep -r x ~/.slv; }',
      '(rg token ~)',
    ]
  ) {
    assert(classifyCommand(line).gated, `not held: ${line}`)
    assert(
      classifyCommand(line).reasons.some((reason) =>
        reason.includes('recursive')
      ),
      `${line}: ${reasonsOf(line)}`,
    )
  }
})

Deno.test('a recursive reader of the home directory of this process, or of a directory above it, needs a person', async () => {
  await withOwnHome('/srv/people/zed', () => {
    for (
      const line of [
        'grep -r x /srv/people/zed',
        'grep -r x /srv/people/zed/',
        'grep -r x /srv/people',
        'grep -r x /srv',
        'rg x /srv/people/zed/.slv',
        'diff -r /srv/people /srv/b',
      ]
    ) needsAPerson(line)
    for (
      const line of [
        'grep -r x /srv/people/zed/logs',
        'grep -r x /srv/people/other',
        'grep -r x /srv/other',
        'rg x /srv/people/zed/work/src',
      ]
    ) runsAlone(line)
  })
  // HOME that is the root directory is no home
  await withOwnHome('/', () => {
    runsAlone('grep -r error /srv/code')
    needsAPerson('grep -r error /home')
    needsAPerson('grep -r error /')
  })
})

Deno.test('a recursive reader with an option the gate cannot read needs a person', () => {
  for (
    const line of [
      'grep --weird x /srv/a',
      'grep -r --weird x /srv/a',
      'grep -J x /srv/a',
      'egrep -r -Y x /srv/a',
      'rg --weird x /srv/a',
      'rg -r X --unknown-flag foo /srv/a',
      'diff --weird -r /srv/a /srv/b',
      'diff -r -Q /srv/a /srv/b',
    ]
  ) {
    needsAPerson(line)
    assertStringIncludes(reasonsOf(line), 'cannot read')
  }
})

Deno.test('the refused-class paths hold for any home: /home/NAME, /Users/NAME and the home of this process, literal and glob', async () => {
  const lines = [
    'cat /home/fumi/.s?v/api.yml',
    'cat /home/alice/.slv/ap*',
    'cat /Users/alice/.s?v/keys/*',
    'cat /home/alice/.?sh/id_rsa',
  ]
  for (const line of lines) {
    assert(classifyCommand(line).gated, `not gated: ${line}`)
    needsAPerson(line)
  }
  // every class, under each kind of home
  for (
    const home of ['/home/alice', '/Users/alice', '/home/bob.smith', '/root']
  ) {
    for (
      const word of [
        '.slv/api.y?l',
        '.s?v/api.yml',
        '.slv/ap*',
        '.slv/api.*',
        '.slv/keys/*',
        '.s?v/keys/id.json',
        '.slv/gateway/gate*',
        '.slv/backup.e*',
        '.slv/restic-*',
        '.ssh/id_*',
        '.?sh/id_rsa',
        '.ssh/id_ed2551?',
        'identity*.json',
        '*keypair*.json',
      ]
    ) {
      const line = `cat ${home}/${word}`
      assert(classifyCommand(line).gated, `not gated: ${line}`)
    }
  }
  // a name for any user, a pattern for the user too
  for (
    const line of [
      'cat /home/al*/.s?v/api.yml',
      'cat /home/*/.slv/ap*',
      'cat /Users/*/.s?v/keys/*',
    ]
  ) assert(classifyCommand(line).gated, `not gated: ${line}`)
  // the home of this process, wherever it is
  await withOwnHome('/srv/people/zed', () => {
    for (
      const line of [
        'cat /srv/people/zed/.s?v/api.yml',
        'cat /srv/people/zed/.slv/ap*',
        'cat /srv/people/zed/.?sh/id_*',
        'cat /srv/people/zed/.s?v/keys/*',
      ]
    ) assert(classifyCommand(line).gated, `not gated: ${line}`)
    // another directory is no home
    assertFalse(classifyCommand('cat /srv/people/other/notes*').gated)
  })
  // the same lines under a home, after a cd
  for (
    const line of [
      'cd /home/alice && cat .s?v/api.yml',
      'cd /Users/alice && cat .slv/ap*',
      'cd ~ && cat .?sh/id_rsa',
    ]
  ) assert(classifyCommand(line).gated, `not gated: ${line}`)
  // a glob word that names nothing refused under a home still runs
  for (
    const line of [
      'cat /home/alice/notes*',
      'ls /home/alice/*.txt',
      'cat /Users/alice/Documents/*.md',
      'wc -l /home/fumi/work/*.log',
      'ls /home/alice/.cache/*',
      'tail -n 5 /home/bob/logs/app-?.log',
    ]
  ) runsAlone(line)
})
