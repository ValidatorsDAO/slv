import { Command } from '@cliffy'
import { colors } from '@cliffy/colors'
import { VERSION } from '@cmn/constants/version.ts'
import { resolvePublicIp } from '/lib/publicIp.ts'
import { getApiKeyFromYml } from '/lib/getApiKeyFromYml.ts'
import { getDnsStatus } from '/lib/slvCloudMcp.ts'
import { pickGatewayService } from '/src/gateway/service/pick.ts'
import { localExec } from '/src/bot/execUtil.ts'

// A single health-check outcome. Callers render with a ✓ / ⚠ / ✗ prefix
// and optionally run `fix()` when --fix is passed.
type CheckStatus = 'ok' | 'warn' | 'fail' | 'skip'

type CheckResult = {
  name: string
  status: CheckStatus
  message: string
  // How to remediate when --fix is passed. Returns the new status +
  // a short "what I did" string, or throws on irrecoverable failure.
  fix?: () => Promise<{ status: CheckStatus; message: string }>
}

const symbolFor = (s: CheckStatus): string => {
  if (s === 'ok') return colors.green('✓')
  if (s === 'warn') return colors.yellow('⚠')
  if (s === 'fail') return colors.red('✗')
  return colors.gray('·')
}

const checkGatewayRunning = async (): Promise<CheckResult> => {
  let svc
  try {
    svc = pickGatewayService()
  } catch {
    return {
      name: 'gateway service',
      status: 'skip',
      message: 'no supported service manager detected',
    }
  }
  const st = await svc.status().catch(() => null)
  if (!st || !st.loaded) {
    return {
      name: 'gateway service',
      status: 'fail',
      message: 'not installed — run `slv onboard` or `slv gateway install`',
    }
  }
  if (st.running) {
    return { name: 'gateway service', status: 'ok', message: 'active' }
  }
  return {
    name: 'gateway service',
    status: 'fail',
    message: 'installed but not running',
    fix: async () => {
      await svc.start()
      return { status: 'ok', message: 'started via systemctl' }
    },
  }
}

const checkLinger = async (): Promise<CheckResult> => {
  const user = Deno.env.get('USER') || Deno.env.get('LOGNAME') || ''
  if (!user) {
    return {
      name: 'systemd linger',
      status: 'skip',
      message: 'no $USER in env',
    }
  }
  const probe = await localExec('loginctl', ['show-user', user])
  if (!probe.success) {
    return {
      name: 'systemd linger',
      status: 'skip',
      message: 'loginctl not available (non-systemd host)',
    }
  }
  if (/Linger=yes/.test(probe.stdout)) {
    return { name: 'systemd linger', status: 'ok', message: `Linger=yes (${user})` }
  }
  return {
    name: 'systemd linger',
    status: 'warn',
    message: `Linger=no for ${user} — gateway dies on SSH logout`,
    fix: async () => {
      const r = await localExec('sudo', [
        '-n',
        'loginctl',
        'enable-linger',
        user,
      ])
      if (!r.success) {
        return {
          status: 'fail',
          message: `sudo loginctl enable-linger failed: ${r.stderr.trim()}`,
        }
      }
      return { status: 'ok', message: `enabled linger for ${user}` }
    },
  }
}

const checkGatewayPort = async (): Promise<CheckResult> => {
  try {
    const conn = await Promise.race([
      Deno.connect({ hostname: '127.0.0.1', port: 20026 }),
      new Promise<Deno.Conn>((_, reject) =>
        setTimeout(() => reject(new Error('timeout')), 2_000)
      ),
    ])
    conn.close()
    return {
      name: 'gateway port 20026',
      status: 'ok',
      message: 'accepting connections',
    }
  } catch (err) {
    return {
      name: 'gateway port 20026',
      status: 'fail',
      message: err instanceof Error ? err.message : String(err),
    }
  }
}

const checkNginx = async (): Promise<CheckResult> => {
  const probe = await localExec('systemctl', ['is-active', 'nginx'])
  if (!probe.success || !probe.stdout.includes('active')) {
    // Try user-mode too in case this is a user-service system.
    return {
      name: 'nginx',
      status: 'skip',
      message: 'not running (no HTTPS reverse proxy detected)',
    }
  }
  return { name: 'nginx', status: 'ok', message: 'active' }
}

const checkDns = async (): Promise<CheckResult> => {
  let apiKey: string | null = null
  try {
    apiKey = await getApiKeyFromYml(true)
  } catch { /* no key */ }
  if (!apiKey) {
    return {
      name: 'DNS record',
      status: 'skip',
      message: 'no SLV API key — run `slv login` to enable this check',
    }
  }
  const status = await getDnsStatus(apiKey)
  if (!status.ok) {
    return {
      name: 'DNS record',
      status: 'fail',
      message: `/v3/dns/status returned ${status.status}`,
    }
  }
  const def = status.data.default
  if (!def.exists) {
    return {
      name: 'DNS record',
      status: 'warn',
      message: `${def.fqdn} not registered — run \`slv install nginx\` to set it up`,
    }
  }
  const ip = await resolvePublicIp()
  if (ip && def.ip && def.ip !== ip) {
    return {
      name: 'DNS record',
      status: 'warn',
      message:
        `${def.fqdn} points at ${def.ip} but this host's public IP is ${ip} — run \`slv dns set\` to fix`,
    }
  }
  return {
    name: 'DNS record',
    status: 'ok',
    message: `${def.fqdn} → ${def.ip ?? '(none)'}`,
  }
}

const runAllChecks = async (): Promise<CheckResult[]> => {
  return [
    await checkGatewayRunning(),
    await checkLinger(),
    await checkGatewayPort(),
    await checkNginx(),
    await checkDns(),
  ]
}

const printSummary = (results: CheckResult[]): number => {
  let fails = 0
  for (const r of results) {
    console.log(`  ${symbolFor(r.status)} ${r.name}: ${r.message}`)
    if (r.status === 'fail') fails++
  }
  console.log()
  console.log(
    fails === 0
      ? colors.green('All critical checks passed.')
      : colors.yellow(`${fails} failing check(s) — pass --fix to auto-repair.`),
  )
  return fails
}

export const doctorCmd = new Command()
  .description(
    'Run health checks on the local SLV install — gateway service, linger, port, nginx, DNS. Add --fix to auto-repair what can be fixed safely.',
  )
  .option('--fix', 'Attempt to remediate any failing / warning checks.', {
    default: false,
  })
  .action(async (opts: { fix?: boolean }) => {
    console.log(colors.bold(`SLV doctor — v${VERSION}`))
    console.log()
    const results = await runAllChecks()
    const initialFails = printSummary(results)

    if (!opts.fix) {
      Deno.exit(initialFails > 0 ? 1 : 0)
    }

    const fixable = results.filter((r) =>
      (r.status === 'fail' || r.status === 'warn') && r.fix
    )
    if (fixable.length === 0) {
      console.log(colors.gray('Nothing safely fixable; exiting.'))
      Deno.exit(initialFails > 0 ? 1 : 0)
    }

    console.log()
    console.log(colors.cyan(`Running --fix on ${fixable.length} item(s)...`))
    for (const r of fixable) {
      try {
        const out = await r.fix!()
        console.log(`  ${symbolFor(out.status)} ${r.name}: ${out.message}`)
      } catch (err) {
        console.log(
          `  ${symbolFor('fail')} ${r.name}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        )
      }
    }

    console.log()
    console.log(colors.cyan('Re-running checks...'))
    const after = await runAllChecks()
    const postFails = printSummary(after)
    Deno.exit(postFails > 0 ? 1 : 0)
  })
