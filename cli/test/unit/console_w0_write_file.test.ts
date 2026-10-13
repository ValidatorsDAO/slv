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

type SafetyModule = {
  decideWriteFile: (
    input: { memoryFile: boolean; hasTerminal: boolean },
  ) => 'run' | 'confirm' | 'refuse'
  isAgentMemoryFile: (path: string) => Promise<boolean>
  describeWrite: (
    path: string,
    content: string,
    existingBytes: number | null,
  ) => string[]
}

// The write rules live in toolSafety.ts; it is loaded when a test runs.
const loadSafety = async (): Promise<SafetyModule> => {
  const specifier = '@/ai/console/toolSafety.ts'
  try {
    return await import(specifier) as SafetyModule
  } catch {
    throw new Error(`${specifier} cannot be loaded`)
  }
}

const write = (path: string, content: string): Promise<string> =>
  tools.executeTool('write_file', { path, content })

const exists = async (path: string): Promise<boolean> => {
  try {
    await Deno.lstat(path)
    return true
  } catch {
    return false
  }
}

/** What the console printed while `fn` ran. */
const capture = async <T>(
  fn: () => Promise<T>,
): Promise<{ value: T; lines: string[] }> => {
  const log = console.log
  const lines: string[] = []
  console.log = (...args: unknown[]) => {
    lines.push(args.join(' '))
  }
  try {
    return { value: await fn(), lines }
  } finally {
    console.log = log
  }
}

/** A home that holds an ERPC login, and the console state put back after. */
const sandbox = async (fn: (home: string) => Promise<void>): Promise<void> => {
  await withHome({ slv: { api_key: 'unused' } }, async (home) => {
    try {
      await fn(home)
    } finally {
      setAutoExecute(false)
      setTuiInstance(null)
    }
  })
}

type Asked = { message: string; default?: boolean }

/** A terminal whose question is answered by `answer`; `asked` lists the questions. */
const withTerminal = async (
  answer: () => boolean,
  fn: (asked: Asked[]) => Promise<void>,
): Promise<void> => {
  const fakeTui = {
    stop() {},
    start() {},
    requestRender() {},
  } as unknown as TUI
  const confirm = Confirm as unknown as {
    prompt: (options: Asked) => Promise<boolean>
  }
  const original = confirm.prompt
  const asked: Asked[] = []
  confirm.prompt = (options) => {
    asked.push(options)
    return Promise.resolve(answer())
  }
  setTuiInstance(fakeTui)
  try {
    await fn(asked)
  } finally {
    confirm.prompt = original
    setTuiInstance(null)
  }
}

/** Files that pass the path rules and are not the memory file, with old content. */
const ordinaryFiles = async (home: string): Promise<string[]> => {
  const paths = [
    `${home}/.slv/inventory.testnet.validators.yml`,
    `${home}/.slv/skills/validator/SKILL.md`,
    `${home}/.slv/agent/SOUL.md`,
  ]
  for (const path of paths) {
    await Deno.mkdir(path.slice(0, path.lastIndexOf('/')), { recursive: true })
    await Deno.writeTextFile(path, 'old\n')
  }
  return paths
}

Deno.test('only the memory file is written without a person: the decision table', async () => {
  const { decideWriteFile } = await loadSafety()
  const rows: Array<[boolean, boolean, string]> = [
    [true, true, 'run'],
    [true, false, 'run'],
    [false, true, 'confirm'],
    [false, false, 'refuse'],
  ]
  for (const [memoryFile, hasTerminal, expected] of rows) {
    assertEquals(
      decideWriteFile({ memoryFile, hasTerminal }),
      expected,
      `memoryFile=${memoryFile} hasTerminal=${hasTerminal}`,
    )
  }
})

