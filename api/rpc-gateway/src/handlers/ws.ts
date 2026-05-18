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
import { SlotMultiplex } from '../lib/slot-multiplex.ts'
import { SlotFirstShredBridge } from '../lib/slot-first-shred.ts'
import { SlotFirstShredMultiplex } from '../lib/slot-first-shred-multiplex.ts'

export type WsConfig = {
  yellowstoneEndpoint: string // host:port — passed straight to gRPC client
  pubsubUrl: string // ws://… upstream Solana pubsub (richat)
  // Optional dedicated source for slotSubscribe.  Two flavours:
  //
  // - `slotFirstShredMultiplexUrls` (ws://… list): combines the
  //   `firstShredReceived` semantic with N-URL first-arrival-wins
  //   multiplexing.  Best single knob for slot latency: stack the
  //   early-signal of `slotFirstShredUrl` on top of the jitter-
  //   smoothing of `slotMultiplexUrls`.  Same trade-off as
  //   `slotFirstShredUrl` (= bank not yet frozen at notify time).
  //
  // - `slotFirstShredUrl` (ws://…): subscribe to `slotsUpdatesSubscribe`
  //   on this Solana-pubsub-compat endpoint and emit `firstShredReceived`
  //   events as `slotNotification`.  This matches what Helius beta does
  //   internally and was the only configuration in our 2026-05-17
  //   measurements that closed the Helius latency gap meaningfully
  //   (Helius avg lead +5.6 ms → +2.5 ms; ERPC win share 6.7 % → 23 %).
  //   Trade-off: clients see slot ticks ~5 ms earlier but the bank for
  //   that slot does not yet exist — downstream `getAccountInfo` may
  //   race the validator's own replay.  Off by default; opt in when
  //   slot freshness > consistency.
  //
  // - `slotMultiplexUrls` (ws://… list): subscribe to slotSubscribe on
  //   EACH url, dedupe by slot number, and deliver the first-arrival.
  //   Best latency in our measurements: native pubsub + richat together
  //   roughly halve the win rate where Helius beats us.  Use this when
  //   you have multiple slot sources with different jitter profiles.
  //
  // - `slotPubsubUrl` (ws://…): forward `slotSubscribe` / `slotUnsubscribe`
  //   to this Solana-pubsub-compat WebSocket (typically the validator's
  //   own pubsub on `:rpc-port + 1`).  Empirically ~3 ms faster than
  //   richat for slot notifications on this codebase as of 2026-05.
  //
  // - `slotBridgeEndpoint` (Yellowstone-gRPC): fan slot events out from
  //   a shared gRPC stream.  Intended for shred-derived slot sources.
  //   Note: jito-shredstream-derived sources have been measured ~400 ms
  //   SLOWER than richat — the bridge code itself is fine but the
  //   upstream shred feed lags turbine on a co-located validator.
  //
  // Priority: `slotFirstShredMultiplexUrls` > `slotFirstShredUrl` >
  // `slotMultiplexUrls` > `slotPubsubUrl` > `slotBridgeEndpoint` >
  // falls through to the standard pubsub forward (= same as every
  // other pubsub method).
  slotFirstShredMultiplexUrls?: string[]
  slotFirstShredUrl?: string
  slotMultiplexUrls?: string[]
  slotPubsubUrl?: string
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
  // Process-wide singletons for slot sources.  Null when not configured.
  const slotFirstShredMultiplex =
    cfg.slotFirstShredMultiplexUrls && cfg.slotFirstShredMultiplexUrls.length > 0
      ? new SlotFirstShredMultiplex(cfg.slotFirstShredMultiplexUrls)
      : null
  const slotFirstShred = cfg.slotFirstShredUrl
    ? new SlotFirstShredBridge(cfg.slotFirstShredUrl)
    : null
  const slotMultiplex = cfg.slotMultiplexUrls && cfg.slotMultiplexUrls.length > 0
    ? new SlotMultiplex(cfg.slotMultiplexUrls)
    : null
  const slotBridge = cfg.slotBridgeEndpoint ? new SlotBridge(cfg.slotBridgeEndpoint) : null

  return upgradeWebSocket(() => {
    // Per-connection state.
    const localSubs = new Map<number, { cancel: () => void }>()
    let localSubCounter = HELIUS_ID_BASE
    let pubsub: PubsubForward | null = null
    // Separate forward for slotSubscribe when `slotPubsubUrl` is
    // configured.  Each WS client gets its own upstream connection so
    // subscription IDs from upstream stay namespaced per-client.
    let slotPubsub: PubsubForward | null = null
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

    const ensureSlotPubsub = (): PubsubForward | null => {
      if (!cfg.slotPubsubUrl) return null
      if (slotPubsub) return slotPubsub
      slotPubsub = new PubsubForward({
        upstreamUrl: cfg.slotPubsubUrl,
        onUpstreamMessage: (raw) => {
          try {
            socket?.send(raw)
          } catch { /* closed */ }
        },
        onUpstreamClose: () => {},
        onUpstreamError: (e) => {
          console.error(JSON.stringify({
            ts: new Date().toISOString(),
            msg: 'slot_pubsub_upstream_error',
            error: String(e),
          }))
        },
      })
      return slotPubsub
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
            // Priority: slotFirstShredMultiplex > slotFirstShred >
            // slotMultiplex > slotPubsubUrl > slotBridge > standard
            // pubsub forward.  See WsConfig docs.
            if (slotFirstShredMultiplex) {
              const subId = ++localSubCounter
              const handle = slotFirstShredMultiplex.subscribe((u) => {
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
            if (slotFirstShred) {
              const subId = ++localSubCounter
              const handle = slotFirstShred.subscribe((u) => {
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
            if (slotMultiplex) {
              const subId = ++localSubCounter
              const handle = slotMultiplex.subscribe((u) => {
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
            const sp = ensureSlotPubsub()
            if (sp) {
              sp.send(text)
              return
            }
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
            ensurePubsub().send(text)
            return
          }
          case 'slotUnsubscribe': {
            if (slotFirstShredMultiplex || slotFirstShred || slotMultiplex || slotBridge) {
              const params = (req.params as unknown[]) ?? []
              const subId = Number(params[0])
              const handle = Number.isFinite(subId) ? localSubs.get(subId) : undefined
              if (handle) {
                handle.cancel()
                localSubs.delete(subId)
                send(ok(req.id ?? null, true))
                return
              }
              if (subId < HELIUS_ID_BASE) {
                ensurePubsub().send(text)
                return
              }
              send(ok(req.id ?? null, false))
              return
            }
            const sp = ensureSlotPubsub()
            if (sp) {
              sp.send(text)
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
            send(
              err(
                req.id ?? null,
                ERROR_CODES.METHOD_NOT_FOUND,
                `unsupported WS method: ${req.method}`,
              ),
            )
          }
        }
      },
      onClose() {
        for (const h of localSubs.values()) h.cancel()
        localSubs.clear()
        pubsub?.close()
        pubsub = null
        slotPubsub?.close()
        slotPubsub = null
        socket = null
      },
      onError(_e) {
        for (const h of localSubs.values()) h.cancel()
        localSubs.clear()
        pubsub?.close()
        pubsub = null
        slotPubsub?.close()
        slotPubsub = null
        socket = null
      },
    }
  })
}
