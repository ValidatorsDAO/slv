import { assert, assertEquals, assertMatch } from '@std/assert'
import { join } from '@std/path'

// Integration tests for `slv gateway run`. Each test spawns the CLI as
// a subprocess with an isolated HOME + port so they don't pollute the
// developer's real ~/.slv/gateway/ nor collide with each other. Tests
// interact via HTTP /healthz, the JSON pidfile on disk, and exit codes.
//
// Deno's resource/op sanitizers flag subprocess streams as leaks even
// when we fully manage them, so each test opts out (sanitizeResources
// and sanitizeOps both false). We still cancel streams + await status
// in the shared cleanup helper, so nothing actually leaks at the OS
// level.

const CLI_ENTRY = new URL('../../src/index.ts', import.meta.url).pathname

const pickPort = (): number => 30000 + Math.floor(Math.random() * 10000)

type Proc = {
  child: Deno.ChildProcess
  home: string
  port: number
  stderr: Promise<string> // eagerly-drained stderr text
}

const spawnGateway = async (
  opts: {
    port?: number
    homeSeed?: (home: string) => void | Promise<void>
    envPort?: string // override SLV_GATEWAY_PORT literally (bad-port tests)
  } = {},
): Promise<Proc> => {
  const home = await Deno.makeTempDir({ prefix: 'slv-gw-it-' })
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
  drain(child.stdout).catch(() => {})
  const stderr = drain(child.stderr).catch(() => '')
  return { child, home, port, stderr }
}

