import { colors } from '@cliffy/colors'
import { Confirm } from '@cliffy/prompt'
import {
  GATEWAY_MODES,
  type GatewayMode,
  loadGatewayConfig,
  writeGatewayConfig,
} from '/src/gateway/config.ts'
import { pickGatewayService } from '/src/gateway/service/pick.ts'
import { errToString } from '/lib/errToString.ts'

export const showConfigAction = async (): Promise<boolean> => {
  try {
    const cfg = await loadGatewayConfig()
    console.log(colors.bold('slv gateway config'))
    console.log(colors.white(`  mode:  ${cfg.mode}`))
    console.log(colors.white(`  port:  ${cfg.port}`))
    console.log(colors.gray(`  token: (hidden, 64 hex chars)`))
    const bind = cfg.mode === 'lan' ? '0.0.0.0 (any interface)' : '127.0.0.1 (loopback)'
    console.log(colors.gray(`  binds: ${bind}`))
    return true
  } catch (err) {
    console.error(colors.red(`❌ ${errToString(err)}`))
    return false
  }
}

export const setModeAction = async (
  mode: string,
  opts: { yes?: boolean } = {},
): Promise<boolean> => {
  if (!(GATEWAY_MODES as readonly string[]).includes(mode)) {
    console.error(
      colors.red(
        `❌ mode must be one of: ${GATEWAY_MODES.join(' | ')} (got "${mode}")`,
      ),
    )
    return false
  }
  const newMode = mode as GatewayMode

  let cfg
  try {
    cfg = await loadGatewayConfig()
  } catch (err) {
    console.error(colors.red(`❌ ${errToString(err)}`))
    return false
  }
  if (cfg.mode === newMode) {
    console.log(colors.gray(`mode is already "${newMode}" — nothing to do.`))
    return true
  }

  // Safety gate for the lan transition. The token still authenticates
  // every WS method, but anyone on the network can scan the HTTP
  // endpoints and see the service exists. Users on shared hosts
  // shouldn't be here.
  if (newMode === 'lan' && !opts.yes) {
    console.log()
    console.log(
      colors.bold.yellow(
        `  ⚠️  Switching to lan mode binds the gateway to 0.0.0.0.`,
      ),
    )
    console.log(
      colors.white(
        '    Anyone on this host\'s network can reach /, /healthz, and /ui/.'
      ),
    )
    console.log(
      colors.white(
        '    WebSocket methods still require the 256-bit token, so chat is',
      ),
    )
    console.log(
      colors.white(
        "    gated — but the HTTP surface is exposed to port scanners.",
      ),
    )
    console.log()
    console.log(
      colors.bold.red(
        '    Only proceed on a dedicated dev-VPS you fully own.',
      ),
    )
    console.log()
    const ok = await Confirm.prompt({
      message: 'Switch to lan mode?',
      default: false,
    })
    if (!ok) {
      console.log(colors.gray('  cancelled.'))
      return false
    }
  }

  try {
    await writeGatewayConfig({ ...cfg, mode: newMode })
  } catch (err) {
    console.error(colors.red(`❌ ${errToString(err)}`))
    return false
  }
  console.log(
    colors.green(`✅ mode changed: ${cfg.mode} → ${newMode}`),
  )

  // Restart the service if it's currently running so the new bind
  // takes effect without the user having to do it manually. Failures
  // here are non-fatal — the config IS written.
  try {
    const service = pickGatewayService()
    const status = await service.status()
    if (status.running) {
      console.log(
        colors.cyan(
          `🔄 restarting the gateway so the new bind takes effect...`,
        ),
      )
      await service.restart()
      console.log(colors.green(`✅ gateway restarted`))
    } else if (status.loaded) {
      console.log(
        colors.gray(
          '  (gateway is installed but not running — start it with `slv gateway start`)',
        ),
      )
    }
  } catch (err) {
    console.log(
      colors.yellow(
        `  ⚠️  could not auto-restart the gateway: ${errToString(err)}`,
      ),
    )
    console.log(
      colors.white('     Run `slv gateway restart` manually.'),
    )
  }
  return true
}
