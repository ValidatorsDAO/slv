import { runAnsibleLocal } from '/lib/runAnsibleLocal.ts'
import { getTemplatePath } from '/lib/getTemplatePath.ts'

export type FirewallFlowInput = {
  allowIps: string[]
}

export type FirewallFlowResult =
  | { ok: true }
  | { ok: false; error: string }

export const runFirewallFlow = async (
  opts: FirewallFlowInput,
): Promise<FirewallFlowResult> => {
  const templateRoot = getTemplatePath()
  const playbook =
    `${templateRoot}/ansible/cmn/software/install-firewall.yaml`
  const success = await runAnsibleLocal(playbook, {
    allow_ips: opts.allowIps.join(','),
  })
  if (!success) {
    return {
      ok: false,
      error:
        'ansible playbook did not complete — check the logs printed above.',
    }
  }
  return { ok: true }
}

export const ALLOW_IPS_HELP =
  'Comma-separated list of IPv4 addresses to whitelist (all ports). ' +
  'Leave blank to rely on the always-open SSH/HTTP/HTTPS/WireGuard ' +
  'ports alone.'

const IPV4_RE =
  /^(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/

export const parseAllowIps = (raw: string | string[] | undefined): {
  ok: true
  ips: string[]
} | { ok: false; bad: string } => {
  if (!raw) return { ok: true, ips: [] }
  const tokens = (Array.isArray(raw) ? raw : [raw])
    .flatMap((chunk) => chunk.split(','))
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
  const seen = new Set<string>()
  const out: string[] = []
  for (const t of tokens) {
    if (!IPV4_RE.test(t)) return { ok: false, bad: t }
    if (!seen.has(t)) {
      seen.add(t)
      out.push(t)
    }
  }
  return { ok: true, ips: out }
}
