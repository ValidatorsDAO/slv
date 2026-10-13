import { assert, assertEquals, assertStringIncludes } from '@std/assert'

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

Deno.test('ps that prints the environment of processes needs a person: the BSD e and a format named environ; the plain forms run', () => {
  for (
    const line of [
      'ps e',
      'ps auxe',
      'ps axe',
      'ps eww -p 1',
      'ps -p 1 e',
      'ps aux e',
      'ps ew',
      'ps auxwwe',
      'ps p 1 e',
      'ps -o environ',
      'ps -o pid,environ',
      'ps o environ',
      'ps opid,environ',
      'ps --format environ',
      'ps --format=pid,environ',
      'ps --format pid,environ',
      'ps -O environ',
      'ps -Oenviron',
      'ps O environ',
      'ps -eo pid,environ',
      'ps -p 1 -o ENVIRON',
      'ps -p 1 -o pid,Environ,cmd',
      'ps -E',
      'ps E',
    ]
  ) needsAPerson(line)
  for (
    const line of [
      'ps aux',
      'ps -ef',
      'ps -eo pid,cmd',
      'ps',
      'ps ax',
      'ps axf',
      'ps -e',
      'ps -A',
      'ps -aux',
      'ps -eF',
      'ps -ely',
      'ps -eLf',
      'ps -eH',
      'ps -efww',
      'ps -ef --forest',
      'ps -eo pid,ppid,etime,cmd',
      'ps -eo pid,etime,cmd --sort=-etime',
      'ps -e -o pid,cmd -o etime',
      'ps -p 1 -o etime=',
      'ps -p 1,2 -o pid,comm',
      'ps -fp 1',
      'ps -C nginx',
      'ps -C redis-server -o pid,etime',
      'ps -u solv -o pid,cmd',
      'ps -u postgres',
      'ps axo pid,etime,cmd',
      'ps aux --sort=-%mem',
      'ps -e f',
      'ps -e -u root',
      'ps -u root -e',
      'ps -el',
      'ps -elf',
      'ps -eT',
      'ps -ae',
      'ps -ef -p 1,2',
      // ps stops with an error and prints nothing
      'ps -eL -T',
      'ps -eLT',
      'ps -eL --forest',
      'ps -e -p',
      'ps -eF -o pid',
      'ps aux | grep agave',
      'ps -ef | grep -v grep',
    ]
  ) runsAlone(line)
  assertStringIncludes(reasonsOf('ps auxe'), 'prints the environment')
  assertStringIncludes(reasonsOf('ps -o pid,environ'), 'environ')
})

Deno.test('ps words that ps reads again as BSD options print the environment as well', () => {
  for (
    const line of [
      // a dash word that is not UNIX options is read as BSD options
      'ps -xe',
      'ps -axe',
      'ps -auxe',
      'ps -uxe',
      'ps -aue',
      'ps -xew',
      'ps -eh',
      'ps -es',
      'ps -ev',
      'ps -ex',
      // two format options that conflict, so ps reads the line again
      'ps -ef -o pid,cmd',
      'ps -ef -O pid',
      'ps -eo pid,cmd -f',
      // a UNIX option that ps cannot take, or that lacks a value
      'ps -e -g',
      'ps -le -n',
      'ps -e -u',
      'ps -e -x',
      // options that conflict
      'ps -eH -m',
      'ps -eT --forest',
      'ps -p 1 -eTH',
      'ps -p 1 -lTHe',
      // --context is a format of its own, which -f and -o do not go with
      'ps -p 1 --context -ef',
      'ps -p 1 -fe --context',
      // a user-defined format that a format option conflicts with
      'ps -p 1 -ef --format=pid,cmd',
      'ps -p 1 -ef --format pid,cmd',
      // BSD options with a value in the word or in the next word
      'ps -p 1 -xe',
      'ps -p 1 -U root -xe',
      'ps -p 1 -xeopid,cmd',
      'ps -p 1 -xekpid',
      'ps -p 1 -eOt',
      // a long option with a value in the next word
      'ps -p 1 --sort pid -ex',
      // a process id or a session id after the options, or glued to them
      'ps -p 1 -xe 1',
      'ps -p 1 -xe +1',
      'ps -p 1 -xe -1',
      'ps -p 1 -e1',
      // a tty option without a value
      'ps -p 1 -et',
      'ps -p 1 -eat',
    ]
  ) {
    assert(classifyCommand(line).gated, `not held: ${line}`)
    needsAPerson(line)
  }
  // the same words without the e print nothing of the kind
  for (
    const line of [
      'ps -x',
      'ps -ax',
      'ps -ef -p 1',
      'ps -p 1 -o pid,cmd -f',
      'ps -u solv',
      'ps -g 1',
      'ps -C nginx -f',
      'ps -fL',
      'ps -H -m',
    ]
  ) runsAlone(line)
})

