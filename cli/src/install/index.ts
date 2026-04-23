import { Command } from '@cliffy'
import { Confirm, Input, prompt, Select } from '@cliffy/prompt'
import { colors } from '@cliffy/colors'
import { runAnsibleV2 } from '/lib/runAnsibleV2.ts'
import { getTemplatePath } from '/lib/getTemplatePath.ts'
import {
  isInventoryFilePath,
  resolveIpsFromInventoryFile,
} from '/src/install/inventoryTargets.ts'

// A WireGuard public key is 32 bytes base64-encoded: 44 chars total,
// always ending in `=`. Validating client-side gives a clean early
// error before we bother ansible.
const WG_PUBKEY_RE = /^[A-Za-z0-9+/]{43}=$/
const WG_PUBKEY_EXPORT_PATH = '/tmp/slv-wg-server-pubkey.txt'

export const SoftwareComponents = [
  'Redis',
  'TiDB (MySQL Cluster)',
  'Grafana',
  'Prometheus',
  'Node Exporter',
  'Kafka Cluster',
]

export const mapSoftwareComponentToAnsibleFile: Record<string, string> = {
  Redis: 'redis',
  'TiDB (MySQL Cluster)': 'tidb',
  Grafana: 'grafana',
  Prometheus: 'prometheus',
  'Node Exporter': 'node-exporter',
  'Kafka Cluster': 'kafka',
}

export type SoftwareComponent = typeof SoftwareComponents[number]

export const installCmd = new Command()
  .description('Install Software Components for Vps/BareMetal')
  .option(
    '-i, --inventory <string>',
    'e.g. -i 1.1.1.1, or -i ~/.slv/inventory.app.yml',
  )
  .option('-l, --limit <string>', 'Limit to specific hosts')
  .action(async (options) => {
    console.log(colors.cyan('🚀 Installing software components...'))
    let ips: string[] = []
    let inventoryFileIps: string[] = []
    if (!options.inventory) {
      console.log(
        colors.yellow(
          `⚠️ No inventory specified. Default inventory will be used.
          
You can specify an inventory using the -i option.

e.g. slv i -i 1.1.1.1,2.2.2.2 or slv i -i ~/.slv/inventory.app.yml
`,
        ),
      )
      return
    }
    const isInventoryIP = options.inventory
      ? /^\d{1,3}(\.\d{1,3}){3}$/.test(options.inventory)
      : false
    if (isInventoryIP && !options.inventory!.includes(',')) {
      options.inventory = `${options.inventory},`
    }
    if (isInventoryIP && options.inventory) {
      ips = options.inventory
        .split(',')
        .map((ip: string) => ip.trim())
        .filter((ip: string) => ip.length > 0)
    }
    if (
      !isInventoryIP &&
      options.inventory &&
      isInventoryFilePath(options.inventory)
    ) {
      inventoryFileIps = await resolveIpsFromInventoryFile(
        options.inventory,
        options.limit,
      )
    }
    const promptResult = await prompt([
      {
        name: 'name',
        message: 'Select Software Component to Install',
        type: Select,
        options: SoftwareComponents,
        default: SoftwareComponents[0],
      },
    ])
    console.log(
      colors.green(`✅ You selected: ${colors.white(promptResult.name!)}`),
    )
    const templateRoot = getTemplatePath()
    const softwareName =
      mapSoftwareComponentToAnsibleFile[promptResult.name as SoftwareComponent]
    const inventory = options.inventory ? options.inventory : 'default'
    const accessTargets = ips.length > 0
      ? ips
      : inventoryFileIps.length > 0
      ? inventoryFileIps
      : inventory
      ? [inventory]
      : ['default']
    const inventoryDisplay = ips.length > 0 || inventoryFileIps.length > 0
      ? accessTargets.join(', ')
      : inventory
    const filePath =
      `${templateRoot}/ansible/cmn/software/install-${softwareName}.yml`
    console.log(colors.blue('\n📋 Installation Details:'))
    console.log(colors.blue('Software: ') + colors.white(promptResult.name!))
    console.log(colors.blue('Inventory: ') + colors.white(inventory))
    if (softwareName === 'tidb') {
      console.log(colors.yellow(
        '\n⚠️ a few minutes to 10 minutes may be required for TiDB installation depending on your server performance.\n',
      ))
    }
    if (inventoryDisplay !== inventory) {
      console.log(
        colors.blue('Resolved IPs: ') + colors.white(inventoryDisplay),
      )
    }
    if (options.limit) {
      console.log(colors.blue('Limit: ') + colors.white(options.limit))
    }
    console.log(colors.blue('Playbook: ') + colors.white(filePath))

    const confirmation = await Confirm.prompt({
      message: 'Do you want to proceed with the installation?',
      default: false,
    })

    if (!confirmation) {
      console.log(colors.red('❌ Installation cancelled.'))
      return
    }

    console.log(colors.cyan('🔄 Starting installation...'))

    if (options.limit) {
      await runAnsibleV2(filePath, inventory, options.limit)
      endpointLog(accessTargets, promptResult.name as SoftwareComponent)
      return
    }
    await runAnsibleV2(filePath, inventory)
    endpointLog(accessTargets, promptResult.name as SoftwareComponent)
  })

