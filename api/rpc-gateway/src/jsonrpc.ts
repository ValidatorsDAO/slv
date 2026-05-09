// JSON-RPC 2.0 minimal types + helpers.

export type JsonRpcId = string | number | null

export type JsonRpcRequest = {
  jsonrpc: '2.0'
  method: string
  params?: unknown
  id?: JsonRpcId
}

export type JsonRpcSuccess = {
  jsonrpc: '2.0'
  result: unknown
  id: JsonRpcId
}

export type JsonRpcError = {
  jsonrpc: '2.0'
  error: { code: number; message: string; data?: unknown }
  id: JsonRpcId
}

export type JsonRpcResponse = JsonRpcSuccess | JsonRpcError

export const ERROR_CODES = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
  // server-defined (-32000 to -32099)
  UPSTREAM_ERROR: -32000,
} as const

export function ok(id: JsonRpcId, result: unknown): JsonRpcSuccess {
  return { jsonrpc: '2.0', id, result }
}

export function err(
  id: JsonRpcId,
  code: number,
  message: string,
  data?: unknown,
): JsonRpcError {
  return { jsonrpc: '2.0', id, error: { code, message, data } }
}

/** Validate the shape of an incoming request. */
export function validate(body: unknown): JsonRpcRequest | null {
  if (
    typeof body !== 'object' ||
    body === null ||
    Array.isArray(body)
  ) return null
  const obj = body as Record<string, unknown>
  if (obj.jsonrpc !== '2.0') return null
  if (typeof obj.method !== 'string') return null
  return body as JsonRpcRequest
}