Deno.test('write_file writes ~/.slv/agent/MEMORY.md without a person, with a terminal and without one', async () => {
  const { isAgentMemoryFile } = await loadSafety()
  await sandbox(async (home) => {
    const memory = `${home}/.slv/agent/MEMORY.md`
    assert(await isAgentMemoryFile(memory))
    assert(await isAgentMemoryFile(`${home}/.slv/agent/../agent/MEMORY.md`))
    for (
      const other of [
        `${home}/.slv/agent/SOUL.md`,
        `${home}/.slv/agent/USER.md`,
        `${home}/.slv/agent/memory.md`,
        `${home}/.slv/agent/sub/MEMORY.md`,
        `${home}/.slv/MEMORY.md`,
        `${home}/.slv/skills/validator/MEMORY.md`,
      ]
    ) {
      assertFalse(await isAgentMemoryFile(other), other)
    }

    // without a terminal
    setTuiInstance(null)
    const first = await capture(() => write(memory, 'first\n'))
    assertStringIncludes(first.value, 'Successfully')
    assertEquals(await Deno.readTextFile(memory), 'first\n')

    // with a terminal that would say no: nothing is asked
    await withTerminal(() => false, async (asked) => {
      for (const autoExecute of [false, true]) {
        setAutoExecute(autoExecute)
        const result = await capture(() => write(memory, 'second\n'))
        assertStringIncludes(result.value, 'Successfully')
        assertEquals(await Deno.readTextFile(memory), 'second\n')
      }
      assertEquals(asked.length, 0)
    })
  })
})

Deno.test('a MEMORY.md that is a link to another file is not the memory file', async () => {
  const { isAgentMemoryFile } = await loadSafety()
  await sandbox(async (home) => {
    const [inventory] = await ordinaryFiles(home)
    const memory = `${home}/.slv/agent/MEMORY.md`
    await Deno.symlink(inventory, memory)
    assertFalse(await isAgentMemoryFile(memory))

    // a terminal is asked, and a "no" leaves the inventory as it was
    await withTerminal(() => false, async (asked) => {
      const declined = await capture(() => write(memory, 'new\n'))
      assertEquals(asked.length, 1)
      assertStringIncludes(declined.value, 'declined')
      assertEquals(await Deno.readTextFile(inventory), 'old\n')
    })
    // without a terminal the write is refused
    const refused = await capture(() => write(memory, 'new\n'))
    assert(refused.value.startsWith('Error'), refused.value)
    assertEquals(await Deno.readTextFile(inventory), 'old\n')
  })
})

Deno.test('with a terminal, write_file asks before it writes an inventory, a skills file or SOUL.md, and a No leaves the file unchanged', async () => {
  for (const autoExecute of [false, true]) {
    await sandbox(async (home) => {
      const paths = await ordinaryFiles(home)
      let answer = false
      await withTerminal(() => answer, async (asked) => {
        setAutoExecute(autoExecute)
        for (const [i, path] of paths.entries()) {
          answer = false
          const declined = await capture(() => write(path, 'new\n'))
          assertEquals(asked.length, i * 2 + 1, path)
          assertEquals(
            asked[i * 2].default,
            false,
            'the question defaults to no',
          )
          assertStringIncludes(declined.value, 'declined')
          assertEquals(await Deno.readTextFile(path), 'old\n', path)
          assert(
            declined.lines.some((line) => line.includes(path)),
            `${path} was not shown`,
          )

          answer = true
          const done = await capture(() => write(path, 'new\n'))
          assertEquals(asked.length, i * 2 + 2, path)
          assertStringIncludes(done.value, 'Successfully')
          assertEquals(await Deno.readTextFile(path), 'new\n', path)
        }
      })
    })
  }
})

Deno.test('the person sees the path, the size and the first 20 lines before they answer', async () => {
  await sandbox(async (home) => {
    const [inventory] = await ordinaryFiles(home)
    const content = Array.from({ length: 25 }, (_, i) => `line ${i + 1}`)
      .join('\n') + '\n'
    await withTerminal(() => false, async () => {
      const { lines } = await capture(() => write(inventory, content))
      const shown = lines.join('\n')
      assertStringIncludes(shown, inventory)
      assertStringIncludes(
        shown,
        `${new TextEncoder().encode(content).length} bytes`,
      )
      assertStringIncludes(shown, '25 lines')
      assertStringIncludes(shown, 'replaces a file of 4 bytes')
      assertStringIncludes(shown, 'line 20')
      assertFalse(shown.includes('line 21'), 'a 21st line was shown')
      assertStringIncludes(shown, '5 more lines are not shown')
    })
  })
})

