import {
  assert,
  assertEquals,
  assertFalse,
  assertStringIncludes,
} from '@std/assert'
import { Confirm } from '@cliffy/prompt'
import type { TUI } from '@mariozechner/pi-tui'

import * as tools from '@/ai/console/tools.ts'
import { setAutoExecute, setTuiInstance } from '@/ai/console/tools.ts'
import { withHome } from '/test/unit/_credentialFixtures.ts'

type CommandEnvOptions = { humanConfirmed?: boolean }
type SafetyModule = {
  buildCommandEnv: (
    parent: Record<string, string>,
    lang: string,
    options?: CommandEnvOptions,
  ) => Record<string, string>
  buildShellInvocation: (
    command: string,
    setsidPath: string | null,
  ) => { command: string; args: string[] }
}

// The environment and shell helpers live in toolSafety.ts; it is loaded when
// a test runs.
const loadSafety = async (): Promise<SafetyModule> => {
  const specifier = '@/ai/console/toolSafety.ts'
  try {
    return await import(specifier) as SafetyModule
  } catch {
    throw new Error(`${specifier} cannot be loaded`)
  }
}

const run = (command: string): Promise<string> =>
  tools.executeTool('run_command', { command })

const exists = async (path: string): Promise<boolean> => {
  try {
    await Deno.stat(path)
    return true
  } catch {
    return false
  }
}

/** A directory for the commands to act on, a home for the console, and the
 *  console state put back afterwards. */
const sandbox = async (
  fn: (dir: string) => Promise<void>,
): Promise<void> => {
  const dir = await Deno.makeTempDir({ prefix: 'console-w0-run-' })
  try {
    await withHome(null, async () => {
      try {
        await fn(dir)
      } finally {
        setAutoExecute(false)
        setTuiInstance(null)
      }
    })
  } finally {
    await Deno.remove(dir, { recursive: true })
  }
}

const quiet = async <T>(fn: () => Promise<T>): Promise<T> => {
  const log = console.log
  console.log = () => {}
  try {
    return await fn()
  } finally {
    console.log = log
  }
}

Deno.test('run_command does not execute without a terminal when auto-execute is off', async () => {
  await sandbox(async (dir) => {
    setTuiInstance(null)
    await Deno.writeTextFile(`${dir}/note`, 'content-of-the-note\n')

    // a read-only command runs when auto-execute is on
    setAutoExecute(true)
    const control = await quiet(() => run(`cat '${dir}/note'`))
    assertStringIncludes(control, 'content-of-the-note')

    setAutoExecute(false)
    const result = await quiet(() => run(`cat '${dir}/note'`))
    assertFalse(result.includes('content-of-the-note'), 'the command ran')
    assertStringIncludes(result, 'not run')
    assertStringIncludes(result, 'terminal')
  })
})

Deno.test('with auto-execute on, run_command runs only read-only commands without a person', async () => {
  await sandbox(async (dir) => {
    setTuiInstance(null)
    setAutoExecute(true)
    await Deno.writeTextFile(`${dir}/a.txt`, 'beta\nalpha\n')

    // read-only lines run: a pipeline, a list, a redirection to /dev/null
    const listed = await quiet(() => run(`ls '${dir}' && sort '${dir}/a.txt'`))
    assertStringIncludes(listed, 'a.txt')
    assertStringIncludes(listed, 'alpha\nbeta')
    const piped = await quiet(() =>
      run(`cat '${dir}/a.txt' | grep alpha 2>/dev/null`)
    )
    assertEquals(piped.trim(), 'alpha')

    // lines that write, run another program or change something do not
    const lines = [
      `touch '${dir}/m1'`,
      `echo x > '${dir}/m2'`,
      `sort -o '${dir}/m3' '${dir}/a.txt'`,
      `cp '${dir}/a.txt' '${dir}/m4'`,
      `cat '${dir}/a.txt' | tee '${dir}/m5'`,
      `ls > '${dir}/m6'`,
      `ls '${dir}' & touch '${dir}/m7'`,
      `M=1 ls '${dir}'; touch '${dir}/m8'`,
      `sudo -n touch '${dir}/m9'`,
      `bash -c "touch '${dir}/m10'"`,
    ]
    for (const line of lines) {
      const result = await quiet(() => run(line))
      assertStringIncludes(result, 'not run', line)
      assertStringIncludes(result, 'read-only', line)
    }
    for (let n = 1; n <= 10; n++) {
      assertFalse(await exists(`${dir}/m${n}`), `m${n} was created`)
    }
  })
})

