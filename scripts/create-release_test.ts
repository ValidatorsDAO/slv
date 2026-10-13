import {
  type CommandResult,
  createRelease,
  fetchReviewedMain,
  type ReleaseDependencies,
} from './create-release.ts'

const ROOT = '/tmp/slv'
const VERSION_SOURCE = "export const VERSION = '2026.6.6.2026'\n"
const SHA = 'a'.repeat(40)
const RELEASE_BRANCH = 'release/v2026.6.7.0001'
const RELEASE_REF = `refs/heads/${RELEASE_BRANCH}`
const PUSH_COMMAND =
  `git push --force-with-lease=${RELEASE_REF}: origin ${RELEASE_REF}:${RELEASE_REF}`

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

function assertEquals(
  actual: unknown,
  expected: unknown,
  message = 'values differ',
) {
  assert(JSON.stringify(actual) === JSON.stringify(expected), message)
}

function result(code = 0, stdout = '', stderr = ''): CommandResult {
  return { code, stdout, stderr }
}

type Fixture = {
  calls: string[]
  commandEnvironments: Array<Record<string, string> | undefined>
  writes: string[]
  errors: string[]
  fetches: string[]
  deps: Partial<ReleaseDependencies>
}

function fixture(overrides: Record<string, CommandResult> = {}): Fixture {
  const calls: string[] = []
  const commandEnvironments: Array<Record<string, string> | undefined> = []
  const writes: string[] = []
  const errors: string[] = []
  const fetches: string[] = []
  let pushed = false
  const deps: Partial<ReleaseDependencies> = {
    args: ['--version', '2026.6.7.0001'],
    cwd: () => ROOT,
    env: (name) => name === 'GITHUB_TOKEN' ? 'test-token' : undefined,
    readTextFile: async () => VERSION_SOURCE,
    writeTextFile: async (path) => {
      writes.push(path)
    },
    error: (message) => errors.push(message),
    log: () => {},
    async run(command, args, options) {
      const key = `${command} ${args.join(' ')}`
      calls.push(key)
      commandEnvironments.push(options?.env)
      if (overrides[key]) return overrides[key]
      if (key === 'git rev-parse --show-toplevel') return result(0, ROOT)
      if (key.startsWith('git rev-parse ')) return result(0, SHA)
      if (key === 'git remote get-url origin') {
        return result(0, 'git@github.com:ValidatorsDAO/slv.git')
      }
      if (key === 'git remote get-url --push --all origin') {
        return result(0, 'git@github.com:ValidatorsDAO/slv.git')
      }
      if (key === 'git status --porcelain --untracked-files=all') {
        return result()
      }
      if (key === 'git branch --show-current') return result(0, 'main')
      if (key.startsWith('git show-ref ')) return result(1)
      if (key.startsWith('git ls-remote ')) {
        if (key.includes('--heads origin release/')) {
          return pushed
            ? result(0, `${SHA}\trefs/heads/release/v2026.6.7.0001`)
            : result(2)
        }
        return result(2)
      }
      if (key === 'git diff --name-only HEAD') {
        return result(0, 'cmn/constants/version.ts\nsh/2026.6.7.0001/install')
      }
      if (key === 'git ls-files --others --exclude-standard') return result()
      if (key === 'git diff --cached --name-only') {
        return result(0, 'cmn/constants/version.ts\nsh/2026.6.7.0001/install')
      }
      if (key === PUSH_COMMAND) {
        pushed = true
        return result()
      }
      return result()
    },
    async fetch(input, init) {
      const url = String(input)
      fetches.push(`${init?.method ?? 'GET'} ${url}`)
      if (init?.method === 'POST') {
        return new Response(
          JSON.stringify({ html_url: 'https://example.test/pr/1' }),
          { status: 200 },
        )
      }
      return new Response(
        url.includes('/pulls?') ? '[]' : JSON.stringify({
          full_name: 'ValidatorsDAO/slv',
        }),
        {
          status: 200,
        },
      )
    },
  }
  return { calls, commandEnvironments, writes, errors, fetches, deps }
}

async function rejects(f: Fixture, includes: string) {
  let thrown: unknown
  try {
    await createRelease(f.deps)
  } catch (error) {
    thrown = error
  }
  assert(thrown instanceof Error, 'expected release to reject')
  assert(
    thrown.message.includes(includes),
    `expected ${includes}, got ${thrown.message}`,
  )
}