Deno.test('a ps with an argument that the shell expands needs a person', () => {
  for (
    const line of [
      'ps -p $$',
      'ps -o pid=,sid= -p $$',
      'ps $X',
      'ps -o $F',
      'ps -p $!',
      'ps -p "$PID"',
      'ps -p ${X:-1 -xe}',
      'ps -eo pid,cmd $X',
      'ps -u $USER',
      'ps -p 1*',
      'ps -o pid,{a,b}',
      'xargs ps',
      'echo -xe | xargs ps',
    ]
  ) {
    assert(classifyCommand(line).gated, `not held: ${line}`)
    needsAPerson(line)
  }
  assertStringIncludes(reasonsOf('ps -p $$'), 'known only when the shell runs')
  // the shell can print its own pid and ps can list the sessions
  runsAlone('echo $$; ps -eo pid=,sid=')
})

Deno.test('ps is read behind wrappers, a path, a shell and an assignment', () => {
  for (
    const line of [
      'sudo ps e',
      'nice ps auxe',
      'env ps -xe',
      'timeout 5 ps -ef -o pid,cmd',
      '/bin/ps e',
      '/usr/bin/ps -o environ',
      'FOO=1 ps e',
      'time ps e',
      'bash -c "ps e"',
      "sh -c 'ps -auxe'",
      'echo x | ps e',
      'cd /srv && ps e',
      '{ ps e; }',
      '(ps -xe)',
    ]
  ) assert(classifyCommand(line).gated, `not held: ${line}`)
})

/** A directory with a regular file in it, and the directory taken away. */
const withInputFile = async (
  fn: (dir: string, file: string) => void | Promise<void>,
): Promise<void> => {
  const dir = await Deno.makeTempDir({ prefix: 'console-w0-rg-' })
  try {
    const file = `${dir}/notes.txt`
    await Deno.writeTextFile(file, 'agave\n')
    await fn(dir, file)
  } finally {
    await Deno.remove(dir, { recursive: true })
  }
}