Deno.test('run_command refuses a command until something turns auto-execute on', async () => {
  // a copy of the module that nothing has configured: its own default applies
  const specifier = '@/ai/console/tools.ts?w0-default'
  const fresh = await import(specifier) as typeof tools
  const dir = await Deno.makeTempDir({ prefix: 'console-w0-default-' })
  try {
    fresh.setTuiInstance(null)
    await Deno.writeTextFile(`${dir}/note`, 'content-of-the-note\n')
    const command = `cat '${dir}/note'`
    const result = await quiet(() =>
      fresh.executeTool('run_command', { command })
    )
    assertStringIncludes(result, 'not run')
    assertFalse(result.includes('content-of-the-note'), 'the command ran')
    fresh.setAutoExecute(true)
    const control = await quiet(() =>
      fresh.executeTool('run_command', { command })
    )
    assertStringIncludes(control, 'content-of-the-note')
  } finally {
    await Deno.remove(dir, { recursive: true })
  }
})

Deno.test('run_command leaves no timer running when a command ends, whatever the exit', async () => {
  const pending = new Set<number>()
  const realSet = globalThis.setTimeout
  const realClear = globalThis.clearTimeout
  globalThis.setTimeout = ((
    handler: (...args: unknown[]) => void,
    delay?: number,
    ...args: unknown[]
  ) => {
    const id = realSet(() => {
      pending.delete(id)
      handler(...args)
    }, delay) as unknown as number
    pending.add(id)
    return id
  }) as unknown as typeof setTimeout
  globalThis.clearTimeout = ((id?: number) => {
    if (id !== undefined) pending.delete(id)
    realClear(id)
  }) as typeof clearTimeout
  try {
    await sandbox(async () => {
      setTuiInstance(null)
      setAutoExecute(true)
      // a command that ends well, one that fails, and one that outlives the
      // first check of the inactivity watcher
      for (const command of ['true', 'false', 'sleep 1.3']) {
        const result = await quiet(() => run(command))
        assertFalse(result.includes('not run'), `${command}: ${result}`)
        assertEquals(
          pending.size,
          0,
          `${command}: ${pending.size} timers still running`,
        )
      }
    })
  } finally {
    globalThis.setTimeout = realSet
    globalThis.clearTimeout = realClear
    for (const id of pending) realClear(id)
  }
})

Deno.test('a gated command is not executed without a terminal even when auto-execute is on', async () => {
  await sandbox(async (dir) => {
    setTuiInstance(null)
    setAutoExecute(true)
    await Deno.mkdir(`${dir}/victim`)

    const commands = [
      `rm -rf '${dir}/victim'`,
      `touch '${dir}/m1' && ssh -V`,
      `sudo rm -rf '${dir}/victim'`,
      `bash -c "rm -rf '${dir}/victim'"`,
      `echo go; rm -f '${dir}/victim'; touch '${dir}/m2'`,
      `touch '${dir}/m3' && slv v set:identity -p a`,
    ]
    for (const command of commands) {
      const result = await quiet(() => run(command))
      assertStringIncludes(result, 'not run', command)
    }
    assert(
      await exists(`${dir}/victim`),
      'a gated command removed the directory',
    )
    for (const marker of ['m1', 'm2', 'm3']) {
      assertFalse(await exists(`${dir}/${marker}`), `${marker} was created`)
    }
  })
})