Deno.test('release argument validation rejects malformed and conflicting flags before subprocesses', async () => {
  const malformed = fixture()
  malformed.deps.args = ['--version', '2026.2.30.2400']
  await rejects(malformed, 'real UTC')
  assert(malformed.calls.length === 0, 'malformed version must not run git')

  const padded = fixture()
  padded.deps.args = ['--version', '2026.06.07.0001']
  await rejects(padded, 'format')
  assert(padded.calls.length === 0, 'padded version must not run git')

  const canonical = fixture()
  canonical.deps.args = ['-v', '2026.6.7.0001']
  await createRelease(canonical.deps)
  assert(
    canonical.calls.includes(
      'git switch --create release/v2026.6.7.0001',
    ),
    'canonical unpadded version was not accepted',
  )

  const conflicting = fixture()
  conflicting.deps.args = ['--version', '2026.6.7.0001', '-v', '2026.6.8.0001']
  await rejects(conflicting, 'exactly one')
  assert(
    conflicting.calls.length === 0,
    'conflicting arguments must not run git',
  )

  const resume = fixture()
  resume.deps.args = ['--resume', '--version', '2026.6.7.0001']
  await rejects(resume, 'Unknown argument: --resume')
  assert(resume.calls.length === 0, 'unknown resume flag must not run git')
})

Deno.test('dirty tree, missing token, and remote tag collision stop before branch creation', async () => {
  const dirty = fixture({
    'git status --porcelain --untracked-files=all': result(0, ' M README.md'),
  })
  await rejects(dirty, 'must be clean')
  assert(
    !dirty.calls.some((call) => call.includes('switch --create')),
    'dirty tree created a branch',
  )

  const token = fixture()
  token.deps.env = () => undefined
  await rejects(token, 'GITHUB_TOKEN')
  assert(
    !token.calls.some((call) => call.includes('switch --create')),
    'missing token created a branch',
  )

  const tag = fixture({
    'git ls-remote --exit-code --tags origin v2026.6.7.0001': result(
      0,
      'sha\trefs/tags/v2026.6.7.0001',
    ),
  })
  await rejects(tag, 'Remote tag')
  assert(
    !tag.calls.some((call) => call.includes('switch --create')),
    'tag collision created a branch',
  )
})

Deno.test('repository-scoped auth accepts one explicit token for API and Git transport without leaking it', async () => {
  const release = fixture()
  const requests: Array<{ url: string; authorization: string | null }> = []
  release.deps.fetch = async (input, init) => {
    const headers = new Headers(init?.headers)
    requests.push({
      url: String(input),
      authorization: headers.get('Authorization'),
    })
    if (init?.method === 'POST') {
      return new Response(
        JSON.stringify({ html_url: 'https://example.test/pr/1' }),
        {
          status: 200,
        },
      )
    }
    return new Response(JSON.stringify({ full_name: 'ValidatorsDAO/slv' }), {
      status: 200,
    })
  }
  await createRelease(release.deps)
  assertEquals(requests[0], {
    url: 'https://api.github.com/repos/ValidatorsDAO/slv',
    authorization: 'Bearer test-token',
  })
  const push = release.calls.indexOf(PUSH_COMMAND)
  const environment = release.commandEnvironments[push]
  assert(
    environment?.SLV_RELEASE_GITHUB_TOKEN === 'test-token',
    'push did not receive the explicit API token through the ephemeral environment',
  )
  assert(environment?.GIT_ASKPASS, 'push did not use an askpass helper')
  assertEquals(environment?.GIT_TERMINAL_PROMPT, '0')
  assert(
    !release.calls.join('\n').includes('test-token') &&
      !release.errors.join('\n').includes('test-token'),
    'explicit token leaked through command or error output',
  )
})

Deno.test('repository access preflight rejects mismatched, unauthorized, and forbidden tokens before a branch exists', async () => {
  const mismatch = fixture()
  mismatch.deps.fetch = async () =>
    new Response(JSON.stringify({ full_name: 'someone-else/slv' }), {
      status: 200,
    })
  await rejects(mismatch, 'wrong repository')
  assert(
    !mismatch.calls.some((call) => call.includes('switch --create')),
    'wrong-repository token created a branch',
  )

  for (const status of [401, 403]) {
    const denied = fixture()
    denied.deps.fetch = async () => new Response('', { status })
    await rejects(denied, `preflight failed (${status})`)
    assert(
      !denied.calls.some((call) => call.includes('switch --create')),
      `${status} token created a branch`,
    )
    assert(
      !denied.errors.join('\n').includes('test-token'),
      `${status} response leaked the token`,
    )
  }
})

