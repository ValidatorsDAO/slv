export type RpcCheckResult = {
  ok: boolean
  transport: 'http' | 'ws'
  summary: string
  details?: string[]
}

const DEFAULT_TIMEOUT_MS = 10_000
const SENSITIVE_QUERY_KEYS = [
  'api-key',
  'apikey',
  'token',
  'key',
  'auth',
  'access_token',
]

function isSensitiveQueryKey(key: string): boolean {
  const normalized = key.toLowerCase()
  return SENSITIVE_QUERY_KEYS.some((candidate) =>
    normalized.includes(candidate)
  )
}

export function sanitizeEndpointForDisplay(endpoint: string): string {
  try {
    const url = new URL(endpoint)
    for (const key of new Set(url.searchParams.keys())) {
      if (isSensitiveQueryKey(key)) {
        url.searchParams.set(key, '***')
      }
    }
    return url.toString()
  } catch {
    return endpoint
  }
}

function getEndpointProtocol(endpoint: string): 'http' | 'ws' {
  let url: URL
  try {
    url = new URL(endpoint)
  } catch {
    throw new Error('Invalid URL. Use http(s):// or ws(s)://')
  }

  switch (url.protocol) {
    case 'http:':
    case 'https:':
      return 'http'
    case 'ws:':
    case 'wss:':
      return 'ws'
    default:
      throw new Error('Unsupported protocol. Use http(s):// or ws(s)://')
  }
}

async function readJsonRpcResponse(response: Response): Promise<unknown> {
  const text = await response.text()
  if (!text.trim()) {
    throw new Error(`HTTP ${response.status} with empty response body`)
  }

  try {
    return JSON.parse(text)
  } catch {
    throw new Error(
      `HTTP ${response.status} returned invalid JSON-RPC response`,
    )
  }
}

function describeJsonRpcError(error: unknown): string {
  if (!error || typeof error !== 'object') {
    return 'Remote endpoint returned an unknown JSON-RPC error'
  }

  const record = error as { code?: unknown; message?: unknown }
  const code =
    typeof record.code === 'number' || typeof record.code === 'string'
      ? String(record.code)
      : 'unknown'
  const message = typeof record.message === 'string'
    ? record.message
    : 'Unknown error'
  return `JSON-RPC error ${code}: ${message}`
}

async function checkHttpRpc(
  endpoint: string,
  timeoutMs: number,
): Promise<RpcCheckResult> {
  let response: Response
  try {
    response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'getBlockHeight',
        params: [],
      }),
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (message.toLowerCase().includes('timed out')) {
      return {
        ok: false,
        transport: 'http',
        summary: `timeout after ${Math.round(timeoutMs / 1000)}s`,
      }
    }

    return {
      ok: false,
      transport: 'http',
      summary: `request failed: ${message}`,
    }
  }

  let payload: unknown
  try {
    payload = await readJsonRpcResponse(response)
  } catch (error) {
    return {
      ok: false,
      transport: 'http',
      summary: error instanceof Error ? error.message : String(error),
    }
  }

  const record = payload as { result?: unknown; error?: unknown }
  if (record.error) {
    return {
      ok: false,
      transport: 'http',
      summary: describeJsonRpcError(record.error),
    }
  }

  if (typeof record.result === 'number') {
    return {
      ok: true,
      transport: 'http',
      summary: `HTTP ${response.status}, block height ${record.result}`,
    }
  }

  return {
    ok: false,
    transport: 'http',
    summary:
      `HTTP ${response.status}, missing block height in JSON-RPC response`,
  }
}

function formatWsError(event: Event | string): string {
  if (typeof event === 'string') return event
  if (
    'message' in event && typeof event.message === 'string' && event.message
  ) {
    return event.message
  }
  return 'websocket connection failed'
}

async function checkWsRpc(
  endpoint: string,
  timeoutMs: number,
): Promise<RpcCheckResult> {
  return await new Promise((resolve) => {
    const ws = new WebSocket(endpoint)
    let done = false

    const finish = (result: RpcCheckResult) => {
      if (done) return
      done = true
      clearTimeout(timer)
      try {
        if (
          ws.readyState === WebSocket.OPEN ||
          ws.readyState === WebSocket.CONNECTING
        ) {
          ws.close()
        }
      } catch {
        // ignore close errors
      }
      resolve(result)
    }

    const timer = setTimeout(() => {
      finish({
        ok: false,
        transport: 'ws',
        summary: `timeout after ${Math.round(timeoutMs / 1000)}s`,
      })
    }, timeoutMs)

    ws.onerror = (event) => {
      finish({
        ok: false,
        transport: 'ws',
        summary: formatWsError(event),
      })
    }

    ws.onopen = () => {
      try {
        ws.send(JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'slotSubscribe',
        }))
      } catch (error) {
        finish({
          ok: false,
          transport: 'ws',
          summary: error instanceof Error ? error.message : String(error),
        })
      }
    }

    ws.onmessage = (event) => {
      let payload: unknown
      try {
        payload = JSON.parse(String(event.data))
      } catch {
        finish({
          ok: false,
          transport: 'ws',
          summary: 'websocket returned invalid JSON-RPC response',
        })
        return
      }

      const record = payload as {
        result?: unknown
        error?: unknown
        method?: unknown
        params?: unknown
      }
      if (record.error) {
        finish({
          ok: false,
          transport: 'ws',
          summary: describeJsonRpcError(record.error),
        })
        return
      }

      if (
        typeof record.result === 'number' || typeof record.result === 'string'
      ) {
        finish({
          ok: true,
          transport: 'ws',
          summary: `subscription accepted, id ${record.result}`,
        })
        return
      }

      if (record.method === 'slotNotification') {
        finish({
          ok: true,
          transport: 'ws',
          summary: 'subscription accepted, slot notification received',
        })
        return
      }

      finish({
        ok: false,
        transport: 'ws',
        summary: 'websocket returned unexpected JSON-RPC response',
      })
    }

    ws.onclose = (event) => {
      if (done) return
      const reason = event.reason ? `: ${event.reason}` : ''
      finish({
        ok: false,
        transport: 'ws',
        summary:
          `websocket closed before subscription completed (code ${event.code}${reason})`,
      })
    }
  })
}

export async function checkRpcEndpoint(
  endpoint: string,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<RpcCheckResult> {
  const trimmed = endpoint.trim()
  const protocol = getEndpointProtocol(trimmed)
  if (protocol === 'http') {
    return await checkHttpRpc(trimmed, timeoutMs)
  }

  return await checkWsRpc(trimmed, timeoutMs)
}
