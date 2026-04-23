import {
  explainDnsSetError,
  getDnsStatus,
  requestOriginCert,
  setDnsRecord,
} from '/lib/slvCloudMcp.ts'
import { resolvePublicIp } from '/lib/publicIp.ts'
import { runAnsibleLocal } from '/lib/runAnsibleLocal.ts'
import { getTemplatePath } from '/lib/getTemplatePath.ts'
import { generateCsr } from '/lib/generateCsr.ts'

// PEM is already an ASCII-only encoding, so the base64-of-PEM
// double-wrapping for ansible --extra-vars transport is safe:
// `btoa(pem)` never sees a multi-byte code unit.
const b64 = (pem: string): string => btoa(pem)

export type NginxFlowInput = {
  /** SLV API key (Bearer) used to authenticate against the erpc /v3/dns/* endpoints. */
  apiKey: string
  /** Loopback port on this host to reverse-proxy to. Typically 20026 (gateway). */
  port: number
  /**
   * Custom slug under erpc.global. Omit for the user's free
   * default slug (always available); passing this is a paid-tier
   * operation and `/v3/dns/set` will return 402 until the Stripe
   * product launches.
   */
  slug?: string
  /**
   * Override the auto-detected public IP. Useful when the host
   * is behind NAT or the user wants to point the DNS record at a
   * different interface than the one ipify sees.
   */
  ip?: string
}

export type NginxFlowSuccess = {
  ok: true
  /** Final fqdn the HTTPS URL is available at. */
  fqdn: string
  /** `https://<fqdn>/` — pre-formatted for display / Discord. */
  httpsUrl: string
  /** IP the DNS record now points at (may have been auto-detected). */
  ip: string
  /**
   * True when a Cloudflare Origin CA cert was successfully issued and
   * installed on origin. False when we fell back to self-signed
   * (still works in Full non-strict, but Full strict will 526).
   * Callers can use this to surface a "run `slv install nginx` again
   * once the erpc origin-cert endpoint is deployed" hint.
   */
  originCertIssued: boolean
}

export type NginxFlowFailure = {
  ok: false
  /** Short user-facing explanation. */
  error: string
  /** Which stage failed, so callers can render mode-specific messaging. */
  stage: 'dns_status' | 'ip_detection' | 'dns_set' | 'nginx_install'
}

export type NginxFlowResult = NginxFlowSuccess | NginxFlowFailure

/**
 * End-to-end: register the user's `*.erpc.global` subdomain
 * against this VPS, then install + configure nginx to reverse-
 * proxy HTTPS traffic down to a loopback service.
 *
 * Used by both `slv install nginx` (the interactive CLI) and
 * `slv onboard` (the first-run flow). All network errors are
 * caught and surfaced via the tagged failure result — the
 * callers decide how loudly to complain.
 */
export const runNginxFlow = async (
  opts: NginxFlowInput,
): Promise<NginxFlowResult> => {
  // 1. Read the user's DNS state to learn their default slug.
  // We also honor a `--slug` override here; the endpoint will
  // reject paid-tier names until the Stripe product is live.
  const status = await getDnsStatus(opts.apiKey)
  if (!status.ok) {
    return {
      ok: false,
      stage: 'dns_status',
      error: status.status === 401
        ? 'SLV API key rejected — run `slv login`.'
        : `/v3/dns/status returned ${status.status}`,
    }
  }
  const defaultRec = status.data.default
  const fqdn = opts.slug
    ? `${opts.slug}.erpc.global`
    : defaultRec.fqdn

  // 2. Resolve the IP the DNS record should point at.
  let ip = opts.ip
  if (!ip) {
    const detected = await resolvePublicIp()
    if (!detected) {
      return {
        ok: false,
        stage: 'ip_detection',
        error:
          'could not auto-detect a public IP — re-run with --ip <address>.',
      }
    }
    ip = detected
  }

  // 3. POST /v3/dns/set unless the record is already exactly
  // what we want. Re-publishing is harmless but noisy in logs;
  // the user-facing flow stays quieter if we skip a no-op.
  const alreadyCorrect = !opts.slug &&
    defaultRec.exists &&
    defaultRec.ip === ip
  if (!alreadyCorrect) {
    const setResult = await setDnsRecord(opts.apiKey, {
      ip,
      slug: opts.slug,
    })
    if (!setResult.ok) {
      return {
        ok: false,
        stage: 'dns_set',
        error: explainDnsSetError(setResult),
      }
    }
  }

  // 4. Try to get a Cloudflare Origin CA cert via the erpc MCP.
  // With this cert in place on origin, the erpc.global zone can
  // run in Cloudflare Full (strict) mode — no origin-pull cert
  // validation failures (526). If the MCP tool isn't deployed
  // yet (older erpc) or issuance fails transiently, we fall back
  // to the playbook's self-signed cert — Full (not strict) still
  // works with that, so the install doesn't fail outright.
  const extraVars: Record<string, string> = {
    fqdn,
    upstream_port: String(opts.port),
  }
  let originCertIssued = false
  try {
    const csr = await generateCsr(fqdn)
    const cert = await requestOriginCert(opts.apiKey, {
      csr: csr.csrPem,
      slug: opts.slug,
    })
    if (cert.ok) {
      extraVars.origin_cert_b64 = b64(cert.data.certificate)
      extraVars.origin_key_b64 = b64(csr.keyPem)
      originCertIssued = true
    } else if (cert.kind === 'tool_not_found') {
      // erpc hasn't shipped POST /v3/dns/origin-cert yet; silently
      // use the self-signed fallback. Callers see this via the
      // returned `originCertIssued` flag (exposed on success).
    } else {
      // Endpoint exists but refused (invalid_csr, premium_required,
      // cloudflare_error, …). Log a breadcrumb and fall back;
      // non-fatal because the self-signed path still produces a
      // working nginx in Full (not strict) mode.
      console.warn(
        `Origin CA issuance skipped: status=${cert.status} ${
          cert.body?.error ?? ''
        } ${cert.body?.message ?? ''}`.trim(),
      )
    }
  } catch (err) {
    // openssl missing, tmp-write failure, or a hang we didn't
    // anticipate. Same fallback.
    console.warn(
      `Origin CA issuance skipped (local error): ${
        err instanceof Error ? err.message : String(err)
      }`,
    )
  }

  // 5. Install/configure nginx via the local ansible playbook.
  // `fqdn` + `upstream_port` are required; `origin_cert_b64` +
  // `origin_key_b64` are optional — the playbook's self-signed
  // fallback kicks in when they're empty.
  const templateRoot = getTemplatePath()
  const playbook =
    `${templateRoot}/ansible/cmn/software/install-nginx.yaml`
  const success = await runAnsibleLocal(playbook, extraVars)
  if (!success) {
    return {
      ok: false,
      stage: 'nginx_install',
      error:
        'ansible playbook did not complete — check the logs printed above.',
    }
  }

  return {
    ok: true,
    fqdn,
    httpsUrl: `https://${fqdn}/`,
    ip,
    originCertIssued,
  }
}
