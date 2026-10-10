// Shared helpers for the credential tests. Not collected as a test file (the
// leading underscore keeps it out of `deno test`).
//
// Every value below is made up for the tests; none of them is a real
// credential. They only have to match the shapes the CLI checks locally.

import { stringify } from '@std/yaml'

export const API_KEY = '3f1c2b4a-5d6e-4f70-8a91-b2c3d4e5f607'
// Three base64url segments joined by dots: the shape of a JWT, nothing more.
export const ACCESS_TOKEN = 'test-header.test-access-token-1.test-signature'
export const REFRESH_TOKEN = 'test-header.test-refresh-token-1.test-signature'
export const NEW_ACCESS_TOKEN = 'test-header.test-access-token-2.test-signature'
export const NEW_REFRESH_TOKEN =
  'test-header.test-refresh-token-2.test-signature'
// `erpcsk_` + 16 characters from a-z and 2-7
export const STORAGE_KEY_ID = 'erpcsk_abcdefghij234567'
// 43 base64url characters
export const STORAGE_SECRET = `${'Q9_x-Z'.repeat(7)}a`

/** Unix seconds: an expiry long past, and one far in the future. */
export const EXPIRED = 1
export const FAR_FUTURE = 4102444800

/** The `slv:` keys of a saved login whose access token expires at `expiresAt`. */
export const loggedIn = (
  expiresAt: number,
  tokens: { access?: string; refresh?: string } = {},
): Record<string, unknown> => ({
  access_token: tokens.access ?? ACCESS_TOKEN,
  refresh_token: tokens.refresh ?? REFRESH_TOKEN,
  access_token_expires_at: expiresAt,
})

export const AUTH_TOKEN_URL = 'https://auth-api.erpc.global/oauth/token'

export const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status })

/**
 * Run `fn` with HOME pointing at a fresh directory. When `yml` is given it is
 * written to `~/.slv/api.yml` first. HOME and SUDO_USER are restored and the
 * directory is removed afterwards.
 */
export const withHome = async (
  yml: Record<string, unknown> | null,
  fn: (home: string) => Promise<void>,
): Promise<void> => {
  const home = await Deno.makeTempDir({ prefix: 'slv-home-' })
  const prevHome = Deno.env.get('HOME')
  const prevSudo = Deno.env.get('SUDO_USER')
  try {
    await Deno.mkdir(`${home}/.slv`, { recursive: true })
    if (yml) {
      await Deno.writeTextFile(`${home}/.slv/api.yml`, stringify(yml))
    }
    Deno.env.set('HOME', home)
    Deno.env.delete('SUDO_USER')
    await fn(home)
  } finally {
    if (prevHome === undefined) Deno.env.delete('HOME')
    else Deno.env.set('HOME', prevHome)
    if (prevSudo !== undefined) Deno.env.set('SUDO_USER', prevSudo)
    await Deno.remove(home, { recursive: true })
  }
}

export type RecordedRequest = {
  url: string
  method: string
  authorization: string | null
  /** The body when it was sent as text or form fields; null otherwise. */
  body: string | null
}

/**
 * Replace `globalThis.fetch` for the duration of `fn`. Every call is recorded
 * and answered by `respond`. A streamed body (a file upload) is read to the
 * end so the file behind it is closed.
 */
export const withFetch = async (
  respond: (url: string, init?: RequestInit) => Response | Promise<Response>,
  fn: (requests: RecordedRequest[]) => Promise<void>,
): Promise<void> => {
  const original = globalThis.fetch
  const requests: RecordedRequest[] = []
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const headers = new Headers(init?.headers)
    const body = init?.body
    if (body instanceof ReadableStream) await new Response(body).arrayBuffer()
    requests.push({
      url,
      method: init?.method ?? 'GET',
      authorization: headers.get('Authorization'),
      body: typeof body === 'string' || body instanceof URLSearchParams
        ? String(body)
        : null,
    })
    return await respond(url, init)
  }) as typeof fetch
  try {
    await fn(requests)
  } finally {
    globalThis.fetch = original
  }
}

export type CommandCall = {
  command: string
  args: string[]
  env: Record<string, string>
}

type CommandReply = { success?: boolean; stdout?: string }

/**
 * Replace `Deno.Command` so no process starts. `handler` sees every call and
 * answers it (or throws to make the call fail the test).
 */
export const withCommandStub = async (
  handler: (call: CommandCall) => CommandReply,
  fn: (calls: CommandCall[]) => Promise<void>,
): Promise<void> => {
  const original = Deno.Command
  const calls: CommandCall[] = []
  const reply = (call: CommandCall) => {
    calls.push(call)
    const r = handler(call)
    return {
      success: r.success ?? true,
      code: r.success === false ? 1 : 0,
      stdout: new TextEncoder().encode(r.stdout ?? ''),
      stderr: new Uint8Array(),
    }
  }
  class FakeCommand {
    #call: CommandCall
    constructor(command: string | URL, options?: Deno.CommandOptions) {
      this.#call = {
        command: String(command),
        args: [...(options?.args ?? [])],
        env: { ...(options?.env ?? {}) },
      }
    }
    output() {
      return Promise.resolve(reply(this.#call))
    }
    outputSync() {
      return reply(this.#call)
    }
  }
  ;(Deno as unknown as { Command: unknown }).Command = FakeCommand
  try {
    await fn(calls)
  } finally {
    ;(Deno as unknown as { Command: unknown }).Command = original
  }
}

class ExitSignal extends Error {
  constructor(public code: number) {
    super(`exit(${code})`)
  }
}

export type Outcome = {
  /** Exit code the command asked for, or null when it did not ask for one. */
  exit: number | null
  /** Everything written through console.log / info / warn / error. */
  output: string
  /** An exception that was not a Deno.exit call. */
  error?: unknown
}

/**
 * Run a command action with `Deno.exit` turned into an exception and the
 * console captured. A non-zero `Deno.exitCode` counts as an exit request too.
 */
export const runCaptured = async (
  fn: () => Promise<unknown>,
): Promise<Outcome> => {
  const lines: string[] = []
  const originals = {
    exit: Deno.exit,
    log: console.log,
    info: console.info,
    warn: console.warn,
    error: console.error,
  }
  const sink = (...args: unknown[]) => {
    lines.push(args.map(String).join(' '))
  }
  console.log = sink
  console.info = sink
  console.warn = sink
  console.error = sink
  ;(Deno as unknown as { exit: unknown }).exit = (code?: number) => {
    throw new ExitSignal(code ?? 0)
  }
  Deno.exitCode = 0
  let exit: number | null = null
  let error: unknown
  try {
    await fn()
  } catch (e) {
    if (e instanceof ExitSignal) exit = e.code
    else error = e
  } finally {
    ;(Deno as unknown as { exit: unknown }).exit = originals.exit
    console.log = originals.log
    console.info = originals.info
    console.warn = originals.warn
    console.error = originals.error
  }
  if (exit === null && Deno.exitCode !== 0) exit = Deno.exitCode
  Deno.exitCode = 0
  return { exit, output: lines.join('\n'), error }
}