const endpointLog = (targets: string[], component: SoftwareComponent) => {
  console.log(colors.green('\n✅ Installation completed successfully!\n'))
  console.log(colors.yellow('\n🌐 Access Information:\n'))
  if (targets.length === 1 && targets[0].includes(',')) {
    targets = [targets[0].replace(',', '')]
  }
  switch (component) {
    case 'Grafana':
      targets.forEach((target) => {
        console.log(colors.yellow(`Grafana URL: http://${target}:3000/login`))
      })
      console.log(colors.yellow('\n🔑 Default credentials'))
      console.log(colors.yellow('Username: admin'))
      console.log(colors.yellow('Password: admin'))
      break
    case 'Redis':
      targets.forEach((target) => {
        console.log(colors.yellow(`Redis Endpoint: redis://${target}:6379`))
      })
      break
    case 'TiDB (MySQL Cluster)':
      targets.forEach((target) => {
        console.log(
          colors.yellow(`TiDB Endpoint: ${target}:4000 (MySQL Protocol)\n`),
          colors.yellow(
            `Dashboard http://${target}:7301/dashboard/#/signin (HTTP Protocol)`,
          ),
        )
      })
      console.log(colors.yellow('\n🔑 Default credentials'))
      console.log(colors.yellow('Username: root'))
      console.log(colors.yellow('Password: <empty>'))
      break
    case 'Prometheus':
      targets.forEach((target) => {
        console.log(
          colors.yellow(`Prometheus URL: http://${target}:3090`),
        )
      })
      break
    case 'Node Exporter':
      targets.forEach((target) => {
        console.log(
          colors.yellow(`Node Exporter URL: http://${target}:9100/metrics`),
        )
      })
      break
    case 'Kafka Cluster':
      targets.forEach((target) => {
        console.log(
          colors.yellow(`Kafka Broker Endpoint: ${target}:9092`),
        )
        console.log(
          colors.yellow(`AKHQ UI: http://${target}:5000`),
        )
      })
      break
    default:
      console.log(
        colors.yellow(
          `Access details for ${component} will be provided soon.`,
        ),
      )
  }
}

/**
 * `slv install wireguard` — typed subcommand for the VPN setup path.
 * Kept separate from the main interactive Select because it needs
 * one specific option (--iphone-pubkey) that the other components
 * don't, and because non-engineers following the onboard flow need
 * to run this without understanding the general-purpose installer.
 *
 * After the playbook exits we read /tmp/slv-wg-server-pubkey.txt
 * (written by the playbook's export task, mode 0644) and display
 * the server public key prominently so the operator can paste it
 * back into their phone's WireGuard app.
 */