const waitForHealthz = async (
  port: number,
  timeoutMs = 10_000,
): Promise<{ ok: boolean; pid: number; port: number; startedAt: string }> => {
  const deadline = Date.now() + timeoutMs
  let lastErr: unknown
  while (Date.now() < deadline) {
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

const cleanup = async (p: Proc) => {
  try {
    p.child.kill('SIGTERM')
  } catch { /* already dead */ }
  await p.child.status.catch(() => {})
  await p.stderr // ensure stderr drain has completed
  await Deno.remove(p.home, { recursive: true }).catch(() => {})
}

// Shared options for every subprocess test: subprocess streams are
// owned by the helper + drained; Deno's sanitizer doesn't know that.
const sub = { sanitizeResources: false, sanitizeOps: false } as const

Deno.test(
  'gateway run: fresh start writes config + pidfile, /healthz works, SIGTERM cleans up',
  sub,
  async () => {
    const p = await spawnGateway()
    try {
      const body = await waitForHealthz(p.port)
      assertEquals(body.ok, true)
      assertEquals(body.port, p.port)
      assert(typeof body.pid === 'number' && body.pid > 0)
      assertMatch(body.startedAt, /^\d{4}-\d{2}-\d{2}T/)

      // Config written with 256-bit token. Note: SLV_GATEWAY_PORT
      // overrides at runtime but does NOT persist — the file stores
      // the default port and env overrides are layered on at load
      // time. So we check port is a valid integer, not the env value.
      const cfg = JSON.parse(
        await Deno.readTextFile(join(p.home, '.slv/gateway/gateway.json')),
      )
      assert(Number.isInteger(cfg.port) && cfg.port > 0 && cfg.port <= 65535)
      assertEquals(cfg.mode, 'local')
      assertMatch(cfg.token, /^[0-9a-f]{64}$/)

      // Pidfile present with matching pid
      const pidRaw = await Deno.readTextFile(
        join(p.home, '.slv/gateway/gateway.pid'),
      )
      const pid = JSON.parse(pidRaw)
      assertEquals(pid.pid, body.pid)
      assertEquals(pid.port, p.port)

      // SIGTERM → graceful shutdown → pidfile removed → exit status is
      // either 0 (clean exit) or signal=SIGTERM (OS reaped us). Both
      // mean our handler did its cleanup job; pidfile absence is the
      // authoritative check.
      p.child.kill('SIGTERM')
      const status = await p.child.status
      assert(
        status.code === 0 || status.signal === 'SIGTERM',
        `unexpected exit: code=${status.code} signal=${status.signal}`,
      )
      const pidExists = await Deno.stat(
        join(p.home, '.slv/gateway/gateway.pid'),
      ).then(() => true).catch(() => false)
      assertEquals(
        pidExists,
        false,
        'pidfile should be removed on graceful exit',
      )
    } finally {
      await cleanup(p)
    }
  },
)

Deno.test(
  'gateway run: bad SLV_GATEWAY_PORT exits EX_CONFIG with targeted message',
  sub,
  async () => {
    const p = await spawnGateway({ envPort: 'abc' })
    try {
      const status = await p.child.status
      const err = await p.stderr
      assertEquals(status.code, 78) // EX_CONFIG
      assertMatch(err, /SLV_GATEWAY_PORT/)
      // Must NOT blame gateway.json — user didn't touch it
      assert(
        !/Fix or delete .*gateway\.json/.test(err),
        `bad env port should not blame gateway.json: ${err}`,
      )
    } finally {
      await cleanup(p)
    }
  },
)

Deno.test(
  'gateway run: second instance on same pidfile rejected with kill hint',
  sub,
  async () => {
    const first = await spawnGateway()
    try {
      await waitForHealthz(first.port)
      const firstPid = first.child.pid

      // Second run with a different HOME but sharing the first's
      // gateway dir (via symlink) — exercises the PIDFILE collision
      // path, not the port-bind path. Uses a different port to isolate.
      const secondPort = pickPort()
      const second = await spawnGateway({
        port: secondPort,
        homeSeed: async (home) => {
          await Deno.mkdir(join(home, '.slv'), { recursive: true })
          await Deno.symlink(
            join(first.home, '.slv/gateway'),
            join(home, '.slv/gateway'),
          )
        },
      })
      try {
        const status = await second.child.status
        const err = await second.stderr
        assertEquals(status.code, 75) // EX_TEMPFAIL
        assertMatch(err, /already running/)
        assertMatch(err, new RegExp(`kill ${firstPid}`))
      } finally {
        await cleanup(second)
      }
    } finally {
      await cleanup(first)
    }
  },
)

Deno.test(
  'gateway run: stale pidfile (dead pid) is auto-replaced',
  sub,
  async () => {
    const p = await spawnGateway({
      homeSeed: async (home) => {
        const dir = join(home, '.slv/gateway')
        await Deno.mkdir(dir, { recursive: true })
        // Seed pidfile with a PID that's definitively dead: spawn a
        // no-op child, wait for it to exit, grab its pid. Within a
        // few ms, nothing else will have recycled that pid.
        const tomb = new Deno.Command('true', {
          stdin: 'null',
          stdout: 'null',
          stderr: 'null',
        }).spawn()
        const deadPid = tomb.pid
        await tomb.status
        await Deno.writeTextFile(
          join(dir, 'gateway.pid'),
          JSON.stringify({
            pid: deadPid,
            startedAt: '1970-01-01T00:00:00Z',
            port: 99999,
          }),
        )
      },
    })
    try {
      const body = await waitForHealthz(p.port)
      assertEquals(body.ok, true)
      // Lock was replaced with our fresh pid
      const pid = JSON.parse(
        await Deno.readTextFile(join(p.home, '.slv/gateway/gateway.pid')),
      )
      assertEquals(pid.pid, body.pid)
      assertEquals(pid.port, p.port)
    } finally {
      await cleanup(p)
    }
  },
)

Deno.test(
  'gateway run: malformed gateway.json exits EX_CONFIG pointing at the file',
  sub,
  async () => {
    const p = await spawnGateway({
      homeSeed: async (home) => {
        const dir = join(home, '.slv/gateway')
        await Deno.mkdir(dir, { recursive: true })
        await Deno.writeTextFile(join(dir, 'gateway.json'), '{partial')
      },
    })
    try {
      const status = await p.child.status
      const err = await p.stderr
      assertEquals(status.code, 78) // EX_CONFIG
      assertMatch(err, /gateway\.json/)
      assertMatch(err, /config is invalid/i)
    } finally {
      await cleanup(p)
    }
  },
)

Deno.test(
  'gateway run: / endpoint identifies service + protocol version',
  sub,
  async () => {
    const p = await spawnGateway()
    try {
      await waitForHealthz(p.port)
      const res = await fetch(`http://127.0.0.1:${p.port}/`)
      const body = await res.json()
      assertEquals(body.service, 'slv-gateway')
      assertEquals(body.version, '1')
    } finally {
      await cleanup(p)
    }
  },
)
