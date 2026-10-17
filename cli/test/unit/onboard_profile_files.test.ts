import { assertEquals, assertRejects, assertStringIncludes } from '@std/assert'
import { parse } from '@std/yaml'
import { ensureProfileFile } from '@/ai/onboard/profileFiles.ts'
import {
  parseAgentProfile,
  parseUserProfile,
} from '@/ai/agentConfig/markdown.ts'

async function withProfile(fn: (path: string) => Promise<void>): Promise<void> {
  const directory = await Deno.makeTempDir({ prefix: 'slv-profile-test-' })
  try {
    await fn(`${directory}/profile.md`)
  } finally {
    await Deno.remove(directory, { recursive: true })
  }
}

Deno.test('onboarding creates a missing profile from the supplied initial content', async () => {
  await withProfile(async (path) => {
    const initial = '# USER.md\n- **Name:** Example\n'
    await ensureProfileFile(path, initial, { name: 'Unused override' })
    assertEquals(await Deno.readTextFile(path), initial)
  })
})

Deno.test('onboarding with no explicit profile fields performs no write, even for malformed frontmatter', async () => {
  await withProfile(async (path) => {
    const original = '---\nname: [incomplete\n\nPersonal notes\n'
    await Deno.writeTextFile(path, original)
    const write = Deno.writeTextFile
    Deno.writeTextFile = () => {
      throw new Error('No write should occur')
    }
    try {
      await ensureProfileFile(path, 'replacement')
      await ensureProfileFile(path, 'replacement', {})
    } finally {
      Deno.writeTextFile = write
    }
    assertEquals(await Deno.readTextFile(path), original)
  })
})

Deno.test('explicit profile updates preserve other YAML keys and the exact Markdown body', async () => {
  await withProfile(async (path) => {
    const body =
      '\n# My assistant\n\nKeep this **custom note**.\n- **Name:** Original\n'
    const original =
      `---\nname: Original\nrole: Operator\npreferences:\n  concise: true\nlabels:\n  - personal\n---\n${body}`
    await Deno.writeTextFile(path, original)
    await ensureProfileFile(path, 'unused', { name: 'SLV' })
    const result = await Deno.readTextFile(path)
    const [, yaml, suffix] = result.split('---\n')
    assertEquals(parse(yaml), {
      name: 'SLV',
      role: 'Operator',
      preferences: { concise: true },
      labels: ['personal'],
    })
    assertEquals(suffix, body)
    assertEquals(parseAgentProfile(result).name, 'SLV')
    assertEquals(parseAgentProfile(result).role, 'Operator')
  })
})

Deno.test('adding frontmatter to a legacy profile retains Name, Call me, Role and custom notes', async () => {
  await withProfile(async (path) => {
    const original =
      '# Profile\n- **Name:** Example User\n- **Call me:** Friend\n- **Role:** Operator\n\nMy own instructions.\n'
    await Deno.writeTextFile(path, original)
    await ensureProfileFile(path, 'unused', { name: 'Updated User' })
    const result = await Deno.readTextFile(path)
    assertEquals(result.slice(result.indexOf('\n---\n') + 5), original)
    assertEquals(parseUserProfile(result).name, 'Updated User')
    assertEquals(parseUserProfile(result).preferredName, 'Friend')
    assertEquals(parseAgentProfile(result).role, 'Operator')
  })
})

Deno.test('a legacy call_me update is not hidden by a synthesized preferred_name alias', async () => {
  await withProfile(async (path) => {
    const original = '- **Name:** Example\n- **Call me:** Original\n'
    await Deno.writeTextFile(path, original)
    await ensureProfileFile(path, 'unused', { call_me: 'Updated' })
    const result = await Deno.readTextFile(path)
    assertEquals(parseUserProfile(result).name, 'Example')
    assertEquals(parseUserProfile(result).preferredName, 'Updated')
    assertStringIncludes(result, original)
  })
})

Deno.test('updating preferred_name preserves other existing frontmatter aliases and metadata', async () => {
  await withProfile(async (path) => {
    await Deno.writeTextFile(
      path,
      '---\nname: Example\ncall_me: Original\n---\nNotes\n',
    )
    await ensureProfileFile(path, 'unused', { preferred_name: 'Updated' })
    const result = await Deno.readTextFile(path)
    assertEquals(parseUserProfile(result).preferredName, 'Updated')
    assertStringIncludes(result, 'call_me: Original')
    assertStringIncludes(result, 'Notes\n')
  })
})

Deno.test('malformed, unclosed or non-mapping profile frontmatter fails without changing the file', async () => {
  const malformed = [
    '---\nname: [broken\n---\nNotes\n',
    '---\nname: Example\nNotes\n',
    '---\n- Example\n---\nNotes\n',
    '---\nplain text\n---\nNotes\n',
    '---\nnull\n---\nNotes\n',
    '---\n2026-01-01\n---\nNotes\n',
  ]
  for (const original of malformed) {
    await withProfile(async (path) => {
      await Deno.writeTextFile(path, original)
      await assertRejects(
        () => ensureProfileFile(path, 'unused', { name: 'SLV' }),
        Error,
        'frontmatter',
      )
      assertEquals(await Deno.readTextFile(path), original)
    })
  }
})

Deno.test('empty frontmatter and closing delimiters at EOF accept explicit updates', async () => {
  for (const original of ['---\n---\n', '---\n# A comment\n---']) {
    await withProfile(async (path) => {
      await Deno.writeTextFile(path, original)
      await ensureProfileFile(path, 'unused', { name: 'SLV' })
      assertEquals(parseAgentProfile(await Deno.readTextFile(path)).name, 'SLV')
    })
  }
})

Deno.test('CRLF frontmatter is normalized for existing parsers while body line endings survive', async () => {
  await withProfile(async (path) => {
    const body = '\r\n# Personal notes\r\nKeep this.\r\n'
    await Deno.writeTextFile(
      path,
      `---\r\nname: Original\r\nrole: Operator\r\n---\r\n${body}`,
    )
    await ensureProfileFile(path, 'unused', { name: 'SLV' })
    const result = await Deno.readTextFile(path)
    assertEquals(parseAgentProfile(result).name, 'SLV')
    assertEquals(parseAgentProfile(result).role, 'Operator')
    assertEquals(result.slice(result.indexOf('\n---\n') + 5), body)
  })
})

Deno.test('profile read failures other than NotFound propagate without writing', async () => {
  const failure = new Deno.errors.PermissionDenied('Synthetic read denial')
  const read = Deno.readTextFile
  const write = Deno.writeTextFile
  let writes = 0
  Deno.readTextFile = () => Promise.reject(failure)
  Deno.writeTextFile = () => {
    writes++
    return Promise.resolve()
  }
  try {
    const error = await assertRejects(() =>
      ensureProfileFile('/example/profile.md', 'initial', { name: 'SLV' })
    )
    assertEquals(error, failure)
    assertEquals(writes, 0)
  } finally {
    Deno.readTextFile = read
    Deno.writeTextFile = write
  }
})