Deno.test('origin and every effective push URL must be exact canonical GitHub URLs', async () => {
  const lookalike = fixture({
    'git remote get-url origin': result(
      0,
      'ssh://git@attacker.example/ValidatorsDAO/slv.git',
    ),
  })
  await rejects(lookalike, 'origin fetch URL')
  assert(
    !lookalike.calls.some((call) => call.includes('switch --create')),
    'lookalike origin created a branch',
  )

  const credentialedPushUrl = fixture({
    'git remote get-url --push --all origin': result(
      0,
      'git@github.com:ValidatorsDAO/slv.git\nhttps://user:secret@github.com/ValidatorsDAO/slv.git',
    ),
  })
  await rejects(credentialedPushUrl, 'effective origin push URL')
  assert(
    !credentialedPushUrl.calls.some((call) => call.includes('switch --create')),
    'credentialed push URL created a branch',
  )

  const multiplePushUrls = fixture({
    'git remote get-url --push --all origin': result(
      0,
      'git@github.com:ValidatorsDAO/slv.git\ngit@github.com:ValidatorsDAO/slv.git',
    ),
  })
  await createRelease(multiplePushUrls.deps)
})

Deno.test('Git absence exit codes and the explicit main refspec are enforced', async () => {
  const localFailure = fixture({
    'git show-ref --verify --quiet refs/heads/release/v2026.6.7.0001': result(
      2,
      '',
      'local ref query failed',
    ),
  })
  await rejects(localFailure, 'local ref query failed')
  assert(
    !localFailure.calls.some((call) => call.includes('switch --create')),
    'local ref query failure created a branch',
  )

  const remoteFailure = fixture({
    'git ls-remote --exit-code --heads origin release/v2026.6.7.0001': result(
      1,
      '',
      'remote query failed: https://user:secret@github.com/ValidatorsDAO/slv.git',
    ),
  })
  await rejects(
    remoteFailure,
    'remote query failed: https://<redacted>@github.com',
  )
  assert(
    remoteFailure.errors.every((message) => !message.includes('secret')),
    'subprocess credential was exposed in release output',
  )
  assert(
    !remoteFailure.calls.some((call) => call.includes('switch --create')),
    'remote query failure created a branch',
  )

  const explicitFetch = fixture()
  await createRelease(explicitFetch.deps)
  assert(
    explicitFetch.calls.includes(
      'git fetch origin --tags refs/heads/main:refs/remotes/origin/main',
    ),
    'main was not fetched with the explicit origin/main refspec',
  )
})

Deno.test('failed update and unexpected generated paths never reach commit', async () => {
  const update = fixture({
    'deno run -A scripts/update-version.ts': result(1, '', 'build failed'),
  })
  await rejects(update, 'update-version.ts')
  assert(
    !update.calls.some((call) => call.includes('check-version-sync')),
    'check ran after update failure',
  )
  assert(
    !update.calls.some((call) => call.includes('git commit')),
    'commit ran after update failure',
  )

  const unexpected = fixture({
    'git diff --name-only HEAD': result(
      0,
      'cmn/constants/version.ts\nREADME.md',
    ),
  })
  await rejects(unexpected, 'outside the release allowlist')
  assert(
    !unexpected.calls.some((call) => call.startsWith('git add ')),
    'unexpected file reached staging',
  )
  assert(
    !unexpected.calls.some((call) => call.includes('git commit')),
    'unexpected file reached commit',
  )

  const check = fixture({
    'deno run -A scripts/check-version-sync.ts': result(1, '', 'out of sync'),
  })
  await rejects(check, 'check-version-sync.ts')
  assert(
    !check.calls.some((call) => call.startsWith('git add ')),
    'staging ran after sync check failure',
  )

  const add = fixture({
    'git add -- cmn/constants/version.ts': result(1, '', 'index failed'),
  })
  await rejects(add, 'git add')
  assert(
    !add.calls.some((call) => call.includes('git commit')),
    'commit ran after staging failure',
  )
})

