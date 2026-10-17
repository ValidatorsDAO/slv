/**
 * Checksum-pinned prerequisite acquisition for verify-native.ts.
 *
 * This does not manufacture tool URLs. A target without an explicit public
 * URL, archive checksum, extracted identity, and environment mapping fails.
 */
import { createHash } from 'node:crypto'
import { posix } from 'node:path'

const SHA256 = /^[a-f0-9]{64}$/
const TARGETS = new Set([
  'x86_64-unknown-linux-gnu',
  'aarch64-unknown-linux-gnu',
  'x86_64-apple-darwin',
  'aarch64-apple-darwin',
])

type ToolPin = {
  name: string
  version: string
  url: string
  sha256: string
  format: 'tar.gz' | 'tar.xz' | 'zip'
  redirect_hosts?: string[]
  strip_components?: number
  identities: { path: string; sha256: string }[]
  install?: {
    kind: 'rust-dist-component'
    group: string
    prefix: string
    script: string
    disable_ldconfig: boolean
  }
  installed_identities?: { path: string; sha256: string }[]
  include_members?: string[]
}
type TargetToolSet = {
  tools: ToolPin[]
  environment: Record<string, string>
  layout: {
    links: { source: string; destination: string; sha256: string }[]
    markers: { path: string; content: string }[]
    post_extract_identities: { path: string; sha256: string }[]
  }
}
export type LayoutPlacement = {
  source: string
  destination: string
  sha256: string
}
type TargetPins = TargetToolSet & { execution?: TargetToolSet }
type ToolPins = {
  schema_version: 1
  kind: 'slv-native-tool-pins'
  targets: Record<string, TargetPins>
}
type Args = Record<string, string | boolean>
type Purpose = 'build' | 'execution'

const CROSS_BUILD = {
  target: 'aarch64-unknown-linux-gnu',
  buildHost: 'x86_64-unknown-linux-gnu',
} as const
const DENO_SYSROOT_COMMON_MEMBERS = [
  'sysroot/.env',
  'sysroot/lib',
  'sysroot/usr/include',
  'sysroot/usr/lib',
]
const DENO_SYSROOT_X64_MEMBERS = [
  ...DENO_SYSROOT_COMMON_MEMBERS.slice(0, 2),
  'sysroot/lib64',
  ...DENO_SYSROOT_COMMON_MEMBERS.slice(2),
]
const DENO_SYSROOT_X64_SHA256 =
  '64513b04d8a38da6f47c0a9c4cb47b2ce7bcb735250b10eb10751aec6afe46ee'
const DENO_SYSROOT_ARM64_SHA256 =
  '0a29c63c52cc1e59228686602cf3cf41080a809655afc29d1b8a27af4b20cedb'

