#!/usr/bin/env deno run -A

const CALVER_REGEX = /^(\d{4})\.([1-9]|1[0-2])\.([1-9]|[12]\d|3[01])\.(\d{4})$/
const REPOSITORY = 'ValidatorsDAO/slv'
const API_URL = `https://api.github.com/repos/${REPOSITORY}/pulls`
const REPOSITORY_ACCESS_URL = `https://api.github.com/repos/${REPOSITORY}`
const CANONICAL_ORIGIN_URLS = new Set([
  'https://github.com/ValidatorsDAO/slv.git',
  'git@github.com:ValidatorsDAO/slv.git',
  'ssh://git@github.com/ValidatorsDAO/slv.git',
])

export type CommandResult = { code: number; stdout: string; stderr: string }
export type CommandOptions = { env?: Record<string, string> }
export type ReleaseDependencies = {
  args: string[]
  cwd: () => string
  env: (name: string) => string | undefined
  readTextFile: (path: string) => Promise<string>
  writeTextFile: (path: string, content: string) => Promise<void>
  run: (
    command: string,
    args: string[],
    options?: CommandOptions,
  ) => Promise<CommandResult>
  fetch: typeof fetch
  log: (message: string) => void
  error: (message: string) => void
}

type CommandDependencies = Pick<ReleaseDependencies, 'run'>

export class ReleaseError extends Error {}

type ReleaseStage =
  | 'preflight'
  | 'branch-created'
  | 'version-written'
  | 'version-generated'
  | 'version-verified'
  | 'changes-staged'
  | 'committed'
  | 'pushed'
  | 'pull-request-created'
type RemoteBranchState = 'not-created' | 'existing' | 'pushed' | 'unknown'
type ReleaseState = {
  branchName: string
  stage: ReleaseStage
  localBranch: boolean
  remoteBranch: RemoteBranchState
}

const decoder = new TextDecoder()

const defaultDependencies: ReleaseDependencies = {
  args: Deno.args,
  cwd: Deno.cwd,
  env: Deno.env.get,
  readTextFile: Deno.readTextFile,
  writeTextFile: Deno.writeTextFile,
  async run(command, args, options) {
    const output = await new Deno.Command(command, {
      args,
      cwd: Deno.cwd(),
      env: options?.env
        ? { ...Deno.env.toObject(), ...options.env }
        : undefined,
      stdout: 'piped',
      stderr: 'piped',
    }).output()
    return {
      code: output.code,
      stdout: decoder.decode(output.stdout).trim(),
      stderr: decoder.decode(output.stderr).trim(),
    }
  },
  fetch,
  log: console.log,
  error: console.error,
}

const commandText = (command: string, args: string[]) =>
  [command, ...args].join(' ')

function redactSensitiveText(value: string): string {
  return value
    .replace(
      /\b(https?|ssh):\/\/([^\s/@:]+)(?::[^\s/@]*)?@/gi,
      '$1://<redacted>@',
    )
    .replace(/\b[^\s/@:]+:[^\s/@]+@([^\s/]+)/g, '<redacted>@$1')
    .replace(/([?&](?:access_token|token|password)=)[^&\s]+/gi, '$1<redacted>')
    .replace(/\bBearer\s+\S+/gi, 'Bearer <redacted>')
}

function errorMessage(error: unknown): string {
  return redactSensitiveText(
    error instanceof Error ? error.message : String(error),
  )
}

async function required(
  deps: CommandDependencies,
  command: string,
  args: string[],
): Promise<CommandResult> {
  const result = await deps.run(command, args)
  if (result.code !== 0) {
    const detail = redactSensitiveText(
      result.stderr || result.stdout || 'no output',
    )
    throw new ReleaseError(
      `${redactSensitiveText(commandText(command, args))} failed: ${detail}`,
    )
  }
  return result
}

function parseVersion(args: string[]): string {
  let version: string | undefined
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === '--version' || arg === '-v') {
      if (version !== undefined || index + 1 >= args.length) {
        throw new ReleaseError('Use exactly one --version or -v value.')
      }
      version = args[index + 1]
      index += 1
    } else if (arg.startsWith('--version=') || arg.startsWith('-v=')) {
      if (version !== undefined) {
        throw new ReleaseError('Use exactly one --version or -v value.')
      }
      version = arg.slice(arg.indexOf('=') + 1)
    } else {
      throw new ReleaseError(`Unknown argument: ${arg}`)
    }
  }
  if (!version) {
    throw new ReleaseError(
      'Version is required. Usage: deno task create:release --version YYYY.M.D.HHmm',
    )
  }
  return version
}