Deno.test('rg with no path searches its standard input when that is a pipe or a file, and the working directory otherwise', async () => {
  await withInputFile((dir, file) => {
    for (
      const line of [
        'ps aux | rg agave',
        'ps aux |& rg agave',
        'ps aux |\n rg agave',
        'ps aux | rg agave | head',
        'ps aux | rg -i -e agave -e solana',
        'ps aux | rg --hidden agave',
        'journalctl -u solv | rg -i error',
        'cat /etc/hostname | rg -c x',
        'ps | { rg x; }',
        'true | rg x',
        `rg agave < ${file}`,
        `rg agave 0< ${file}`,
        `rg agave 2>/dev/null < ${file}`,
        `ps aux | rg agave 3< ${file}`,
        `rg -c agave < ${file} | head`,
        'ps aux 2>/dev/null | rg agave',
      ]
    ) runsAlone(line)
    for (
      const line of [
        // nothing on the standard input
        'rg token',
        'rg -n token',
        'rg -e token',
        'rg token | head',
        'ps || rg token',
        'ps; rg token',
        'ps && rg token',
        'rg token & ps',
        // a standard input that is not a pipe or a file
        'rg token < /dev/null',
        'ps aux | rg token < /dev/null',
        `rg token < ${dir}`,
        `ps aux | rg token < ${dir}`,
        'rg token < notes.txt',
        'rg token < "$F"',
        `rg token < ${file} < /dev/null`,
        `rg token 3< ${file}`,
        `rg token 0<&3`,
        'rg token <<< text',
        'ps | rg token <<< text',
        'ps | rg token <<EOF\ntext\nEOF',
        'ps | rg token <&3',
        'ps | rg token 0<&3',
        `rg agave <> ${file}`,
        // a file that is not there, and one at a path that is relative
        'rg token < /no/such/dir/notes.txt',
        `rg token < ${
          '../'.repeat(Deno.cwd().split('/').filter(Boolean).length)
        }${file.slice(1)}`,
        // the file is one the key-material paths judge
        'rg token < ~/.slv/api.yml',
        'rg token < /home/solv/.slv/api.yml',
        'ps | rg token < ~/.slv/api.yml',
        'rg token < ~/.ssh/id_rsa',
        // a path operand is read as a path, a pipe or not
        'ps | rg token ~/.slv',
        'ps | rg token ~',
        'ps | rg token .',
        'ps | rg token logs',
        'ps | rg token /home/solv/.slv',
        // a pipe that a wrapper or a group does not hand on
        'ps | nice rg token',
        'ps | env rg token',
        'ps | (rg token)',
        'cat files | xargs rg token',
        // a pipe goes to the command after it and to no other
        'ps | cat; rg token',
        'ps | >/dev/null; rg token',
        // an argument the shell expands
        'ps | rg "$X"',
        'ps | rg token $X',
        'ps | rg tok*',
      ]
    ) {
      assert(classifyCommand(line).gated, `not held: ${line}`)
      needsAPerson(line)
    }
    // a pipe or a file is no cover for a path
    runsAlone('ps | rg token /srv/code')
    assertStringIncludes(reasonsOf('rg token'), 'working directory')
  })
})

Deno.test('a recursive search with an argument that the shell expands needs a person', () => {
  for (
    const line of [
      'grep -r --include=$X error /srv/code',
      'grep -r "$PATTERN" /srv/code',
      'grep -rn error /srv/code $EXTRA',
      'grep -rn err* /srv/code',
      'grep -r ${X:-a ~/.slv} /srv/code',
      'egrep -r $X /srv/code',
      'rg "$X" /srv/code',
      'rg --glob=$G token /srv/code',
      'rg -e token $X',
      'diff -r "$A" /srv/b',
      'diff -r --exclude=$X /srv/a /srv/b',
    ]
  ) {
    assert(classifyCommand(line).gated, `not held: ${line}`)
    needsAPerson(line)
  }
  // a search that is not recursive is left to the paths it names
  runsAlone('grep -i "$USER" /etc/passwd')
  runsAlone('ps aux | grep "$USER"')
})

Deno.test('rg reads a standard input that a file under the home directory names as a file, and not as a path', async () => {
  const home = await Deno.makeTempDir({ prefix: 'console-w0-rg-home-' })
  const before = Deno.env.get('HOME')
  Deno.env.set('HOME', home)
  try {
    await Deno.writeTextFile(`${home}/notes.txt`, 'agave\n')
    await Deno.mkdir(`${home}/logs`)
    // a file that the name of another user's home would reach by mistake
    await Deno.mkdir(`${home}other`)
    await Deno.writeTextFile(`${home}other/notes.txt`, 'agave\n')
    runsAlone('rg agave < ~/notes.txt')
    runsAlone(`rg agave < ${home}/notes.txt`)
    for (
      const line of [
        'rg agave < ~/logs',
        'rg agave < ~/no-such-file',
        'rg agave < ~other/notes.txt',
        'rg agave < ~/.slv/api.yml',
      ]
    ) {
      assert(classifyCommand(line).gated, `not held: ${line}`)
      needsAPerson(line)
    }
  } finally {
    if (before === undefined) Deno.env.delete('HOME')
    else Deno.env.set('HOME', before)
    await Deno.remove(home, { recursive: true })
    await Deno.remove(`${home}other`, { recursive: true }).catch(() => {})
  }
})
