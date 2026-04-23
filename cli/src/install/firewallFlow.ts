import { runAnsibleLocal } from '/lib/runAnsibleLocal.ts'
import { getTemplatePath } from '/lib/getTemplatePath.ts'

export type FirewallFlowInput = {
  /**
   * Trusted IPs that should get unconditional (all-port) access.
   * The WireGuard subnet (10.0.0.0/24) and SSH/HTTP/HTTPS/WG ports
   * are always open regardless; this is the set that gets the
   * extra all-port grant.
   *
   * Format: dotted-quad strings, already normalized by the caller.
   * An empty array is valid — the playbook just omits the
   * whitelist stanza and relies on the always-open ports.
   */
  allowIps: string[]
}

export type FirewallFlowResult =
  | { ok: true }
  | { ok: false; error: string }

/**
 * Install the SLV perimeter firewall (nftables + fail2ban) via the
 * local ansible playbook. Callable from the CLI `slv install
 * firewall` subcommand and from the slv-security skill's EL-guided
 * flow.
 *
 * Intentionally a thin wrapper over runAnsibleLocal + playbook —
 * keeps the one-truth for the rules inside the YAML and lets the
 * same invocation serve both direct and agent-driven use.
 */
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

// Shared across the CLI subcommand and any future --allow parsers.
// One format string means an agent that's been told "call this
// with a comma-separated list" produces the right shape without
// extra prompting.
export const ALLOW_IPS_HELP =
  'Comma-separated list of IPv4 addresses to whitelist (all ports). ' +
  'Leave blank to rely on the always-open SSH/HTTP/HTTPS/WireGuard ' +
  'ports alone.'

const IPV4_RE =
  /^(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/

/** Parse / validate the `--allow` flag value(s). Rejects malformed IPs. */
export const parseAllowIps = (raw: string | string[] | undefined): {
  ok: true
  ips: string[]
} | { ok: false; bad: string } => {
  if (!raw) return { ok: true, ips: [] }
  const tokens = (Array.isArray(raw) ? raw : [raw])
    .flatMap((chunk) => chunk.split(','))
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
  for (const t of tokens) {
    if (!IPV4_RE.test(t)) return { ok: false, bad: t }
  }
  // De-dupe while preserving order so the firewall ruleset is
  // stable run-to-run.
  const seen = new Set<string>()
  const out: string[] = []
  for (const t of tokens) {
    if (!seen.has(t)) {
      seen.add(t)
      out.push(t)
    }
  }
  return { ok: true, ips: out }
}