function calverParts(version: string): number[] {
  const match = CALVER_REGEX.exec(version)
  if (!match) {
    throw new ReleaseError('Version must be in the format YYYY.M.D.HHmm.')
  }
  const [year, month, day, time] = match.slice(1).map(Number)
  const hour = Math.floor(time / 100)
  const minute = time % 100
  const date = new Date(Date.UTC(year, month - 1, day, hour, minute))
  if (
    date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day || date.getUTCHours() !== hour ||
    date.getUTCMinutes() !== minute
  ) {
    throw new ReleaseError(
      'Version must contain a real UTC calendar date and time.',
    )
  }
  return [year, month, day, hour, minute]
}

function isNewer(next: string, current: string): boolean {
  const nextParts = calverParts(next)
  const currentParts = calverParts(current)
  for (let index = 0; index < nextParts.length; index += 1) {
    if (nextParts[index] !== currentParts[index]) {
      return nextParts[index] > currentParts[index]
    }
  }
  return false
}

function versionFromSource(source: string): string {
  const match = /export const VERSION = '([^']+)'/.exec(source)
  if (!match) {
    throw new ReleaseError('cmn/constants/version.ts does not export VERSION.')
  }
  calverParts(match[1])
  return match[1]
}

function isAllowedGeneratedPath(path: string): boolean {
  return path === 'cmn/constants/version.ts' || path === 'cli/deno.json' ||
    path === 'deno.json' || path === 'sh/install' ||
    path === 'template/latest' ||
    /^sh\/\d+\.\d+\.\d+\.\d+(?:\/|$)/.test(path) ||
    /^template\/\d+\.\d+\.\d+\.\d+(?:\/|$)/.test(path)
}

async function repoValue(
  deps: CommandDependencies,
  ref: string,
): Promise<string> {
  return (await required(deps, 'git', ['rev-parse', ref])).stdout
}

async function assertNoRef(
  deps: CommandDependencies,
  args: string[],
  description: string,
  absentCode: number,
): Promise<void> {
  const result = await deps.run('git', args)
  if (result.code === 0) {
    throw new ReleaseError(`${description} already exists.`)
  }
  if (result.code !== absentCode) {
    throw new ReleaseError(
      `${redactSensitiveText(commandText('git', args))} failed: ${
        redactSensitiveText(result.stderr || result.stdout || 'no output')
      }`,
    )
  }
}

async function assertRepositoryAndOrigin(
  deps: ReleaseDependencies,
): Promise<void> {
  const root = await repoValue(deps, '--show-toplevel')
  if (root !== deps.cwd()) {
    throw new ReleaseError('Run create:release from the repository root.')
  }
  const origin =
    (await required(deps, 'git', ['remote', 'get-url', 'origin'])).stdout
  if (!CANONICAL_ORIGIN_URLS.has(origin)) {
    throw new ReleaseError(
      'origin fetch URL must use an exact canonical GitHub URL for ValidatorsDAO/slv.',
    )
  }
  const pushUrls = (await required(deps, 'git', [
    'remote',
    'get-url',
    '--push',
    '--all',
    'origin',
  ])).stdout.split('\n').map((url) => url.trim()).filter(Boolean)
  if (
    pushUrls.length === 0 ||
    pushUrls.some((url) => !CANONICAL_ORIGIN_URLS.has(url))
  ) {
    throw new ReleaseError(
      'Every effective origin push URL must use an exact canonical GitHub URL for ValidatorsDAO/slv.',
    )
  }
}

function validCommitSha(value: string): boolean {
  return /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i.test(value)
}

export async function fetchReviewedMain(
  deps: CommandDependencies,
): Promise<string> {
  await required(deps, 'git', [
    'fetch',
    'origin',
    '--tags',
    'refs/heads/main:refs/remotes/origin/main',
  ])
  const fetchedMain = await repoValue(deps, 'refs/remotes/origin/main')
  if (!validCommitSha(fetchedMain)) {
    throw new ReleaseError(
      'Fetched refs/remotes/origin/main did not resolve to a commit SHA.',
    )
  }
  return fetchedMain
}

