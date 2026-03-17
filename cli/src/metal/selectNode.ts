import { prompt, Select } from '@cliffy/prompt'
import { getApiKeyFromYml } from '/lib/getApiKeyFromYml.ts'
import { colors } from '@cliffy/colors'
import { metalStatus } from '/src/metal/api.ts'
import { extractSpecValue } from '/lib/extractSpecValue.ts'
import type { ServerStatusEnumType } from '@cmn/types/metal.ts'
import { serverStatusEmojiMap } from '@cmn/types/metal.ts'

export const selectNode = async () => {
  const apiKey = await getApiKeyFromYml()
  console.log(colors.cyan('🔍 Fetching your Bare Metal nodes...'))
  const result = await metalStatus(apiKey)
  if (!result.success) {
    console.log(colors.red('Failed to get nodes. Please try again later.'))
    return null
  }

  const nodes = result.message
  if (nodes.length === 0) {
    console.log(colors.yellow('⚠️ No Bare Metal nodes found'))
    return null
  }

  const options = nodes.map((node: any) => {
    const emoji =
      serverStatusEmojiMap[node.status as ServerStatusEnumType] || '❓'
    const region = extractSpecValue(node.description, 'Region') || node.region || 'Unknown'
    let name = `${node.productName} - 🌏 ${region} - ${emoji} ${node.status}`
    if (node.ip) name += ` - ${node.ip}`
    return {
      name: colors.white(name),
      value: node.ip,
    }
  })

  const { nodeIP } = await prompt([
    {
      name: 'nodeIP',
      message: '⚔️ Select a Bare Metal node',
      type: Select,
      options,
    },
  ])

  const selected = nodes.find((n: any) => n.ip === nodeIP)
  return { apiKey, node: selected, ip: nodeIP as string }
}