Deno.test('the preview writes out control characters and cuts a long line', async () => {
  const { describeWrite } = await loadSafety()
  const lines = describeWrite(
    '/h/.slv/x\u001b[2J.yml',
    'a\u001b[31mred\u001b[0m\nb\rc\n' + 'x'.repeat(250) + '\n‮evil\n',
    null,
  )
  const shown = lines.join('\n')
  assertFalse(shown.includes('\u001b'), 'an escape character was passed on')
  assertFalse(shown.includes('\r'), 'a carriage return was passed on')
  assertFalse(shown.includes('‮'), 'a direction override was passed on')
  assertStringIncludes(shown, '\\u001b[31mred')
  assertStringIncludes(shown, 'x.yml'.replace('x', 'x\\u001b[2J'))
  assertStringIncludes(shown, '50 more characters')
  assertStringIncludes(shown, 'a new file')
  assertEquals(
    describeWrite('/h/.slv/e', '', null)[1].includes('0 lines'),
    true,
  )
})

Deno.test('write_file writes the path it shows: a path with .. is written as its normal form', async () => {
  await sandbox(async (home) => {
    await withTerminal(() => true, async () => {
      const { value, lines } = await capture(() =>
        write(`${home}/.slv/agent/../notes/./plan.yml`, 'plan\n')
      )
      assertStringIncludes(value, `${home}/.slv/notes/plan.yml`)
      assertEquals(
        await Deno.readTextFile(`${home}/.slv/notes/plan.yml`),
        'plan\n',
      )
      assert(lines.some((line) => line.includes(`${home}/.slv/notes/plan.yml`)))
      assertFalse(lines.join('\n').includes('..'), 'the path was shown with ..')
    })
  })
})

Deno.test('api.yml is refused with a terminal that would say yes, and without a terminal', async () => {
  await sandbox(async (home) => {
    const apiYml = `${home}/.slv/api.yml`
    const before = await Deno.readTextFile(apiYml)
    const [inventory] = await ordinaryFiles(home)
    const spellings = [
      apiYml,
      `${home}/.slv/agent/../api.yml`,
      `${home}/.slv/api.yml.lock`,
      `${home}/.slv/.api.yml.0001.tmp`,
    ]

    await withTerminal(() => true, async (asked) => {
      // the terminal is live: an inventory write asks and, answered yes, goes through
      const done = await capture(() => write(inventory, 'new\n'))
      assertStringIncludes(done.value, 'Successfully')
      assertEquals(asked.length, 1)
      // api.yml is refused without a question
      for (const path of spellings) {
        const result = await capture(() => write(path, 'slv: {}\n'))
        assert(result.value.startsWith('Error'), `${path}: ${result.value}`)
      }
      assertEquals(asked.length, 1, 'api.yml was put to the person')
    })
    assertEquals(await Deno.readTextFile(apiYml), before)
    assertFalse(await exists(`${home}/.slv/api.yml.lock`))
    assertFalse(await exists(`${home}/.slv/.api.yml.0001.tmp`))

    setTuiInstance(null)
    for (const path of spellings) {
      const result = await capture(() => write(path, 'slv: {}\n'))
      assert(result.value.startsWith('Error'), `${path}: ${result.value}`)
    }
    assertEquals(await Deno.readTextFile(apiYml), before)
  })
})

Deno.test('without a terminal, write_file refuses every file but the memory file and tells the model to hand the content to the user', async () => {
  for (const autoExecute of [false, true]) {
    await sandbox(async (home) => {
      const paths = await ordinaryFiles(home)
      setTuiInstance(null)
      setAutoExecute(autoExecute)
      for (const path of paths) {
        const result = await capture(() => write(path, 'new\n'))
        assert(result.value.startsWith('Error'), `${path}: ${result.value}`)
        assertStringIncludes(result.value, 'terminal')
        assertStringIncludes(result.value, 'content and the path')
        assertStringIncludes(result.value, path)
        assertEquals(await Deno.readTextFile(path), 'old\n', path)
      }
      const fresh = `${home}/.slv/inventory.mainnet.validators.yml`
      const created = await capture(() => write(fresh, 'new\n'))
      assert(created.value.startsWith('Error'), created.value)
      assertFalse(await exists(fresh), 'a new file was created')
    })
  }
})