async function preflight(
  deps: ReleaseDependencies,
  newVersion: string,
  authenticated: CommandDependencies,
): Promise<void> {
  await assertRepositoryAndOrigin(deps)
  const status = (await required(deps, 'git', [
    'status',
    '--porcelain',
    '--untracked-files=all',
  ])).stdout
  if (status) {
    throw new ReleaseError(
      'Working tree and index must be clean before creating a release.',
    )
  }
  const branch =
    (await required(deps, 'git', ['branch', '--show-current'])).stdout
  if (branch !== 'main') {
    throw new ReleaseError(
      'Checkout main at the reviewed source commit before creating a release.',
    )
  }
  const [head, main, remoteMain] = await Promise.all([
    repoValue(deps, 'HEAD'),
    repoValue(deps, 'main'),
    fetchReviewedMain(authenticated),
  ])
  if (head !== main || main !== remoteMain) {
    throw new ReleaseError(
      'HEAD, local main, and fetched origin/main must be the same reviewed commit.',
    )
  }
  const current = versionFromSource(
    await deps.readTextFile('cmn/constants/version.ts'),
  )
  if (!isNewer(newVersion, current)) {
    throw new ReleaseError(
      `Version ${newVersion} must be newer than current version ${current}.`,
    )
  }
  const branchName = `release/v${newVersion}`
  await assertNoRef(
    deps,
    [
      'show-ref',
      '--verify',
      '--quiet',
      `refs/heads/${branchName}`,
    ],
    `Local branch ${branchName}`,
    1,
  )
  await assertNoRef(
    authenticated,
    [
      'ls-remote',
      '--exit-code',
      '--heads',
      'origin',
      branchName,
    ],
    `Remote branch ${branchName}`,
    2,
  )
  await assertNoRef(
    deps,
    [
      'show-ref',
      '--verify',
      '--quiet',
      `refs/tags/v${newVersion}`,
    ],
    `Local tag v${newVersion}`,
    1,
  )
  await assertNoRef(
    authenticated,
    [
      'ls-remote',
      '--exit-code',
      '--tags',
      'origin',
      `v${newVersion}`,
    ],
    `Remote tag v${newVersion}`,
    2,
  )
}

async function authenticate(deps: ReleaseDependencies): Promise<string> {
  const token = deps.env('GITHUB_TOKEN')
  if (!token) {
    throw new ReleaseError(
      'GITHUB_TOKEN is required before a release branch can be created.',
    )
  }
  let response: Response
  try {
    response = await deps.fetch(REPOSITORY_ACCESS_URL, {
      headers: { Authorization: `Bearer ${token}` },
    })
  } catch {
    throw new ReleaseError(
      'GitHub repository access preflight did not complete.',
    )
  }
  if (!response.ok) {
    throw new ReleaseError(
      `GitHub repository access preflight failed (${response.status}).`,
    )
  }
  let repository: { full_name?: unknown }
  try {
    repository = await response.json() as { full_name?: unknown }
  } catch {
    throw new ReleaseError(
      'GitHub repository access preflight returned invalid JSON.',
    )
  }
  if (repository.full_name !== REPOSITORY) {
    throw new ReleaseError(
      'GitHub repository access preflight resolved the wrong repository.',
    )
  }
  return token
}

async function withAuthenticatedGit<T>(
  deps: ReleaseDependencies,
  token: string,
  operation: (git: CommandDependencies) => Promise<T>,
): Promise<T> {
  const askpass = await Deno.makeTempFile({ prefix: 'slv-release-askpass-' })
  try {
    // The helper contains no credential. Git receives the exact API token only
    // through this short-lived environment, never through a URL, argv, or config.
    await Deno.writeTextFile(
      askpass,
      "#!/bin/sh\ncase \"$1\" in\n  *Username*) printf '%s\\n' 'x-access-token' ;;\n  *) printf '%s\\n' \"$SLV_RELEASE_GITHUB_TOKEN\" ;;\nesac\n",
    )
    await Deno.chmod(askpass, 0o700)
    const environment = {
      GIT_ASKPASS: askpass,
      GIT_TERMINAL_PROMPT: '0',
      SLV_RELEASE_GITHUB_TOKEN: token,
    }
    return await operation({
      run(command, args) {
        if (command !== 'git') {
          throw new ReleaseError('authenticated transport may only run git')
        }
        return deps.run(command, args, { env: environment })
      },
    })
  } finally {
    await Deno.remove(askpass).catch((error) => {
      if (!(error instanceof Deno.errors.NotFound)) throw error
    })
  }
}

