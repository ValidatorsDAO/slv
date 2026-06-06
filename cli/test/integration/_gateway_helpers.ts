import { join } from '@std/path'

// Shared plumbing for the `slv gateway run` integration tests. Each
// test spawns the CLI as a subprocess with an isolated HOME + port so
// they don't pollute the developer's real ~/.slv/gateway/ nor collide
// with each other. Tests interact via HTTP /healthz, the JSON pidfile
// on disk, the WS endpoint, and exit codes.
//
// Deno's resource/op sanitizers flag subprocess streams as leaks even
// when we fully manage them, so each test opts out (sanitizeResources
// and sanitizeOps both false). We still cancel streams + await status
// in the shared cleanup helper, so nothing actually leaks at the OS
// level.

export const CLI_ENTRY = new URL('../../src/index.ts', import.meta.url).pathname

/**
 * Return an OS-assigned free loopback port. Binding to port 0 lets the
 * kernel pick a port that's actually free right now, then we release it
 * immediately. This avoids the random-port collisions that made these
 * tests flake (an in-use port → bind fail → polling a dead process).
 */
export const pickPort = (): number => {
  const l = Deno.listen({ hostname: '127.0.0.1', port: 0 })
  const { port } = l.addr as Deno.NetAddr
  l.close()
  return port
}

export type Proc = {
  child: Deno.ChildProcess
  home: string
  port: number
  stderr: Promise<string> // eagerly-drained stderr text
}

export type Gw = {
  child: Deno.ChildProcess
  home: string
  port: number
  token: string
  stderr: Promise<string>
}

/** Fully drain a byte stream into a decoded string. */
const drain = async (s: ReadableStream<Uint8Array>): Promise<string> => {
  const chunks: Uint8Array[] = []
  const reader = s.getReader()
  while (true) {
    const { value, done } = await reader.read()
    if (done) break
    if (value) chunks.push(value)
  }
  const total = chunks.reduce((n, c) => n + c.length, 0)
  const out = new Uint8Array(total)
  let o = 0
  for (const c of chunks) {
    out.set(c, o)
    o += c.length
  }
  return new TextDecoder().decode(out)
}

/**
 * Warm the Deno module cache for the CLI entry exactly once per test
 * run. Each `deno run --no-check` subprocess otherwise re-downloads +
 * compiles the whole CLI graph on a cold cache; under the parallel load
 * of many spawns this can push a single cold start past the healthz
 * deadline (the historical source of the flake). `deno cache` populates
 * the shared on-disk cache so every subsequent spawn boots fast.
 */
let cacheWarm: Promise<void> | undefined
const warmCache = (): Promise<void> => {
  if (!cacheWarm) {
    cacheWarm = new Deno.Command(Deno.execPath(), {
      args: ['cache', CLI_ENTRY],
      stdin: 'null',
      stdout: 'null',
      stderr: 'null',
    }).output().then(() => {}).catch(() => {})
  }
  return cacheWarm
}

export const spawnGateway = async (
  opts: {
    port?: number
    homePrefix?: string
    homeSeed?: (home: string) => void | Promise<void>
    envPort?: string // override SLV_GATEWAY_PORT literally (bad-port tests)
  } = {},
): Promise<Proc> => {
  await warmCache()
  const home = await Deno.makeTempDir({
    prefix: opts.homePrefix ?? 'slv-gw-it-',
  })
  if (opts.homeSeed) await opts.homeSeed(home)
  const port = opts.port ?? pickPort()
  const env: Record<string, string> = {
    HOME: home,
    PATH: Deno.env.get('PATH') ?? '/usr/bin:/bin',
    SLV_GATEWAY_PORT: opts.envPort ?? String(port),
  }
  const child = new Deno.Command(Deno.execPath(), {
    args: ['run', '-A', '--no-check', CLI_ENTRY, 'gateway', 'run'],
    env,
    stdin: 'null',
    stdout: 'piped',
    stderr: 'piped',
  }).spawn()
  // Eagerly drain stdout so the subprocess can't block on a full pipe
  // during tests that don't care about it. The stderr future is
  // returned for tests that assert on it.
  drain(child.stdout).catch(() => {})
  const stderr = drain(child.stderr).catch(() => '')
  return { child, home, port, stderr }
}

/**
 * Poll /healthz until the gateway answers, then return the parsed body.
 *
 * Fails fast: if the subprocess exits before /healthz comes up (e.g. a
 * bind failure on a port that raced into use), we throw immediately with
 * the drained stderr included, instead of polling the dead process until
 * the deadline. Default timeout is generous (30s) so a cold subprocess
 * start on a loaded CI runner doesn't flake.
 */
export const waitForHealthz = async (
  proc: Proc,
  timeoutMs = 30_000,
): Promise<{ ok: boolean; pid: number; port: number; startedAt: string }> => {
  const { port } = proc
  let exited: { code: number; signal: Deno.Signal | null } | undefined
  proc.child.status.then((s) => {
    exited = s
  }).catch(() => {})

  const deadline = Date.now() + timeoutMs
  let lastErr: unknown
  while (Date.now() < deadline) {
    if (exited) {
      const err = await proc.stderr.catch(() => '')
      throw new Error(
        `gateway process exited before /healthz on :${port} ` +
          `(code=${exited.code} signal=${exited.signal})\n--- stderr ---\n${err}`,
      )
    }
    try {
      const res = await fetch(`http://127.0.0.1:${port}/healthz`)
      if (res.ok) return await res.json()
      await res.body?.cancel()
    } catch (err) {
      lastErr = err
    }
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error(
    `gateway did not become healthy on :${port} within ${timeoutMs}ms${
      lastErr ? ` (last: ${lastErr})` : ''
    }`,
  )
}

export const cleanup = async (p: Proc): Promise<void> => {
  try {
    p.child.kill('SIGTERM')
  } catch { /* already dead */ }
  await p.child.status.catch(() => {})
  await p.stderr // ensure stderr drain has completed
  await Deno.remove(p.home, { recursive: true }).catch(() => {})
}

/** Alias kept for the ws/session/web_ui tests that say `stopGateway`. */
export const stopGateway = cleanup

/**
 * Convenience for the WS/session/UI tests: spawn, wait for healthz, then
 * read the token from the config file written by the first run.
 */
export const startGateway = async (
  opts: {
    port?: number
    homePrefix?: string
  } = {},
): Promise<Gw> => {
  const proc = await spawnGateway(opts)
  await waitForHealthz(proc)
  const cfg = JSON.parse(
    await Deno.readTextFile(join(proc.home, '.slv/gateway/gateway.json')),
  ) as { token: string }
  return {
    child: proc.child,
    home: proc.home,
    port: proc.port,
    token: cfg.token,
    stderr: proc.stderr,
  }
}

// Shared options for every subprocess test: subprocess streams are
// owned by the helper + drained; Deno's sanitizer doesn't know that.
export const sub = { sanitizeResources: false, sanitizeOps: false } as const
