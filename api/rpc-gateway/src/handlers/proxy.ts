// Forwards standard Solana JSON-RPC methods to the upstream of1
// (yellowstone-faithful) endpoint.

import { err, ERROR_CODES, ok, type JsonRpcRequest, type JsonRpcResponse } from '../jsonrpc.ts'

export type ProxyConfig = {
  upstream: string
  timeoutMs?: number
}

export class StandardProxy {
  private url: URL
  private timeoutMs: number

  constructor(cfg: ProxyConfig) {
    this.url = new URL(cfg.upstream)
    this.timeoutMs = cfg.timeoutMs ?? 60_000
  }

  async handle(req: JsonRpcRequest): Promise<JsonRpcResponse> {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs)
    try {
      const res = await fetch(this.url.toString(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(req),
        signal: ctrl.signal,
      })
      if (!res.ok) {
        return err(
          req.id ?? null,
          ERROR_CODES.UPSTREAM_ERROR,
          `upstream returned HTTP ${res.status}`,
        )
      }
      const body = await res.json()
      // Upstream already returns a JsonRpcResponse — pass through.
      if (
        typeof body === 'object' &&
        body !== null &&
        'jsonrpc' in body
      ) {
        return body as JsonRpcResponse
      }
      // Unexpected: wrap as success.
      return ok(req.id ?? null, body)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return err(req.id ?? null, ERROR_CODES.UPSTREAM_ERROR, msg)
    } finally {
      clearTimeout(timer)
    }
  }
}