Deno.test('with a terminal a gated command asks first even when auto-execute is on', async () => {
  const fakeTui = {
    stop() {},
    start() {},
    requestRender() {},
  } as unknown as TUI
  const confirm = Confirm as unknown as {
    prompt: (
      options: { message: string; default?: boolean },
    ) => Promise<boolean>
  }
  const original = confirm.prompt
  const asked: Array<{ message: string; default?: boolean }> = []
  let answer = false
  confirm.prompt = (options) => {
    asked.push(options)
    return Promise.resolve(answer)
  }
  try {
    await sandbox(async (dir) => {
      setTuiInstance(fakeTui)
      setAutoExecute(true)
      await Deno.writeTextFile(`${dir}/note`, 'content-of-the-note\n')

      // a read-only command runs without a question
      const plain = await quiet(() => run(`cat '${dir}/note'`))
      assertStringIncludes(plain, 'content-of-the-note')
      assertEquals(asked.length, 0)

      // a command that is not read-only asks, and a "no" runs nothing
      answer = false
      const notAsked = await quiet(() => run(`touch '${dir}/plain'`))
      assertEquals(asked.length, 1)
      assertEquals(asked[0].default, true, 'a plain command defaults to yes')
      assertStringIncludes(notAsked, 'declined')
      assertFalse(await exists(`${dir}/plain`), 'the declined command ran')
      answer = true
      await quiet(() => run(`touch '${dir}/plain'`))
      assertEquals(asked.length, 2)
      assert(await exists(`${dir}/plain`), 'the confirmed command did not run')

      // a gated command asks, and a "no" runs nothing
      await Deno.mkdir(`${dir}/victim`)
      answer = false
      const declined = await quiet(() => run(`rm -rf '${dir}/victim'`))
      assertEquals(asked.length, 3)
      assertEquals(asked[2].default, false, 'a gated command defaults to no')
      assertStringIncludes(declined, 'declined')
      assert(await exists(`${dir}/victim`), 'the declined command ran')

      // a "yes" runs it
      answer = true
      await quiet(() => run(`rm -rf '${dir}/victim'`))
      assertEquals(asked.length, 4)
      assertFalse(
        await exists(`${dir}/victim`),
        'the confirmed command did not run',
      )

      // with auto-execute off every command asks, a read-only one too
      setAutoExecute(false)
      answer = false
      const off = await quiet(() => run(`cat '${dir}/note'`))
      assertEquals(asked.length, 5)
      assertStringIncludes(off, 'declined')
    })
  } finally {
    confirm.prompt = original
  }
})

Deno.test('the environment passed to the shell comes from an allow-list', async () => {
  const { buildCommandEnv } = await loadSafety()
  const parent: Record<string, string> = {
    PATH: '/usr/local/bin:/usr/bin:/bin',
    HOME: '/home/u',
    USER: 'u',
    LOGNAME: 'u',
    SHELL: '/bin/bash',
    LANG: 'en_US.UTF-8',
    LC_ALL: 'C',
    TERM: 'xterm-256color',
    TZ: 'UTC',
    OP_SERVICE_ACCOUNT_TOKEN: 'ops_secret',
    OP_CONNECT_HOST: 'https://connect.example',
    OP_BIOMETRIC_UNLOCK_ENABLED: 'true',
    SSH_AUTH_SOCK: '/tmp/ssh-agent.sock',
    GH_TOKEN: 'gh_secret',
    GITHUB_TOKEN: 'gh_secret',
    GITHUB_ACTIONS: 'true',
    FOO_API_KEY: 'foo_secret',
    ANTHROPIC_API_KEY: 'sk-ant-secret',
    MY_SECRET: 'secret',
    DB_PASSWORD: 'password',
    AWS_ACCESS_KEY_ID: 'aws',
    AWS_PROFILE: 'prod',
    LC_MY_TOKEN: 'sneaky',
    DENO_DIR: '/x',
    RANDOM_VARIABLE: 'value',
  }
  const env = buildCommandEnv(parent, 'ja')
  for (
    const name of [
      'PATH',
      'HOME',
      'USER',
      'LOGNAME',
      'SHELL',
      'LANG',
      'LC_ALL',
      'TERM',
      'TZ',
    ]
  ) {
    assertEquals(env[name], parent[name], name)
  }
  for (
    const name of [
      'OP_SERVICE_ACCOUNT_TOKEN',
      'OP_CONNECT_HOST',
      'SSH_AUTH_SOCK',
      'GH_TOKEN',
      'GITHUB_TOKEN',
      'GITHUB_ACTIONS',
      'FOO_API_KEY',
      'ANTHROPIC_API_KEY',
      'MY_SECRET',
      'DB_PASSWORD',
      'AWS_ACCESS_KEY_ID',
      'AWS_PROFILE',
      'LC_MY_TOKEN',
      'DENO_DIR',
      'RANDOM_VARIABLE',
    ]
  ) {
    assertFalse(name in env, `${name} reached the child`)
  }
  assertEquals(env.OP_BIOMETRIC_UNLOCK_ENABLED, 'false')
  assertEquals(env.TRADE_APP_LANG, 'ja')
  assertEquals(env.PYTHONUNBUFFERED, '1')
})

