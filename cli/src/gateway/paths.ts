import { join } from '@std/path'
import { configRoot } from '@cmn/constants/path.ts'

// All gateway state lives under ~/.slv/gateway/. The dir is created on
// first `slv gateway run`; the files listed here are the authoritative
// lookup points for every other gateway subcommand and for clients
// (TUI / future web UI) that need to discover the running instance.

export const GATEWAY_DEFAULT_PORT = 18789

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
