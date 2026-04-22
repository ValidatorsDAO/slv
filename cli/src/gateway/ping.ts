import { colors } from '@cliffy/colors'
import { loadGatewayConfig } from '/src/gateway/config.ts'
import { errToString } from '/lib/errToString.ts'

/**
 * Minimal WebSocket smoke client for `slv gateway ping`. Connects to
 * the local gateway, performs the hello → auth → ping handshake,
 * prints the responses, and exits. Used for:
 *
 *   - post-install verification (is the daemon actually reachable?)
 *   - external healthcheck (monitoring agents can shell out to this
 *     and check the exit code)
 *   - dogfooding on remote VPSes that don't have deno/python/websocat
 *     installed (the slv binary is everything you need)
 */
export const pingAction = async (): Promise<boolean> => {
  let config
  try {
    config = await loadGatewayConfig()
  } catch (err) {
    console.error(
      colors.red(`❌ gateway config not found or invalid: ${errToString(err)}`),
    )
    console.error(
      colors.white(`   Start the gateway first: slv gateway start`),
    )
    return false
  }

  const url = `ws://127.0.0.1:${config.port}/v1/session/ws`
  console.log(colors.gray(`→ connecting ${url}`))

  return new Promise((resolve) => {
    const ws = new WebSocket(url)
    const pending = new Map<
      string,
      (r: { ok: boolean; payload?: unknown; error?: string }) => void
    >()
    let counter = 0
    const call = (method: string, params?: unknown) =>
      new Promise<{ ok: boolean; payload?: unknown; error?: string }>((res) => {
        const id = `p${++counter}`
        pending.set(id, res)
        ws.send(JSON.stringify({ kind: 'req', id, method, params }))
      })
    const timeout = setTimeout(() => {
      console.error(colors.red('❌ ping timed out (5s)'))
      try {
        ws.close()
      } catch { /* ignore */ }
      resolve(false)
    }, 5000)

    ws.onopen = async () => {
      try {
        const hello = await call('gateway.hello')
        if (!hello.ok) {
          throw new Error(`hello: ${hello.error}`)
        }
        const info = hello.payload as { service: string; version: string }
        console.log(
          colors.green(
            `✓ hello (service=${info.service} version=${info.version})`,
          ),
        )

        const auth = await call('gateway.auth', { token: config.token })
        if (!auth.ok) {
          throw new Error(`auth: ${auth.error ?? 'rejected'}`)
        }
        console.log(colors.green(`✓ auth`))

        const ping = await call('gateway.ping')
        if (!ping.ok) {
          throw new Error(`ping: ${ping.error ?? 'rejected'}`)
        }
        console.log(colors.green(`✓ ping`))
        clearTimeout(timeout)
        ws.close()
        resolve(true)
      } catch (err) {
        clearTimeout(timeout)
        console.error(colors.red(`❌ ${errToString(err)}`))
        try {
          ws.close()
        } catch { /* ignore */ }
        resolve(false)
      }
    }

    ws.onmessage = (ev) => {
      try {
        const f = JSON.parse(String(ev.data)) as {
          kind: string
          id?: string
          ok?: boolean
          payload?: unknown
          error?: string
        }
        if (f.kind === 'res' && typeof f.id === 'string') {
          const r = pending.get(f.id)
          if (r) {
            pending.delete(f.id)
            r({ ok: !!f.ok, payload: f.payload, error: f.error })
          }
        }
      } catch { /* ignore malformed — request-response above times out */ }
    }

    ws.onerror = () => {
      clearTimeout(timeout)
      console.error(colors.red(`❌ WebSocket error — gateway not running?`))
      resolve(false)
    }
  })
}
