import { colors } from '@cliffy/colors'
import { pickGatewayService } from '/src/gateway/service/pick.ts'
import { loadGatewayConfig } from '/src/gateway/config.ts'
import {
  gatewayConfigPath,
  gatewayErrLogPath,
  gatewayLogPath,
  gatewayPidPath,
} from '/src/gateway/paths.ts'
import { errToString } from '/lib/errToString.ts'

type PidfileView = {
  pid: number
  startedAt: string
  port: number
}

const readPidfile = async (): Promise<PidfileView | null> => {
  try {
    const raw = await Deno.readTextFile(gatewayPidPath)
    return JSON.parse(raw) as PidfileView
  } catch {
    return null
  }
}

export const statusAction = async (): Promise<boolean> => {
  let service
  try {
    service = pickGatewayService()
  } catch (err) {
    console.error(colors.red(`❌ ${errToString(err)}`))
    return false
  }

  const [svc, pid] = await Promise.all([
    service.status().catch((err) => ({
      loaded: false,
      running: false,
      details: `status check failed: ${errToString(err)}`,
    })),
    readPidfile(),
  ])

  console.log(colors.bold(`slv gateway (${service.name})`))
  console.log(
    colors.white(`  installed:  ${svc.loaded ? 'yes' : 'no'}`),
  )
  console.log(
    colors.white(
      `  running:    ${svc.running ? colors.green('yes') : colors.gray('no')}`,
    ),
  )
  if (pid) {
    console.log(colors.white(`  pidfile:    pid=${pid.pid} port=${pid.port}`))
    console.log(colors.white(`              started ${pid.startedAt}`))
  } else {
    console.log(colors.white(`  pidfile:    absent`))
  }
  try {
    const cfg = await loadGatewayConfig()
    console.log(colors.white(`  config:     ${gatewayConfigPath}`))
    console.log(colors.white(`              port=${cfg.port} mode=${cfg.mode}`))
  } catch {
    console.log(
      colors.white(`  config:     ${gatewayConfigPath} (absent or invalid)`),
    )
  }
  console.log(colors.white(`  logs:       ${gatewayLogPath}`))
  console.log(colors.white(`              ${gatewayErrLogPath}`))

  if (svc.details.trim()) {
    console.log()
    console.log(colors.gray(svc.details.trim()))
  }
  return true
}
