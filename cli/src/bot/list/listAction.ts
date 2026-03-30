import { colors } from '@cliffy/colors'
import { Row, Table } from '@cliffy/table'
import { listBotConfigs } from '/src/bot/botConfig.ts'

const listAction = async () => {
  const configs = await listBotConfigs()

  if (configs.length === 0) {
    console.log(
      colors.yellow('⚠️ No deployed bots found. Run `slv bot deploy` first.'),
    )
    return false
  }

  const header = Row.from(
    ['Name', 'IP', 'Service', 'Remote Path', 'Deployed At'].map((h) =>
      colors.cyan(h)
    ),
  )

  const rows = configs.map((c) =>
    Row.from([
      c.name,
      c.ip,
      c.serviceName,
      c.remotePath,
      c.deployedAt,
    ])
  )

  const table = new Table()
    .header(header)
    .body(rows)
    .border()
    .padding(1)

  table.render()
  return true
}

export { listAction }
