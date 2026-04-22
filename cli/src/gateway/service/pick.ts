import type { GatewayService } from '/src/gateway/service/service.ts'
import { LaunchdService } from '/src/gateway/service/launchd.ts'
import { SystemdUserService } from '/src/gateway/service/systemd.ts'

/**
 * Select the gateway service backend for the current OS. Throws on
 * unsupported platforms (Windows, BSD) with a clear message so CLI
 * handlers can surface it verbatim.
 */
export const pickGatewayService = (): GatewayService => {
  switch (Deno.build.os) {
    case 'darwin':
      return new LaunchdService()
    case 'linux':
      return new SystemdUserService()
    default:
      throw new Error(
        `slv gateway install/start/stop is only supported on macOS and Linux; got ${Deno.build.os}. ` +
          `You can still run the gateway manually with 'slv gateway run'.`,
      )
  }
}
