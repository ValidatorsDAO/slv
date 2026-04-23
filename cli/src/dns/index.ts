import { Command } from '@cliffy'
import { Confirm } from '@cliffy/prompt'
import { colors } from '@cliffy/colors'
import {
  explainDnsSetError,
  getDnsStatus,
  setDnsRecord,
} from '/lib/slvCloudMcp.ts'
import { getApiKeyFromYml } from '/lib/getApiKeyFromYml.ts'
import { resolvePublicIp } from '/lib/publicIp.ts'

const readSlvApiKey = async (): Promise<string | null> => {
  try {
    return await getApiKeyFromYml(true)
  } catch {
    return null
  }
}

/**
 * `slv dns` — manage the caller's `*.erpc.global` subdomains via
 * the erpc user-api. The default slug is free and always available;
 * custom slugs are gated on a paid subscription (currently 402).
 */
export const dnsCmd = new Command()
  .description(
    `Manage your *.erpc.global DNS records — the free default subdomain and any paid custom slugs. Traffic through those records is Cloudflare-proxied, so pointing one at your VPS gives you HTTPS automatically.`,
  )
  .action(() => dnsCmd.showHelp())

dnsCmd.command('status')
  .description(
    'Show the caller\'s DNS state: the default `<slug>.erpc.global` subdomain and any paid custom slugs, with the IP they currently point at.',
  )
  .action(async () => {
    const apiKey = await readSlvApiKey()
    if (!apiKey) {
      console.error(
        colors.red('❌ no SLV API key — run `slv login` first.'),
      )
      Deno.exit(1)
    }
    const result = await getDnsStatus(apiKey)
    if (!result.ok) {
      if (result.status === 401) {
        console.error(
          colors.red('❌ authentication failed — run `slv login`.'),
        )
      } else {
        console.error(
          colors.red(`❌ /v3/dns/status returned ${result.status}`),
        )
      }
      Deno.exit(1)
    }
    const { default: d, custom } = result.data
    console.log(colors.bold('SLV DNS status'))
    console.log()
    console.log(colors.bold.rgb24('  default (free)', 0x14f195))
    console.log(colors.white(`    fqdn:    ${d.fqdn}`))
    console.log(colors.white(`    ip:      ${d.ip ?? '(not set yet)'}`))
    console.log(colors.white(`    proxied: ${d.proxied ? 'yes' : 'no'}`))
    if (d.updatedAt) {
      console.log(colors.gray(`    updated: ${d.updatedAt}`))
    }
    if (custom.length > 0) {
      console.log()
      console.log(colors.bold.rgb24('  custom (paid)', 0xffdf7a))
      for (const c of custom) {
        console.log(colors.white(`    ${c.fqdn} → ${c.ip ?? '(not set)'}`))
      }
    }
    console.log()
    console.log(
      colors.gray(
        '    `slv dns set` points a record at a VPS IP you already own.',
      ),
    )
  })

dnsCmd.command('set')
  .description(
    `Point an A record at an IP you own. Omit --slug for your free default; --slug <name> targets a custom slug (paid tier). If --ip is omitted, we auto-detect this host\'s public IP via api.ipify.org.`,
  )
  .option('--ip <ip:string>', 'IPv4 to point the record at (auto-detect if omitted)')
  .option('--slug <slug:string>', 'Custom slug (requires paid subscription)')
  .option('--no-proxied', 'Disable Cloudflare proxying (DNS-only; you provide your own TLS)')
  .option('-y, --yes', 'Skip the confirmation prompt', { default: false })
  .action(
    async (opts: {
      ip?: string
      slug?: string
      proxied?: boolean
      yes?: boolean
    }) => {
      const apiKey = await readSlvApiKey()
      if (!apiKey) {
        console.error(
          colors.red('❌ no SLV API key — run `slv login` first.'),
        )
        Deno.exit(1)
      }

      let ip = opts.ip
      if (!ip) {
        const detected = await resolvePublicIp()
        if (!detected) {
          console.error(
            colors.red(
              '❌ could not auto-detect public IP. Pass --ip <address> explicitly.',
            ),
          )
          Deno.exit(1)
        }
        ip = detected
        console.log(colors.gray(`  auto-detected IP: ${ip}`))
      }

      if (!opts.yes) {
        const targetLabel = opts.slug
          ? `<slug> ${opts.slug}.erpc.global`
          : 'your default <slug>.erpc.global'
        const ok = await Confirm.prompt({
          message: `Point ${targetLabel} at ${ip}?`,
          default: true,
        })
        if (!ok) {
          console.log(colors.gray('cancelled.'))
          return
        }
      }

      const result = await setDnsRecord(apiKey, {
        ip,
        slug: opts.slug,
        proxied: opts.proxied,
      })
      if (!result.ok) {
        console.error(colors.red(`❌ ${explainDnsSetError(result)}`))
        Deno.exit(1)
      }
      const { fqdn, ip: confirmedIp, proxied } = result.data
      console.log(
        colors.green(`✅ ${fqdn} → ${confirmedIp} (${proxied ? 'proxied' : 'dns-only'})`),
      )
      console.log(
        colors.gray(
          '   Cloudflare usually converges in a few seconds — re-run `slv dns status` to confirm.',
        ),
      )
    },
  )
