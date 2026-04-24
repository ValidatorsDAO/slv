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
  // Probe the gateway's own healthz endpoint rather than raw TCP —
  // raw connect succeeds against any process that happened to bind
  // 20026, not just our gateway.
  try {
    const res = await fetch('http://127.0.0.1:20026/healthz', {
      signal: AbortSignal.timeout(2_000),
    })
    if (!res.ok) {
      return {
        name: 'gateway port 20026',
        status: 'fail',
        message: `/healthz returned ${res.status}`,
      }
    }
    // Drain the body so the response isn't left hanging.
    await res.text().catch(() => {})
    return {
      name: 'gateway port 20026',
      status: 'ok',
      message: 'healthz 200',
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
  // Distinguish "not installed" (skip, fine) from "installed but
  // inactive" (fail, real problem). `is-active` exits non-zero in
  // both cases and doesn't tell us which.
  const installed = await localExec('systemctl', [
    'list-unit-files',
    'nginx.service',
  ])
  const hasUnit = installed.success && /nginx\.service/.test(installed.stdout)
  if (!hasUnit) {
    return {
      name: 'nginx',
      status: 'skip',
      message: 'not installed (no HTTPS reverse proxy configured)',
    }
  }
  const probe = await localExec('systemctl', ['is-active', 'nginx'])
  if (!probe.success || !probe.stdout.includes('active')) {
    return {
      name: 'nginx',
      status: 'fail',
      message: 'installed but inactive — run `sudo systemctl start nginx`',
      fix: async () => {
        const r = await localExec('sudo', ['-n', 'systemctl', 'start', 'nginx'])
        if (!r.success) {
          return {
            status: 'fail',
            message: `sudo start failed: ${r.stderr.trim()}`,
          }
        }
        return { status: 'ok', message: 'started nginx' }
      },
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
  // Fetch status + local public IP in parallel — independent network calls.
  const [status, ip] = await Promise.all([
    getDnsStatus(apiKey).catch((err) => ({
      ok: false as const,
      status: 0,
      body: {
        error: 'network',
        message: err instanceof Error ? err.message : String(err),
      },
    })),
    resolvePublicIp(),
  ])
  if (!status.ok) {
    return {
      name: 'DNS record',
      status: 'fail',
      message: status.status > 0
        ? `/v3/dns/status returned ${status.status}`
        : `/v3/dns/status unreachable: ${status.body?.message ?? ''}`,
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
  // All five checks are independent — parallelize so a slow network
  // on checkDns doesn't serialize behind checkLinger etc.
  return await Promise.all([
    checkGatewayRunning(),
    checkLinger(),
    checkGatewayPort(),
    checkNginx(),
    checkDns(),
  ])
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