Deno.test('ssh and ansible keep host key checking on', async () => {
  const { buildCommandEnv } = await loadSafety()
  const env = buildCommandEnv({ PATH: '/usr/bin' }, 'en')
  assertFalse('ANSIBLE_HOST_KEY_CHECKING' in env)
  const args = env.ANSIBLE_SSH_ARGS ?? ''
  assertStringIncludes(args, 'StrictHostKeyChecking=accept-new')
  assertStringIncludes(args, 'PasswordAuthentication=no')
  assertFalse(args.includes('UserKnownHostsFile'), args)
  assertFalse(args.includes('/dev/null'), args)
  assertFalse(args.includes('StrictHostKeyChecking=no'), args)
})

Deno.test('the shell is started in a new session when setsid exists', async () => {
  const { buildShellInvocation } = await loadSafety()
  assertEquals(buildShellInvocation('echo hi', '/usr/bin/setsid'), {
    command: '/usr/bin/setsid',
    args: ['bash', '-c', 'echo hi'],
  })
  assertEquals(buildShellInvocation('echo hi', null), {
    command: 'bash',
    args: ['-c', 'echo hi'],
  })
})

Deno.test('the command a console runs sees only the allow-listed environment', async () => {
  const secrets: Record<string, string> = {
    OP_SERVICE_ACCOUNT_TOKEN: 'ops_secret_value_1',
    SSH_AUTH_SOCK: '/tmp/agent_secret_value_2.sock',
    GH_TOKEN: 'gh_secret_value_3',
    FOO_API_KEY: 'foo_secret_value_4',
    AWS_SECRET_ACCESS_KEY: 'aws_secret_value_5',
  }
  await sandbox(async () => {
    setTuiInstance(null)
    setAutoExecute(true)
    for (const [name, value] of Object.entries(secrets)) {
      Deno.env.set(name, value)
    }
    try {
      const output = await quiet(() => run('env'))
      const names = output.split('\n').map((line) => line.split('=')[0])
      for (const [name, value] of Object.entries(secrets)) {
        assertFalse(names.includes(name), `${name} reached the command`)
        assertFalse(output.includes(value), `${name} value reached the command`)
      }
      assertStringIncludes(output, 'OP_BIOMETRIC_UNLOCK_ENABLED=false')
      assert(names.includes('PATH'), 'PATH missing')
      assert(names.includes('HOME'), 'HOME missing')
      assertStringIncludes(output, 'ANSIBLE_SSH_ARGS=')
      assertFalse(output.includes('ANSIBLE_HOST_KEY_CHECKING'))
      assertFalse(output.includes('UserKnownHostsFile=/dev/null'))
    } finally {
      for (const name of Object.keys(secrets)) Deno.env.delete(name)
    }
  })
})

Deno.test('the command runs in a session of its own when setsid exists', async () => {
  const hasSetsid = (Deno.env.get('PATH') ?? '').split(':').some((dir) => {
    try {
      return Deno.statSync(`${dir}/setsid`).isFile
    } catch {
      return false
    }
  })
  let stat = ''
  try {
    stat = await Deno.readTextFile('/proc/self/stat')
  } catch { /* not Linux */ }
  if (!hasSetsid || stat === '') return
  await sandbox(async () => {
    setTuiInstance(null)
    setAutoExecute(true)
    // the shell prints its own pid, then ps lists every process with its session
    const output = await quiet(() => run('echo $$; ps -eo pid=,sid='))
    const [pid, ...listed] = output.trim().split('\n').map((line) =>
      line.trim()
    )
    assert(pid !== undefined && /^[0-9]+$/.test(pid), output)
    const row = listed.map((line) => line.split(/\s+/)).find(([id]) =>
      id === pid
    )
    assert(row !== undefined, output)
    assertEquals(row[1], pid, 'the shell is not a session leader')
  })
})