async function sha256(path: string): Promise<string> {
  const handle = await Deno.open(path)
  const hash = createHash('sha256')
  try {
    const chunk = new Uint8Array(1024 * 1024)
    for (;;) {
      const length = await handle.read(chunk)
      if (length === null) break
      hash.update(chunk.subarray(0, length))
    }
  } finally {
    handle.close()
  }
  return hash.digest('hex')
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`)
  }
  return value as Record<string, unknown>
}

function nonempty(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value) {
    throw new Error(`${label} must be a non-empty string`)
  }
  return value
}

function safeRelative(path: string, label: string): string {
  if (
    path.startsWith('/') || path.includes('\\') ||
    path.split('/').includes('..')
  ) throw new Error(`unsafe ${label}: ${path}`)
  return path
}

function parseArgs(argv: string[]): Args {
  const values: Args = {}
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index]
    if (flag === '--offline') {
      if (values[flag] !== undefined) throw new Error('duplicate --offline')
      values[flag] = true
      continue
    }
    if (
      !flag.startsWith('--') || values[flag] !== undefined ||
      index + 1 >= argv.length || argv[index + 1].startsWith('--')
    ) {
      throw new Error(
        'usage: prepare-tools.ts --target TARGET [--build-host HOST] [--purpose build|execution] --pins TOOL_PINS_JSON --out EMPTY_TOOLS_DIR --receipt TOOLS_RECEIPT_JSON [--descriptor TARGET_DESCRIPTOR_JSON] [--cache CACHE_DIR] [--offline]',
      )
    }
    values[flag] = argv[++index]
  }
  for (const required of ['--target', '--pins', '--out', '--receipt']) {
    if (typeof values[required] !== 'string') {
      throw new Error(`missing ${required}`)
    }
  }
  return values
}

async function regularFile(path: string, label: string): Promise<void> {
  const info = await Deno.lstat(path).catch(() => undefined)
  if (!info?.isFile || info.isSymlink) {
    throw new Error(`${label} must be a regular file: ${path}`)
  }
}

async function emptyDirectory(path: string): Promise<string> {
  const info = await Deno.stat(path).catch(() => undefined)
  if (info && !info.isDirectory) {
    throw new Error(`tools output is not a directory: ${path}`)
  }
  if (!info) await Deno.mkdir(path, { recursive: true })
  for await (const _ of Deno.readDir(path)) {
    throw new Error(`tools output must be empty: ${path}`)
  }
  return await Deno.realPath(path)
}

export function parseToolPins(value: unknown): ToolPins {
  const root = object(value, 'tool pins')
  if (root.schema_version !== 1 || root.kind !== 'slv-native-tool-pins') {
    throw new Error('unsupported tool pins schema')
  }
  const targets = object(root.targets, 'tool pins targets')
  const parsed: Record<string, TargetPins> = {}
  for (const [target, targetValue] of Object.entries(targets)) {
    if (!TARGETS.has(target)) {
      throw new Error(`unsupported target in tool pins: ${target}`)
    }
    const targetObject = object(targetValue, `tool pins target ${target}`)
    if (!Array.isArray(targetObject.tools) || targetObject.tools.length === 0) {
      throw new Error(`tool pins target ${target} has no tools`)
    }
    const names = new Set<string>()
    const tools = targetObject.tools.map((toolValue): ToolPin => {
      const tool = object(toolValue, `tool pin for ${target}`)
      const name = nonempty(tool.name, 'tool name')
      if (!/^[a-z0-9][a-z0-9._-]*$/.test(name) || names.has(name)) {
        throw new Error(`invalid or duplicate tool name: ${name}`)
      }
      names.add(name)
      const urlText = nonempty(tool.url, `${name} URL`)
      const url = new URL(urlText)
      if (url.protocol !== 'https:') {
        throw new Error(`${name} URL must be public HTTPS`)
      }
      const format = nonempty(tool.format, `${name} format`)
      if (format !== 'tar.gz' && format !== 'tar.xz' && format !== 'zip') {
        throw new Error(`${name} has unsupported archive format`)
      }
      const digest = nonempty(tool.sha256, `${name} archive digest`)
      if (!SHA256.test(digest)) {
        throw new Error(`${name} archive digest is invalid`)
      }
      const identities = tool.identities
      if (!Array.isArray(identities) || identities.length === 0) {
        throw new Error(`${name} requires extracted tool identities`)
      }
      const parseIdentities = (value: unknown, label: string) => {
        if (!Array.isArray(value) || value.length === 0) {
          throw new Error(`${name} requires ${label}`)
        }
        return value.map((identityValue) => {
          const identity = object(identityValue, `${name} identity`)
          const path = safeRelative(
            nonempty(identity.path, `${name} identity path`),
            `${name} identity path`,
          )
          const hash = nonempty(identity.sha256, `${name} identity digest`)
          if (!SHA256.test(hash)) {
            throw new Error(`${name} identity digest is invalid`)
          }
          return { path, sha256: hash }
        })
      }
      let install: ToolPin['install']
      let installed_identities: ToolPin['installed_identities']
      let include_members: ToolPin['include_members']
      if (tool.install !== undefined) {
        const rawInstall = object(tool.install, `${name} installer`)
        if (
          rawInstall.kind !== 'rust-dist-component' ||
          rawInstall.disable_ldconfig !== true
        ) {
          throw new Error(`${name} has an unsupported installer contract`)
        }
        install = {
          kind: 'rust-dist-component',
          group: safeRelative(
            nonempty(rawInstall.group, `${name} installer group`),
            `${name} installer group`,
          ),
          prefix: safeRelative(
            nonempty(rawInstall.prefix, `${name} installer prefix`),
            `${name} installer prefix`,
          ),
          script: safeRelative(
            nonempty(rawInstall.script, `${name} installer script`),
            `${name} installer script`,
          ),
          disable_ldconfig: true,
        }
        installed_identities = parseIdentities(
          tool.installed_identities,
          'installed identities',
        )
      }
      if (tool.include_members !== undefined) {
        if (!Array.isArray(tool.include_members) || name !== 'deno-sysroot') {
          throw new Error(
            `${name} has an unsupported scoped extraction contract`,
          )
        }
        const expected = digest === DENO_SYSROOT_X64_SHA256
          ? DENO_SYSROOT_X64_MEMBERS
          : digest === DENO_SYSROOT_ARM64_SHA256
          ? DENO_SYSROOT_COMMON_MEMBERS
          : undefined
        if (!expected) {
          throw new Error(
            'Deno ABI sysroot has an unrecognized archive identity',
          )
        }
        const allowed = new Set(expected)
        include_members = tool.include_members.map((member) => {
          const path = safeRelative(
            nonempty(member, `${name} scoped archive member`),
            `${name} scoped archive member`,
          )
          if (!allowed.has(path)) {
            throw new Error(
              `${name} has an unapproved scoped archive member: ${path}`,
            )
          }
          return path
        })
        if (
          include_members.length !== expected.length ||
          new Set(include_members).size !== allowed.size
        ) {
          throw new Error(
            `${name} scoped extraction must include exactly the approved compiler subset`,
          )
        }
      }
      return {
        name,
        version: nonempty(tool.version, `${name} version`),
        url: urlText,
        sha256: digest,
        format,
        redirect_hosts: tool.redirect_hosts === undefined ? [] : (() => {
          if (!Array.isArray(tool.redirect_hosts)) {
            throw new Error(`${name} redirect hosts must be an array`)
          }
          return tool.redirect_hosts.map((host) => {
            const value = nonempty(host, `${name} redirect host`).toLowerCase()
            if (!/^[a-z0-9.-]+$/.test(value)) {
              throw new Error(`${name} has unsafe redirect host`)
            }
            return value
          })
        })(),
        strip_components: tool.strip_components === undefined
          ? undefined
          : Number(tool.strip_components),
        identities: parseIdentities(identities, 'extracted identities'),
        install,
        installed_identities,
        include_members,
      }
    })
    const rawEnvironment = object(
      targetObject.environment,
      `${target} environment`,
    )
    const environment: Record<string, string> = {}
    for (const [key, value] of Object.entries(rawEnvironment)) {
      if (!/^[A-Z0-9_]+$/.test(key)) {
        throw new Error(`unsafe tools environment key: ${key}`)
      }
      const text = nonempty(value, `tools environment ${key}`)
      if (!text.startsWith('@tool/')) {
        throw new Error(
          `tools environment ${key} must reference an acquired tool`,
        )
      }
      const [, name, ...rest] = text.split('/')
      if (!names.has(name) || rest.length === 0) {
        throw new Error(
          `tools environment ${key} references an unknown or root-only tool path`,
        )
      }
      safeRelative(rest.join('/'), `tools environment ${key}`)
      environment[key] = text
    }
    if (!environment.DENO_FRONTEND) {
      throw new Error(
        `tool pins ${target} lacks required environment DENO_FRONTEND`,
      )
    }
    const rawLayout = object(targetObject.layout, `${target} layout`)
    const parseLayoutIdentities = (value: unknown, label: string) => {
      if (!Array.isArray(value) || value.length === 0) {
        throw new Error(`${target} layout requires ${label}`)
      }
      return value.map((entryValue) => {
        const entry = object(entryValue, `${target} layout identity`)
        const path = safeRelative(
          nonempty(entry.path, `${target} layout identity path`),
          `${target} layout identity path`,
        )
        const hash = nonempty(entry.sha256, `${target} layout identity digest`)
        if (!SHA256.test(hash)) {
          throw new Error(`${target} layout identity digest is invalid`)
        }
        return { path, sha256: hash }
      })
    }
    if (
      !Array.isArray(rawLayout.links) || !Array.isArray(rawLayout.markers)
    ) {
      throw new Error(`${target} layout is incomplete`)
    }
    const links: LayoutPlacement[] = rawLayout.links.map((entryValue) => {
      const entry = object(entryValue, `${target} layout link`)
      const source = safeRelative(
        nonempty(entry.source, `${target} layout link source`),
        `${target} layout link source`,
      )
      const destination = safeRelative(
        nonempty(entry.destination, `${target} layout link destination`),
        `${target} layout link destination`,
      )
      const hash = nonempty(entry.sha256, `${target} layout link digest`)
      if (!SHA256.test(hash)) {
        throw new Error(`${target} layout link digest is invalid`)
      }
      return { source, destination, sha256: hash }
    })
    const markers = rawLayout.markers.map((entryValue) => {
      const entry = object(entryValue, `${target} layout marker`)
      return {
        path: safeRelative(
          nonempty(entry.path, `${target} layout marker path`),
          `${target} layout marker path`,
        ),
        content: nonempty(entry.content, `${target} layout marker content`),
      }
    })
    parsed[target] = {
      tools,
      environment,
      layout: {
        links,
        markers,
        post_extract_identities: parseLayoutIdentities(
          rawLayout.post_extract_identities,
          'post-extract identities',
        ),
      },
    }
    if (targetObject.execution !== undefined) {
      const executionPins = parseToolPins({
        schema_version: 1,
        kind: 'slv-native-tool-pins',
        targets: { [target]: targetObject.execution },
      })
      parsed[target].execution = executionPins.targets[target]
    }
  }
  return { schema_version: 1, kind: 'slv-native-tool-pins', targets: parsed }
}

export async function download(
  urlText: string,
  output: string,
  redirectHosts: readonly string[],
): Promise<void> {
  let url = new URL(urlText)
  const allowed = new Set([url.hostname.toLowerCase(), ...redirectHosts])
  for (let hop = 0; hop <= 5; hop++) {
    const response = await fetch(url, { redirect: 'manual' })
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location')
      if (!location || hop === 5) {
        throw new Error(
          `tool download redirect is incomplete or exceeds bound: ${url}`,
        )
      }
      const next = new URL(location, url)
      if (
        next.protocol !== 'https:' || !allowed.has(next.hostname.toLowerCase())
      ) {
        throw new Error(
          `tool download redirect is not an approved HTTPS distribution host: ${next}`,
        )
      }
      url = next
      continue
    }
    if (!response.ok || !response.body) {
      throw new Error(`tool download failed: ${url} (${response.status})`)
    }
    const file = await Deno.open(output, {
      create: true,
      write: true,
      truncate: true,
    })
    try {
      // Keep ownership of the FsFile: pipeTo closes its destination by
      // default, which made a cold-cache acquisition throw BadResource in
      // this finally block after otherwise successful downloads.
      await response.body.pipeTo(file.writable, { preventClose: true })
    } finally {
      file.close()
    }
    return
  }
  throw new Error(`tool download redirect loop: ${urlText}`)
}

async function command(
  executable: string,
  args: string[],
  cwd: string,
): Promise<void> {
  const result = await new Deno.Command(executable, {
    args,
    cwd,
    stdout: 'piped',
    stderr: 'piped',
  }).output()
  if (!result.success) {
    throw new Error(
      `${executable} failed: ${new TextDecoder().decode(result.stderr).trim()}`,
    )
  }
}

/**
 * Materialize a checksum-pinned layout placement as independent regular
 * bytes. The legacy manifest field is named `links`, but these cross-tool
 * libclang placements must never become symlinks: native admission verifies
 * receipt-bound identities with lstat and rejects escaping links. The
 * descriptor remains unchanged; only its realization is copied.
 */
export async function materializeLayoutCopies(
  output: string,
  placements: readonly LayoutPlacement[],
): Promise<void> {
  for (const placement of placements) {
    const sourceRelative = safeRelative(
      placement.source,
      'layout placement source',
    )
    const destinationRelative = safeRelative(
      placement.destination,
      'layout placement destination',
    )
    if (!SHA256.test(placement.sha256)) {
      throw new Error(
        `layout placement has invalid digest: ${destinationRelative}`,
      )
    }
    const source = `${output}/${sourceRelative}`
    const destination = `${output}/${destinationRelative}`
    await regularFile(source, `layout placement source ${sourceRelative}`)
    if (await sha256(source) !== placement.sha256) {
      throw new Error(
        `layout placement source identity mismatch: ${sourceRelative}`,
      )
    }
    await Deno.mkdir(destination.slice(0, destination.lastIndexOf('/')), {
      recursive: true,
    })
    if (await Deno.lstat(destination).catch(() => undefined)) {
      throw new Error(
        `layout placement destination already exists: ${destinationRelative}`,
      )
    }
    await Deno.copyFile(source, destination)
    await regularFile(
      destination,
      `layout placement destination ${destinationRelative}`,
    )
    if (await sha256(destination) !== placement.sha256) {
      throw new Error(
        `layout placement destination identity mismatch: ${destinationRelative}`,
      )
    }
  }
}

export function expandEnvironment(value: string, output: string): string {
  const [, name, ...rest] = value.split('/')
  // Pin descriptors use `@tool/name/.` for a tool root. Normalize that
  // spelling while preserving the checked descriptor contract: native
  // admission compares receipt environment paths with hash-bound identities
  // byte-for-byte, so an otherwise harmless `/.` would make a fresh receipt
  // fail before the native probe begins.
  const path = safeRelative(
    posix.normalize(rest.join('/')),
    'tools environment path',
  )
  return path === '.' ? `${output}/${name}` : `${output}/${name}/${path}`
}

async function sha256Bytes(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    bytes.slice().buffer,
  )
  return [...new Uint8Array(digest)].map((byte) =>
    byte.toString(16).padStart(2, '0')
  ).join('')
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>
    return `{${
      Object.keys(record).sort().map((key) =>
        `${JSON.stringify(key)}:${stableJson(record[key])}`
      ).join(',')
    }}`
  }
  return JSON.stringify(value)
}

function targetToolDescriptor(
  targetPins: TargetToolSet,
): Record<string, unknown> {
  return {
    tools: targetPins.tools.map((tool) => ({
      name: tool.name,
      version: tool.version,
      url: tool.url,
      sha256: tool.sha256,
      format: tool.format,
      identities: tool.identities,
      installed_identities: tool.installed_identities ?? [],
      ...(tool.include_members
        ? { include_members: tool.include_members }
        : {}),
    })),
    environment: targetPins.environment,
    layout: targetPins.layout,
  }
}

function targetDescriptor(
  target: string,
  targetPins: TargetPins,
): Record<string, unknown> {
  return {
    schema_version: 1,
    kind: 'slv-native-target-tool-pins',
    target,
    ...targetToolDescriptor(targetPins),
    ...(targetPins.execution
      ? { execution: targetToolDescriptor(targetPins.execution) }
      : {}),
  }
}

export function canonicalTargetDescriptorBytes(
  value: unknown,
  target: string,
): Uint8Array {
  if (!TARGETS.has(target)) throw new Error(`unsupported target: ${target}`)
  const pins = parseToolPins(value)
  const targetPins = pins.targets[target]
  if (!targetPins) throw new Error(`no checksum-pinned tools for ${target}`)
  return new TextEncoder().encode(
    JSON.stringify(targetDescriptor(target, targetPins), null, 2) + '\n',
  )
}

function requireBuildEnvironment(environment: Record<string, string>): void {
  for (
    const required of [
      'RUST_BIN',
      'GN',
      'NINJA',
      'CLANG_BASE_PATH',
      'SLV_LINKER',
      'LIBCLANG_PATH',
      'CHROMIUM_RUST_TOOLCHAIN',
      'DENO_FRONTEND',
    ]
  ) {
    if (!environment[required]) {
      throw new Error(`build tool prerequisites lack ${required}`)
    }
  }
}

export async function prepareTools(args: Args): Promise<void> {
  const target = nonempty(args['--target'], 'target')
  if (!TARGETS.has(target)) throw new Error(`unsupported target: ${target}`)
  const purpose = (args['--purpose'] ?? 'build') as Purpose
  if (purpose !== 'build' && purpose !== 'execution') {
    throw new Error('--purpose must be build or execution')
  }
  const buildHost = nonempty(
    args['--build-host'] ?? target,
    'build host',
  )
  if (!TARGETS.has(buildHost)) {
    throw new Error(`unsupported build host: ${buildHost}`)
  }
  const approvedCross = target === CROSS_BUILD.target &&
    buildHost === CROSS_BUILD.buildHost
  if (buildHost !== target && !approvedCross) {
    throw new Error('only Linux x64 to Linux ARM cross-build is permitted')
  }
  if (purpose === 'execution' && buildHost !== target) {
    throw new Error('execution prerequisites must run on their target host')
  }
  const pinsPath = nonempty(args['--pins'], 'pins path')
  const pins = parseToolPins(JSON.parse(await Deno.readTextFile(pinsPath)))
  const rootTargetPins = pins.targets[target]
  if (!rootTargetPins) {
    throw new Error(`no checksum-pinned tool prerequisite set for ${target}`)
  }
  const targetPins = purpose === 'execution'
    ? rootTargetPins.execution
    : rootTargetPins
  if (!targetPins) {
    throw new Error(`tool pins ${target} lack execution-only prerequisites`)
  }
  if (purpose === 'build') {
    requireBuildEnvironment(targetPins.environment)
    if (approvedCross) {
      for (
        const key of [
          'CROSS_SYSROOT_AMD64',
          'CROSS_SYSROOT_ARM64',
          'CROSS_LINKER',
        ]
      ) {
        if (!targetPins.environment[key]) {
          throw new Error(`cross-build prerequisites lack ${key}`)
        }
      }
    }
  }
  const output = await emptyDirectory(nonempty(args['--out'], 'tools output'))
  const cache = args['--cache']
    ? await Deno.realPath(nonempty(args['--cache'], 'cache path')).catch(
      async () => {
        const path = nonempty(args['--cache'], 'cache path')
        await Deno.mkdir(path, { recursive: true })
        return await Deno.realPath(path)
      },
    )
    : `${output}/.downloads`
  await Deno.mkdir(cache, { recursive: true })
  const offline = args['--offline'] === true
  const archives: Record<
    string,
    { url: string; sha256: string; size: number; included_members?: string[] }
  > = {}
  const identities: Record<string, { path: string; sha256: string }> = {}
  const installations: { tool: string; prefix: string; script: string }[] = []
  for (const tool of targetPins.tools) {
    const suffix = tool.format === 'tar.gz'
      ? '.tar.gz'
      : tool.format === 'tar.xz'
      ? '.tar.xz'
      : '.zip'
    const archive = `${cache}/${tool.name}-${tool.sha256}${suffix}`
    if (
      !await Deno.stat(archive).then((info) => info.isFile).catch(() => false)
    ) {
      if (offline) throw new Error(`offline tool cache misses ${tool.name}`)
      await download(tool.url, archive, tool.redirect_hosts ?? [])
    }
    if (await sha256(archive) !== tool.sha256) {
      throw new Error(`checksum mismatch for ${tool.name}`)
    }
    const destination = `${output}/${tool.name}`
    await Deno.mkdir(destination)
    if (tool.format === 'tar.gz' || tool.format === 'tar.xz') {
      const strip = tool.strip_components ?? 0
      if (!Number.isInteger(strip) || strip < 0) {
        throw new Error(`invalid strip_components for ${tool.name}`)
      }
      const args = [
        tool.format === 'tar.gz' ? '-xzf' : '-xJf',
        archive,
        '-C',
        destination,
        '--no-same-owner',
        '--no-same-permissions',
        `--strip-components=${strip}`,
        ...(tool.include_members ?? []),
      ]
      await command('tar', args, output)
    } else {
      if (tool.strip_components !== undefined && tool.strip_components !== 0) {
        throw new Error(`zip strip_components is unsupported for ${tool.name}`)
      }
      await command('unzip', ['-q', archive, '-d', destination], output)
    }
    archives[tool.name] = {
      url: tool.url,
      sha256: tool.sha256,
      size: (await Deno.stat(archive)).size,
      ...(tool.include_members
        ? { included_members: [...tool.include_members] }
        : {}),
    }
    for (const identity of tool.identities) {
      const path = `${destination}/${identity.path}`
      if (
        !await Deno.stat(path).then((info) => info.isFile).catch(() => false) ||
        await sha256(path) !== identity.sha256
      ) {
        throw new Error(
          `extracted identity mismatch for ${tool.name}/${identity.path}`,
        )
      }
      identities[`${tool.name}:${identity.path}`] = {
        path,
        sha256: identity.sha256,
      }
    }
  }
  for (const tool of targetPins.tools) {
    if (!tool.install || !tool.installed_identities) continue
    const prefix = `${output}/${tool.install.prefix}`
    await Deno.mkdir(prefix, { recursive: true })
    const script = `${output}/${tool.name}/${tool.install.script}`
    await command(
      'sh',
      [script, `--prefix=${prefix}`, '--disable-ldconfig'],
      `${output}/${tool.name}`,
    )
    installations.push({ tool: tool.name, prefix, script })
    for (const identity of tool.installed_identities) {
      const path = `${output}/${identity.path}`
      if (
        !await Deno.stat(path).then((info) => info.isFile).catch(() => false) ||
        await sha256(path) !== identity.sha256
      ) {
        throw new Error(`installed identity mismatch for ${identity.path}`)
      }
      identities[`installed:${identity.path}`] = {
        path,
        sha256: identity.sha256,
      }
    }
  }
  await materializeLayoutCopies(output, targetPins.layout.links)
  for (const marker of targetPins.layout.markers) {
    const path = `${output}/${marker.path}`
    await Deno.mkdir(path.slice(0, path.lastIndexOf('/')), { recursive: true })
    await Deno.writeTextFile(path, marker.content)
  }
  for (const identity of targetPins.layout.post_extract_identities) {
    const path = `${output}/${identity.path}`
    await regularFile(path, `post-extract identity ${identity.path}`)
    if (await sha256(path) !== identity.sha256) {
      throw new Error(`post-extract identity mismatch for ${identity.path}`)
    }
    identities[`layout:${identity.path}`] = { path, sha256: identity.sha256 }
  }
  const environment = Object.fromEntries(
    Object.entries(targetPins.environment).map((
      [key, value],
    ) => [key, expandEnvironment(value, output)]),
  )
  const descriptorBytes = canonicalTargetDescriptorBytes(pins, target)
  const descriptorSha256 = await sha256Bytes(descriptorBytes)
  const descriptorPath = typeof args['--descriptor'] === 'string'
    ? args['--descriptor']
    : undefined
  if (descriptorPath) {
    const existing = await Deno.lstat(descriptorPath).catch(() => undefined)
    if (existing) {
      await regularFile(descriptorPath, 'existing target descriptor')
      if (await sha256(descriptorPath) !== descriptorSha256) {
        throw new Error(
          `target descriptor differs from canonical pins: ${descriptorPath}`,
        )
      }
    } else {
      const parent = descriptorPath.includes('/')
        ? descriptorPath.slice(0, descriptorPath.lastIndexOf('/')) || '.'
        : '.'
      await Deno.mkdir(parent, { recursive: true })
      await Deno.writeFile(descriptorPath, descriptorBytes)
    }
  }
  const receipt = {
    schema_version: 1,
    kind: 'slv-native-toolchain',
    target,
    build_host: buildHost,
    purpose,
    pins: { path: pinsPath, sha256: await sha256(pinsPath) },
    target_descriptor: {
      sha256: descriptorSha256,
      ...(descriptorPath ? { path: descriptorPath } : {}),
    },
    archives,
    installations,
    environment,
    identities,
  }
  await Deno.writeTextFile(
    nonempty(args['--receipt'], 'receipt path'),
    JSON.stringify(receipt, null, 2) + '\n',
  )
}

if (import.meta.main) {
  try {
    await prepareTools(parseArgs(Deno.args))
  } catch (error) {
    console.error(error instanceof Error ? error.message : error)
    Deno.exit(1)
  }
}
