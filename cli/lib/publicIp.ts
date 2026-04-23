/**
 * Detect the public IP of the host this CLI runs on. Used by
 * `slv onboard` (Discord URL), `slv dns set` (default IP for the
 * user's `*.erpc.global` subdomain), and `slv install nginx`
 * (confirming the VPS to register).
 *
 * Probe order, each with a short timeout:
 *   1. api.ipify.org — authoritative public IP, ignores NAT
 *   2. `hostname -I` — first interface, LAN-friendly fallback
 *   3. `Deno.hostname()` — last-resort name hint
 *
 * Returns `null` on every failure so callers can decide whether to
 * prompt the user rather than us throwing at the bottom of a long
 * flow.
 */
const IP_RE = /^[0-9a-fA-F.:]+$/

export const resolvePublicIp = async (
  opts: { timeoutMs?: number } = {},
): Promise<string | null> => {
  const timeoutMs = opts.timeoutMs ?? 3000
  // ipify first — returns the external-facing IP even from behind
  // NAT, which is what Cloudflare needs to reach the origin.
  try {
    const controller = new AbortController()
    const tid = setTimeout(() => controller.abort(), timeoutMs)
    const res = await fetch('https://api.ipify.org', {
      signal: controller.signal,
    })
    clearTimeout(tid)
    if (res.ok) {
      const ip = (await res.text()).trim()
      if (IP_RE.test(ip)) return ip
    }
  } catch { /* network / timeout — fall through */ }

  // LAN-only deployments where ipify isn't reachable.
  try {
    const p = new Deno.Command('hostname', {
      args: ['-I'],
      stdout: 'piped',
      stderr: 'null',
    })
    const { stdout, success } = await p.output()
    if (success) {
      const first = new TextDecoder().decode(stdout).trim().split(/\s+/)[0]
      if (first && IP_RE.test(first)) return first
    }
  } catch { /* command missing on non-Linux / fall through */ }

  return null
}