Deno.test('commit and push failures prevent later stages', async () => {
  const commit = fixture({
    'git commit -m Release v2026.6.7.0001': result(1, '', 'identity missing'),
  })
  await rejects(commit, 'git commit')
  assert(
    !commit.calls.some((call) => call.startsWith('git push ')),
    'push ran after commit failure',
  )

  const push = fixture({
    [PUSH_COMMAND]: result(1, '', 'rejected'),
  })
  await rejects(push, 'git push')
  assert(
    push.errors.some((message) =>
      message.includes('Last completed stage: committed') &&
      message.includes(
        'git ls-remote --heads origin release/v2026.6.7.0001',
      )
    ),
    'push failure did not provide safe manual recovery guidance',
  )
  assert(
    !push.fetches.some((call) => call.startsWith('POST')),
    'PR API ran after push failure',
  )
})

Deno.test('PR API failure preserves the pushed branch and success stages only allowlisted paths', async () => {
  const api = fixture()
  api.deps.fetch = async (input, init) => {
    api.fetches.push(`${init?.method ?? 'GET'} ${String(input)}`)
    const url = String(input)
    return new Response(
      init?.method === 'POST'
        ? '{}'
        : url.includes('/pulls?')
        ? '[]'
        : JSON.stringify({ full_name: 'ValidatorsDAO/slv' }),
      { status: init?.method === 'POST' ? 500 : 200 },
    )
  }
  await rejects(api, 'branch release/v2026.6.7.0001 remains available')
  assert(
    api.calls.some((call) => call === PUSH_COMMAND),
    'branch was not pushed before API failure',
  )
  assert(
    !api.calls.some((call) =>
      call.includes('branch -D') || call.includes('reset')
    ),
    'failure attempted destructive cleanup',
  )
  assert(
    api.errors.some((message) =>
      message.includes('Last completed stage: pushed') &&
      message.includes(
        'gh pr list --repo ValidatorsDAO/slv --head release/v2026.6.7.0001 --state all',
      )
    ),
    'PR failure did not provide duplicate-safe recovery advice',
  )

  const success = fixture()
  await createRelease(success.deps)
  const adds = success.calls.filter((call) => call.startsWith('git add '))
  assert(
    adds.length === 2,
    `expected two exact git add calls, got ${adds.join(', ')}`,
  )
  assert(
    adds.every((call) => !call.includes(' -A') && !call.endsWith(' .')),
    'broad staging was used',
  )
  assert(
    success.calls.some((call) => call === PUSH_COMMAND),
    'successful sequence did not push',
  )
  assert(
    success.fetches.some((call) => call.startsWith('POST')),
    'successful sequence did not create PR',
  )
})

Deno.test('PR transport failure directs a manual existing-PR inspection before retry', async () => {
  const transport = fixture()
  transport.deps.fetch = async (input, init) => {
    transport.fetches.push(`${init?.method ?? 'GET'} ${String(input)}`)
    if (init?.method === 'POST') throw new Error('network unavailable')
    return new Response(JSON.stringify({ full_name: 'ValidatorsDAO/slv' }), {
      status: 200,
    })
  }
  await rejects(transport, 'Pull Request request did not complete')
  assert(
    transport.errors.some((message) =>
      message.includes('Last completed stage: pushed') &&
      message.includes(
        'gh pr list --repo ValidatorsDAO/slv --head release/v2026.6.7.0001 --state all',
      )
    ),
    'PR transport failure did not provide manual duplicate-safe guidance',
  )
})

const decoder = new TextDecoder()

async function gitResult(cwd: string, args: string[]): Promise<CommandResult> {
  const output = await new Deno.Command('git', {
    args,
    cwd,
    stdout: 'piped',
    stderr: 'piped',
  }).output()
  return {
    code: output.code,
    stdout: decoder.decode(output.stdout).trim(),
    stderr: decoder.decode(output.stderr).trim(),
  }
}

async function git(cwd: string, args: string[]): Promise<string> {
  const output = await gitResult(cwd, args)
  if (output.code !== 0) {
    throw new Error(
      `${args.join(' ')} failed: ${output.stderr}`,
    )
  }
  return output.stdout
}

