/**
 * Generate an RSA private key + matching CSR for Cloudflare Origin CA
 * issuance. The private key never leaves this process — only the CSR
 * is sent to the erpc `POST /v3/dns/origin-cert` endpoint.
 *
 * Uses the system `openssl` binary (one step, one invocation via a
 * config file) rather than wiring up a WebCrypto RSA key-gen + BER
 * encoder inside Deno. openssl is already a nginx install prereq on
 * any Ubuntu/Debian host, so we're not adding a new dependency.
 */

export type Csr = {
  /** PEM-encoded RSA private key (2048-bit). */
  keyPem: string
  /** PEM-encoded CertificateSigningRequest (CN + SAN = fqdn). */
  csrPem: string
}

/**
 * Generate a fresh key + CSR for the given fully-qualified hostname.
 *
 * `fqdn` ends up as BOTH the Subject CN and the single
 * subjectAltName DNS entry. Cloudflare Origin CA won't issue a
 * leaf cert that lacks a SAN (post-2017 requirement), so both
 * fields get set.
 *
 * Throws with a clear message on openssl failure — callers should
 * fall back to self-signed or surface the error to the user.
 */
export const generateCsr = async (fqdn: string): Promise<Csr> => {
  // Label-by-label fqdn check:
  //   - each label: 1-63 chars, alnum, hyphens allowed but not at
  //     edges — matches RFC 1035.
  //   - at least two labels (e.g. `x.y`) with a TLD of 2+ chars.
  //   - rejects leading / trailing / consecutive dots and IP-like
  //     strings (all-numeric TLDs).
  const FQDN_RE =
    /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*\.[a-z]{2,63}$/i
  if (!FQDN_RE.test(fqdn)) {
    throw new Error(`generateCsr: refusing malformed fqdn: ${fqdn}`)
  }

  // Single openssl config that covers key + CSR generation. Kept in
  // memory (tmpfile, removed in `finally`) rather than stdin so the
  // request_extensions stanza works — openssl's -new + -addext CLI
  // flags have historically been wonky across distro versions.
  const config = [
    '[req]',
    'default_bits = 2048',
    'prompt = no',
    'default_md = sha256',
    'distinguished_name = dn',
    'req_extensions = req_ext',
    '',
    '[dn]',
    `CN = ${fqdn}`,
    '',
    '[req_ext]',
    'subjectAltName = @alt_names',
    '',
    '[alt_names]',
    `DNS.1 = ${fqdn}`,
    '',
  ].join('\n')

  const tmpDir = await Deno.makeTempDir({ prefix: 'slv-csr-' })
  const configPath = `${tmpDir}/openssl.cnf`
  const keyPath = `${tmpDir}/key.pem`
  const csrPath = `${tmpDir}/csr.pem`
  try {
    await Deno.writeTextFile(configPath, config)
    const p = new Deno.Command('openssl', {
      args: [
        'req',
        '-new',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-keyout',
        keyPath,
        '-out',
        csrPath,
        '-config',
        configPath,
      ],
      stdout: 'piped',
      stderr: 'piped',
    })
    const { success, stderr } = await p.output()
    if (!success) {
      const msg = new TextDecoder().decode(stderr).trim()
      throw new Error(`openssl req failed: ${msg || 'non-zero exit'}`)
    }
    const [keyPem, csrPem] = await Promise.all([
      Deno.readTextFile(keyPath),
      Deno.readTextFile(csrPath),
    ])
    return { keyPem, csrPem }
  } finally {
    await Deno.remove(tmpDir, { recursive: true }).catch(() => {})
  }
}