const wireguardCmd = new Command()
  .description(
    'Install a WireGuard VPN server (one-peer baseline) — prompts for the phone/peer public key, runs the ansible playbook, prints the resulting server public key so you can finish the peer config.',
  )
  .option(
    '--iphone-pubkey <key:string>',
    'WireGuard public key of the first peer (44 base64 chars ending in "="). Prompts interactively if omitted.',
  )
  .option(
    '-i, --inventory <string>',
    'Inventory — either a comma-separated IP list or path to an inventory YAML',
  )
  .option('-l, --limit <string>', 'Ansible --limit argument')
  .action(
    async (options: {
      iphonePubkey?: string
      inventory?: string
      limit?: string
    }) => {
      if (!options.inventory) {
        console.log(
          colors.yellow(
            '⚠️  No inventory specified. Use -i <ip> or -i <inventory.yml>.',
          ),
        )
        return
      }

      let iphonePubkey = (options.iphonePubkey ?? '').trim()
      if (!iphonePubkey) {
        iphonePubkey = (await Input.prompt({
          message:
            'Peer public key (from the WireGuard app on your phone — 44 chars ending in "=")',
        })).trim()
      }
      if (!WG_PUBKEY_RE.test(iphonePubkey)) {
        console.error(
          colors.red(
            '❌ Peer public key must be 44 base64 chars ending in "=" (e.g. generated by the WireGuard iOS / Android app).',
          ),
        )
        return
      }

      const templateRoot = getTemplatePath()
      const filePath =
        `${templateRoot}/ansible/cmn/software/install-wireguard.yaml`

      console.log(colors.blue('\n📋 WireGuard Install Details:'))
      console.log(colors.blue('  Inventory: ') + colors.white(options.inventory))
      if (options.limit) {
        console.log(colors.blue('  Limit:     ') + colors.white(options.limit))
      }
      console.log(colors.blue('  Playbook:  ') + colors.white(filePath))
      console.log(
        colors.blue('  Peer key:  ') + colors.white(maskPubkey(iphonePubkey)),
      )

      const ok = await Confirm.prompt({
        message: 'Proceed with WireGuard install?',
        default: true,
      })
      if (!ok) {
        console.log(colors.red('❌ Installation cancelled.'))
        return
      }

      // Best-effort cleanup of any stale export from a previous run;
      // we'll read this file immediately after the playbook to pick
      // up the fresh server public key.
      await Deno.remove(WG_PUBKEY_EXPORT_PATH).catch(() => {})

      const success = await runAnsibleV2(
        filePath,
        options.inventory,
        options.limit,
        { WG_IPHONE_PUBKEY: iphonePubkey },
      )
      if (!success) return

      await reportServerPubkey()
    },
  )

const maskPubkey = (key: string): string =>
  key.length <= 12 ? key : `${key.slice(0, 6)}…${key.slice(-6)}`

/**
 * Display the freshly-installed WireGuard server public key to the
 * operator. The playbook's `Export public key to user-readable path`
 * task writes it to /tmp/slv-wg-server-pubkey.txt with no trailing
 * newline. If the file is missing, it means the playbook failed
 * before that task — we fall back to a generic hint rather than
 * pretending success.
 */
const reportServerPubkey = async (): Promise<void> => {
  let serverPubkey = ''
  try {
    serverPubkey = (await Deno.readTextFile(WG_PUBKEY_EXPORT_PATH)).trim()
  } catch {
    console.log(
      colors.yellow(
        `\n⚠️  Could not read ${WG_PUBKEY_EXPORT_PATH} — the playbook may have failed before writing the server public key. Check the ansible output above.`,
      ),
    )
    return
  }
  if (!WG_PUBKEY_RE.test(serverPubkey)) {
    console.log(
      colors.yellow(
        `\n⚠️  ${WG_PUBKEY_EXPORT_PATH} didn't contain a valid 44-char pubkey (got ${serverPubkey.length} chars). Re-run with higher ansible verbosity.`,
      ),
    )
    return
  }
  console.log(colors.green('\n✅ WireGuard server ready.'))
  console.log(colors.yellow('\n🔑 Server public key — paste into your phone\'s WireGuard peer config:'))
  console.log(colors.bold.white(`\n    ${serverPubkey}\n`))
  console.log(
    colors.gray(
      '   Phone peer AllowedIPs: 10.0.0.0/24 (or 0.0.0.0/0 for full-tunnel).',
    ),
  )
  console.log(
    colors.gray(
      '   Server listens on UDP/51820. Open that port in your VPS firewall.\n',
    ),
  )
}

installCmd.command('wireguard', wireguardCmd)