async function changedPaths(
  deps: ReleaseDependencies,
): Promise<{ tracked: string[]; untracked: string[] }> {
  const tracked =
    (await required(deps, 'git', ['diff', '--name-only', 'HEAD'])).stdout
  const untracked = (await required(deps, 'git', [
    'ls-files',
    '--others',
    '--exclude-standard',
  ])).stdout
  return {
    tracked: tracked.split('\n').filter(Boolean).sort(),
    untracked: untracked.split('\n').filter(Boolean).sort(),
  }
}

async function stageGeneratedChanges(deps: ReleaseDependencies): Promise<void> {
  const { tracked, untracked } = await changedPaths(deps)
  const paths = [...new Set([...tracked, ...untracked])].sort()
  if (paths.length === 0) {
    throw new ReleaseError(
      'Version update produced no changes; release was not committed.',
    )
  }
  const unexpected = paths.filter((path) =>
    !isAllowedGeneratedPath(path) &&
    !(tracked.includes(path) && path.startsWith('dist/oss-skills/'))
  )
  if (unexpected.length > 0) {
    throw new ReleaseError(
      `Version update changed paths outside the release allowlist: ${
        unexpected.join(', ')
      }`,
    )
  }
  for (const path of paths) await required(deps, 'git', ['add', '--', path])
  const staged =
    (await required(deps, 'git', ['diff', '--cached', '--name-only'])).stdout
  const stagedPaths = staged ? staged.split('\n').sort() : []
  if (stagedPaths.join('\n') !== paths.join('\n')) {
    throw new ReleaseError('Only generated release paths may be staged.')
  }
}

async function generateAndCommit(
  deps: ReleaseDependencies,
  newVersion: string,
  state: ReleaseState,
): Promise<void> {
  const versionPath = 'cmn/constants/version.ts'
  const versionSource = await deps.readTextFile(versionPath)
  await deps.writeTextFile(
    versionPath,
    versionSource.replace(
      /export const VERSION = '[^']*'/,
      `export const VERSION = '${newVersion}'`,
    ),
  )
  state.stage = 'version-written'
  await required(deps, 'deno', ['run', '-A', 'scripts/update-version.ts'])
  state.stage = 'version-generated'
  await required(deps, 'deno', ['run', '-A', 'scripts/check-version-sync.ts'])
  state.stage = 'version-verified'
  await stageGeneratedChanges(deps)
  state.stage = 'changes-staged'
  await required(deps, 'git', ['commit', '-m', `Release v${newVersion}`])
  state.stage = 'committed'
}

function parseRemoteBranchSha(
  stdout: string,
  branchName: string,
): string {
  const ref = `refs/heads/${branchName}`
  const line = stdout.split('\n').find((candidate) =>
    candidate.trim().split(/\s+/)[1] === ref
  )
  const sha = line?.trim().split(/\s+/)[0]
  if (!sha || !validCommitSha(sha)) {
    throw new ReleaseError(
      `Remote branch ${branchName} did not resolve to a commit SHA.`,
    )
  }
  return sha
}

async function remoteBranchSha(
  deps: CommandDependencies,
  branchName: string,
): Promise<string | undefined> {
  const args = ['ls-remote', '--exit-code', '--heads', 'origin', branchName]
  const result = await deps.run('git', args)
  if (result.code === 2) return undefined
  if (result.code !== 0) {
    throw new ReleaseError(
      `${redactSensitiveText(commandText('git', args))} failed: ${
        redactSensitiveText(result.stderr || result.stdout || 'no output')
      }`,
    )
  }
  return parseRemoteBranchSha(result.stdout, branchName)
}

async function pushCommittedRelease(
  deps: ReleaseDependencies,
  state: ReleaseState,
  authenticated: CommandDependencies,
): Promise<void> {
  const localSha = await repoValue(deps, 'HEAD')
  if (!validCommitSha(localSha)) {
    throw new ReleaseError('HEAD did not resolve to a commit SHA.')
  }
  state.remoteBranch = 'unknown'
  const currentRemoteSha = await remoteBranchSha(
    authenticated,
    state.branchName,
  )
  if (currentRemoteSha) {
    state.remoteBranch = 'existing'
    throw new ReleaseError(
      `Remote branch ${state.branchName} appeared after preflight; it will not be overwritten.`,
    )
  }
  state.remoteBranch = 'unknown'
  const branchRef = `refs/heads/${state.branchName}`
  await required(authenticated, 'git', [
    'push',
    `--force-with-lease=${branchRef}:`,
    'origin',
    `${branchRef}:${branchRef}`,
  ])
  const pushedSha = await remoteBranchSha(authenticated, state.branchName)
  if (pushedSha !== localSha) {
    throw new ReleaseError(
      `Remote branch ${state.branchName} did not resolve to local HEAD after push.`,
    )
  }
  state.remoteBranch = 'pushed'
  state.stage = 'pushed'
}