const AGENT_SOCKET = '/tmp/console-w0-agent.sock'

Deno.test('the environment of a command a person confirmed carries SSH_AUTH_SOCK, no other does', async () => {
  const { buildCommandEnv } = await loadSafety()
  const parent = {
    PATH: '/usr/bin',
    HOME: '/home/u',
    SSH_AUTH_SOCK: AGENT_SOCKET,
    OP_SERVICE_ACCOUNT_TOKEN: 'ops_secret',
    GH_TOKEN: 'gh_secret',
    FOO_API_KEY: 'foo_secret',
  }
  assertFalse('SSH_AUTH_SOCK' in buildCommandEnv(parent, 'en'))
  assertFalse('SSH_AUTH_SOCK' in buildCommandEnv(parent, 'en', {}))
  assertFalse(
    'SSH_AUTH_SOCK' in buildCommandEnv(parent, 'en', { humanConfirmed: false }),
  )
  const confirmed = buildCommandEnv(parent, 'en', { humanConfirmed: true })
  assertEquals(confirmed.SSH_AUTH_SOCK, AGENT_SOCKET)
  assertEquals(confirmed.PATH, '/usr/bin')
  // every other rule stays
  for (const name of ['OP_SERVICE_ACCOUNT_TOKEN', 'GH_TOKEN', 'FOO_API_KEY']) {
    assertFalse(name in confirmed, name)
  }
  assertEquals(confirmed.OP_BIOMETRIC_UNLOCK_ENABLED, 'false')
  // nothing to pass on when the parent has no agent
  assertFalse(
    'SSH_AUTH_SOCK' in
      buildCommandEnv({ PATH: '/usr/bin' }, 'en', { humanConfirmed: true }),
  )
})

Deno.test('a command a person confirmed in the terminal gets SSH_AUTH_SOCK and an auto-executed one does not', async () => {
  const fakeTui = {
    stop() {},
    start() {},
    requestRender() {},
  } as unknown as TUI
  const confirm = Confirm as unknown as {
    prompt: (options: { message: string }) => Promise<boolean>
  }
  const original = confirm.prompt
  let asked = 0
  let answer = true
  confirm.prompt = () => {
    asked++
    return Promise.resolve(answer)
  }
  Deno.env.set('SSH_AUTH_SOCK', AGENT_SOCKET)
  try {
    await sandbox(async (dir) => {
      // auto-execute off: every command is put to the person
      setTuiInstance(fakeTui)
      setAutoExecute(false)
      answer = true
      const confirmed = await quiet(() => run('env'))
      assertEquals(asked, 1)
      assertStringIncludes(confirmed, `SSH_AUTH_SOCK=${AGENT_SOCKET}`)

      answer = false
      const declined = await quiet(() => run('env'))
      assertEquals(asked, 2)
      assertStringIncludes(declined, 'declined')
      assertFalse(declined.includes('SSH_AUTH_SOCK'))

      // a command of a gated class is put to the person even with
      // auto-execute on, and the person's yes gives it the agent
      setAutoExecute(true)
      answer = true
      const gated = await quiet(() => run(`rm -rf '${dir}/none'; env`))
      assertEquals(asked, 3)
      assertStringIncludes(gated, `SSH_AUTH_SOCK=${AGENT_SOCKET}`)

      // auto-executed, with a terminal attached: nobody was asked
      const auto = await quiet(() => run('env'))
      assertEquals(asked, 3)
      assertStringIncludes(auto, 'PATH=')
      assertFalse(auto.includes('SSH_AUTH_SOCK'))

      // auto-executed, with no terminal at all
      setTuiInstance(null)
      const headless = await quiet(() => run('env'))
      assertEquals(asked, 3)
      assertStringIncludes(headless, 'PATH=')
      assertFalse(headless.includes('SSH_AUTH_SOCK'))
    })
  } finally {
    Deno.env.delete('SSH_AUTH_SOCK')
    confirm.prompt = original
  }
})
