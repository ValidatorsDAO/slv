// WebSocket entry point for the gateway.  Implements:
//
//   - `transactionSubscribe` / `transactionUnsubscribe` (Helius Enhanced WS
//     compat) — bridged to upstream Yellowstone gRPC.
//   - All standard Solana JSON-RPC pubsub methods (accountSubscribe,
//     logsSubscribe, programSubscribe, signatureSubscribe, slotSubscribe,
//     blockSubscribe, voteSubscribe, …) — forwarded to upstream Solana
//     pubsub WS untouched.
//
// Subscription IDs:
//   - Helius/local subscriptions are assigned IDs ≥ 1_000_000_000.
//   - Upstream pubsub subscriptions keep whatever ID upstream returned.
// Clients see one merged ID space; the unsubscribe handler dispatches
// based on which side owns the ID.

import { upgradeWebSocket } from '@hono/hono/deno'
import {
  err,
  ERROR_CODES,
  type JsonRpcRequest,
  type JsonRpcResponse,
  ok,
  validate,
} from '../jsonrpc.ts'
import {
  type HeliusOpts,
  type HeliusTxFilter,
  YellowstoneBridge,
} from '../lib/yellowstone-bridge.ts'
import { PubsubForward } from '../lib/pubsub-forward.ts'
import { SlotBridge } from '../lib/slot-bridge.ts'

export type WsConfig = {
  yellowstoneEndpoint: string // host:port — passed straight to gRPC client
  pubsubUrl: string // ws://… upstream Solana pubsub
  // Optional dedicated source for slotSubscribe.  When set, slotSubscribe
  // notifications come from this Yellowstone-gRPC endpoint (typically a
  // shred-bridge that fires first-shred-of-next-slot ~5–8 ms earlier than
  // validator-replay-complete).  When unset, slotSubscribe falls through
  // to the standard pubsub forward like every other pubsub method.
  slotBridgeEndpoint?: string
}

const HELIUS_ID_BASE = 1_000_000_000

const STANDARD_PUBSUB_METHODS = new Set([
  'accountSubscribe',
  'accountUnsubscribe',
  'logsSubscribe',
  'logsUnsubscribe',
  'programSubscribe',
  'programUnsubscribe',
  'signatureSubscribe',
  'signatureUnsubscribe',
  // slotSubscribe / slotUnsubscribe are intercepted below when a
  // slotBridge endpoint is configured; otherwise they fall through here.
  'slotsUpdatesSubscribe',
  'slotsUpdatesUnsubscribe',
  'blockSubscribe',
  'blockUnsubscribe',
  'voteSubscribe',
  'voteUnsubscribe',
  'rootSubscribe',
  'rootUnsubscribe',
])