async function createPullRequest(
  deps: ReleaseDependencies,
  token: string,
  state: ReleaseState,
  newVersion: string,
): Promise<void> {
  let response: Response
  try {
    response = await deps.fetch(API_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        title: `Release v${newVersion}`,
        body:
          `## Release v${newVersion}\n\nThis PR updates the reviewed main commit to v${newVersion}. Build and package the merged release only through the hosted delivery workflow after its selected tag or ref is verified to resolve to this same SHA. Protected publish activation remains subject to its environment approval.`,
        head: state.branchName,
        base: 'main',
      }),
    })
  } catch {
    throw new ReleaseError(
      `Pull Request request did not complete; branch ${state.branchName} remains available and its PR state is unknown.`,
    )
  }
  if (!response.ok) {
    throw new ReleaseError(
      `Pull Request creation failed (${response.status}); branch ${state.branchName} remains available and its PR state is unknown.`,
    )
  }
  let data: { html_url?: string }
  try {
    data = await response.json() as { html_url?: string }
  } catch {
    throw new ReleaseError(
      `Pull Request creation response could not be decoded; branch ${state.branchName} remains available and its PR state is unknown.`,
    )
  }
  state.stage = 'pull-request-created'
  deps.log(`Pull Request created: ${data.html_url ?? state.branchName}`)
}

function recoveryReport(state: ReleaseState): string {
  const local = state.localBranch ? 'preserved' : 'not created'
  const remote = state.remoteBranch === 'pushed'
    ? 'preserved at the pushed release commit'
    : state.remoteBranch === 'existing'
    ? 'already existed and was not modified'
    : state.remoteBranch === 'unknown'
    ? 'unknown after a failed push or verification operation; no cleanup was attempted'
    : 'not created'
  let advice: string
  switch (state.stage) {
    case 'branch-created':
    case 'version-written':
    case 'version-generated':
    case 'version-verified':
    case 'changes-staged':
      advice =
        'Inspect git status --short, git diff, and git diff --cached. Correct the generation or commit failure manually; do not reset, delete, or force-push this branch.'
      break
    case 'committed':
      advice =
        `Inspect git log -1 --format=%B and git ls-remote --heads origin ${state.branchName}. If the reviewed commit is absent remotely, an authorized maintainer can push this exact branch manually; do not force-push.`
      break
    case 'pushed':
      advice =
        `Before any PR-only create, run gh pr list --repo ValidatorsDAO/slv --head ${state.branchName} --state all. Inspect the result and the remote branch; do not retry a PR POST until you confirm no PR exists.`
      break
    case 'pull-request-created':
      advice = 'The release Pull Request was created; no retry is needed.'
      break
    case 'preflight':
      advice =
        'Correct the reported preflight failure, then start a new release command from reviewed main.'
      break
  }
  return `Last completed stage: ${state.stage}. Local branch ${state.branchName}: ${local}. Remote branch ${state.branchName}: ${remote}. ${advice}`
}

export async function createRelease(
  overrides: Partial<ReleaseDependencies> = {},
): Promise<void> {
  const deps = { ...defaultDependencies, ...overrides }
  let state: ReleaseState | undefined
  try {
    const newVersion = parseVersion(deps.args)
    calverParts(newVersion)
    const branchName = `release/v${newVersion}`
    state = {
      branchName,
      stage: 'preflight',
      localBranch: false,
      remoteBranch: 'not-created',
    }
    const token = await authenticate(deps)
    await withAuthenticatedGit(deps, token, async (authenticated) => {
      await preflight(deps, newVersion, authenticated)
      await required(deps, 'git', ['switch', '--create', branchName])
      state!.localBranch = true
      state!.stage = 'branch-created'
      await generateAndCommit(deps, newVersion, state!)
      await pushCommittedRelease(deps, state!, authenticated)
    })
    await createPullRequest(deps, token, state, newVersion)
  } catch (error) {
    const message = errorMessage(error)
    const report = state ? ` ${recoveryReport(state)}` : ''
    const output = `Release preparation stopped: ${message}${report}`
    deps.error(output)
    throw new ReleaseError(output)
  }
}

if (import.meta.main) await createRelease()
