import { join } from '@std/path'
import { configRoot } from '@cmn/constants/path.ts'

// All gateway state lives under ~/.slv/gateway/. The dir is created on
// first `slv gateway run`; the files listed here are the authoritative
// lookup points for every other gateway subcommand and for clients
// (TUI / future web UI) that need to discover the running instance.

// 20026: non-registered, and avoids OpenClaw's 18789 so both daemons
// can coexist on the same host during dogfooding.
export const GATEWAY_DEFAULT_PORT = 20026

// Identifier served at `GET /` so clients can verify they're actually
// talking to an slv gateway (not some other service that happened to
// bind this port). Bumped with any breaking protocol change.
export const GATEWAY_SERVICE_ID = 'slv-gateway'
export const GATEWAY_PROTOCOL_VERSION = '1'

export const gatewayStateDir = (): string => join(configRoot, 'gateway')
export const gatewayConfigPath = (): string =>
  join(gatewayStateDir(), 'gateway.json')
export const gatewayPidPath = (): string =>
  join(gatewayStateDir(), 'gateway.pid')
export const gatewayLogDir = (): string => join(gatewayStateDir(), 'logs')
export const gatewayLogPath = (): string =>
  join(gatewayLogDir(), 'gateway.log')
export const gatewayErrLogPath = (): string =>
  join(gatewayLogDir(), 'gateway.err.log')