Deno.test({
  name:
    'explicit fetch refspec repairs a custom origin fetch mapping in a local repository',
  permissions: { read: true, run: true, write: true },
  async fn() {
    const root = await Deno.makeTempDir({ prefix: 'slv-create-release-' })
    const remote = `${root}/remote.git`
    const work = `${root}/work`
    try {
      await git(root, ['init', '--bare', remote])
      await git(root, ['init', '--initial-branch=main', work])
      await git(work, ['config', 'user.email', 'release-test@example.test'])
      await git(work, ['config', 'user.name', 'Release Test'])
      await Deno.writeTextFile(`${work}/fixture.txt`, 'fixture\n')
      await git(work, ['add', 'fixture.txt'])
      await git(work, ['commit', '-m', 'fixture'])
      await git(work, ['remote', 'add', 'origin', remote])
      await git(work, ['push', 'origin', 'main'])
      await git(work, [
        'config',
        'remote.origin.fetch',
        '+refs/heads/*:refs/remotes/origin/custom/*',
      ])
      await git(work, ['fetch', 'origin'])
      const expected = await git(work, ['rev-parse', 'HEAD'])
      const fetched = await fetchReviewedMain({
        run: async (command, args) => {
          const output = await new Deno.Command(command, {
            args,
            cwd: work,
            stdout: 'piped',
            stderr: 'piped',
          }).output()
          return {
            code: output.code,
            stdout: decoder.decode(output.stdout).trim(),
            stderr: decoder.decode(output.stderr).trim(),
          }
        },
      })
      assert(
        fetched === expected,
        'explicit fetch did not return origin/main SHA',
      )
      assert(
        await git(work, ['rev-parse', 'refs/remotes/origin/main']) === expected,
        'explicit refspec did not populate refs/remotes/origin/main',
      )
    } finally {
      await Deno.remove(root, { recursive: true })
    }
  },
})

Deno.test({
  name:
    'explicit source and destination with an empty lease ignore hostile push mapping and reject a branch-creation race',
  permissions: { read: true, run: true, write: true },
  async fn() {
    const root = await Deno.makeTempDir({ prefix: 'slv-create-release-push-' })
    const remote = `${root}/remote.git`
    const work = `${root}/work`
    try {
      await git(root, ['init', '--bare', remote])
      await git(root, ['init', '--initial-branch=main', work])
      await git(work, ['config', 'user.email', 'release-test@example.test'])
      await git(work, ['config', 'user.name', 'Release Test'])
      await Deno.writeTextFile(`${work}/fixture.txt`, 'main\n')
      await git(work, ['add', 'fixture.txt'])
      await git(work, ['commit', '-m', 'main'])
      await git(work, ['remote', 'add', 'origin', remote])
      await git(work, ['push', 'origin', 'main'])
      const remoteMain = await git(remote, ['rev-parse', 'refs/heads/main'])

      await git(work, ['switch', '--create', RELEASE_BRANCH])
      await Deno.writeTextFile(`${work}/fixture.txt`, 'release\n')
      await git(work, ['commit', '-am', 'release'])
      const firstRelease = await git(work, ['rev-parse', 'HEAD'])
      await git(work, [
        'config',
        'remote.origin.push',
        `${RELEASE_REF}:refs/heads/main`,
      ])

      await git(work, [
        'push',
        `--force-with-lease=${RELEASE_REF}:`,
        'origin',
        `${RELEASE_REF}:${RELEASE_REF}`,
      ])
      assert(
        await git(remote, ['rev-parse', 'refs/heads/main']) === remoteMain,
        'hostile remote.origin.push advanced remote main',
      )
      assert(
        await git(remote, ['rev-parse', RELEASE_REF]) === firstRelease,
        'explicit release destination was not created',
      )

      await Deno.writeTextFile(`${work}/fixture.txt`, 'racing release\n')
      await git(work, ['commit', '-am', 'local follow-up'])
      const race = await gitResult(work, [
        'push',
        `--force-with-lease=${RELEASE_REF}:`,
        'origin',
        `${RELEASE_REF}:${RELEASE_REF}`,
      ])
      assert(
        race.code !== 0,
        'existing remote release branch bypassed empty lease',
      )
      assert(
        await git(remote, ['rev-parse', RELEASE_REF]) === firstRelease,
        'branch-creation race modified the existing remote release branch',
      )
      assert(
        await git(remote, ['rev-parse', 'refs/heads/main']) === remoteMain,
        'branch-creation race modified remote main',
      )
    } finally {
      await Deno.remove(root, { recursive: true })
    }
  },
})