export function buildWsHandler(cfg: WsConfig) {
  const bridge = new YellowstoneBridge(cfg.yellowstoneEndpoint)
  // Process-wide single subscription, fanned out to all WS clients that
  // call slotSubscribe.  Null when no override endpoint is configured —
  // in that case slotSubscribe falls through to STANDARD_PUBSUB_METHODS
  // and is forwarded to richat WS untouched.
  const slotBridge = cfg.slotBridgeEndpoint
    ? new SlotBridge(cfg.slotBridgeEndpoint)
    : null

  return upgradeWebSocket(() => {
    // Per-connection state.
    const localSubs = new Map<number, { cancel: () => void }>()
    let localSubCounter = HELIUS_ID_BASE
    let pubsub: PubsubForward | null = null
    let socket: WebSocket | null = null

    const send = (msg: unknown) => {
      try {
        socket?.send(JSON.stringify(msg))
      } catch { /* connection closed */ }
    }

    const ensurePubsub = (): PubsubForward => {
      if (pubsub) return pubsub
      pubsub = new PubsubForward({
        upstreamUrl: cfg.pubsubUrl,
        onUpstreamMessage: (raw) => {
          // Forward upstream message verbatim to client.
          try {
            socket?.send(raw)
          } catch { /* closed */ }
        },
        onUpstreamClose: () => {
          // upstream went away — leave to client to retry
        },
        onUpstreamError: (e) => {
          console.error(JSON.stringify({
            ts: new Date().toISOString(),
            msg: 'pubsub_upstream_error',
            error: String(e),
          }))
        },
      })
      return pubsub
    }

    const handleHeliusTransactionSubscribe = async (
      req: JsonRpcRequest,
    ): Promise<JsonRpcResponse> => {
      try {
        const params = (req.params as unknown[]) ?? []
        const filter = (params[0] as HeliusTxFilter) ?? {}
        const opts = (params[1] as HeliusOpts) ?? {}
        const subId = ++localSubCounter

        const handle = await bridge.subscribeTransactions(
          filter,
          opts,
          (notification) => {
            send({
              jsonrpc: '2.0',
              method: 'transactionNotification',
              params: { subscription: subId, result: notification },
            })
          },
          (e) => {
            console.error(JSON.stringify({
              ts: new Date().toISOString(),
              msg: 'yellowstone_stream_error',
              sub: subId,
              error: String(e),
            }))
          },
        )

        localSubs.set(subId, handle)
        return ok(req.id ?? null, subId)
      } catch (e) {
        return err(req.id ?? null, ERROR_CODES.INTERNAL_ERROR, (e as Error).message)
      }
    }

    const handleHeliusTransactionUnsubscribe = (
      req: JsonRpcRequest,
    ): JsonRpcResponse => {
      const params = (req.params as unknown[]) ?? []
      const subId = Number(params[0])
      if (!Number.isFinite(subId)) {
        return err(req.id ?? null, ERROR_CODES.INVALID_PARAMS, 'subscription id required')
      }
      const handle = localSubs.get(subId)
      if (!handle) {
        // Could be an upstream pubsub id — forward through if so.
        if (subId < HELIUS_ID_BASE && pubsub) {
          // Replay raw frame upstream.
          ensurePubsub().send(JSON.stringify(req))
          // Don't reply locally — upstream will.
          return ok(req.id ?? null, false)
        }
        return ok(req.id ?? null, false)
      }
      handle.cancel()
      localSubs.delete(subId)
      return ok(req.id ?? null, true)
    }

    return {
      onOpen(_evt, ws) {
        socket = ws.raw as WebSocket
      },
      async onMessage(evt, ws) {
        socket = ws.raw as WebSocket
        const text = typeof evt.data === 'string'
          ? evt.data
          : new TextDecoder().decode(evt.data as ArrayBuffer)
        let body: unknown
        try {
          body = JSON.parse(text)
        } catch {
          send(err(null, ERROR_CODES.PARSE_ERROR, 'invalid JSON'))
          return
        }
        const req = validate(body)
        if (!req) {
          send(err(null, ERROR_CODES.INVALID_REQUEST, 'invalid JSON-RPC request'))
          return
        }

        switch (req.method) {
          case 'transactionSubscribe': {
            const resp = await handleHeliusTransactionSubscribe(req)
            send(resp)
            return
          }
          case 'transactionUnsubscribe': {
            send(handleHeliusTransactionUnsubscribe(req))
            return
          }
          case 'slotSubscribe': {
            if (slotBridge) {
              const subId = ++localSubCounter
              const handle = slotBridge.subscribe((u) => {
                send({
                  jsonrpc: '2.0',
                  method: 'slotNotification',
                  params: { result: u, subscription: subId },
                })
              })
              localSubs.set(subId, handle)
              send(ok(req.id ?? null, subId))
              return
            }
            // Fall through to pubsub forward.
            ensurePubsub().send(text)
            return
          }
          case 'slotUnsubscribe': {
            if (slotBridge) {
              const params = (req.params as unknown[]) ?? []
              const subId = Number(params[0])
              const handle = Number.isFinite(subId) ? localSubs.get(subId) : undefined
              if (handle) {
                handle.cancel()
                localSubs.delete(subId)
                send(ok(req.id ?? null, true))
                return
              }
              // Unknown id — could be an upstream pubsub id, forward through.
              if (subId < HELIUS_ID_BASE) {
                ensurePubsub().send(text)
                return
              }
              send(ok(req.id ?? null, false))
              return
            }
            ensurePubsub().send(text)
            return
          }
          default: {
            if (STANDARD_PUBSUB_METHODS.has(req.method)) {
              ensurePubsub().send(text)
              return
            }
            send(err(req.id ?? null, ERROR_CODES.METHOD_NOT_FOUND, `unsupported WS method: ${req.method}`))
          }
        }
      },
      onClose() {
        for (const h of localSubs.values()) h.cancel()
        localSubs.clear()
        pubsub?.close()
        pubsub = null
        socket = null
      },
      onError(_e) {
        for (const h of localSubs.values()) h.cancel()
        localSubs.clear()
        pubsub?.close()
        pubsub = null
        socket = null
      },
    }
  })
}
