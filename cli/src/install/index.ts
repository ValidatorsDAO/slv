import { Command } from '@cliffy'
import { Confirm, prompt, Select } from '@cliffy/prompt'
import { colors } from '@cliffy/colors'
import { runAnsibleV2 } from '/lib/runAnsibleV2.ts'
import { getTemplatePath } from '/lib/getTemplatePath.ts'
import {
  isInventoryFilePath,
  resolveIpsFromInventoryFile,
} from '/src/install/inventoryTargets.ts'

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
    endpointLog(accessTargets, promptResult.name as SoftwareComponent)
    const filePath =
      `${templateRoot}/ansible/cmn/software/install-${softwareName}.yml`
    console.log(colors.blue('\n📋 Installation Details:'))
    console.log(colors.blue('Software: ') + colors.white(promptResult.name!))
    console.log(colors.blue('Inventory: ') + colors.white(inventory))
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
