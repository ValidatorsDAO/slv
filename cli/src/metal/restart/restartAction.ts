import { Confirm, prompt } from '@cliffy/prompt'
import { colors } from '@cliffy/colors'
import { selectNode } from '/src/metal/selectNode.ts'
import { metalRestart } from '/src/metal/api.ts'

const restartAction = async () => {
  const selection = await selectNode()
  if (!selection) return false

  const { apiKey, ip, node } = selection

  console.log(colors.white(`\n🖥️  Node: ${node.productName || ip}`))
  console.log(colors.white(`📍 IP: ${ip}\n`))

  const { confirmed } = await prompt([
    {
      name: 'confirmed',
      type: Confirm,
      message: colors.yellow('⚠️ Are you sure you want to restart this node?'),
      default: false,
    },
  ])

  if (!confirmed) {
    console.log(colors.yellow('🚫 Restart cancelled'))
    return false
  }

  console.log(colors.cyan('🔄 Restarting node...'))
  try {
    const result = await metalRestart(apiKey, ip)
    if (result.success) {
      console.log(colors.green('✅ Restart initiated successfully'))
      console.log(colors.white('The node will be back online shortly.'))
      return true
    }
    console.log(colors.red(`❌ Failed to restart: ${result.message || 'Unknown error'}`))
    return false
  } catch (error) {
    console.log(colors.red('❌ Failed to restart node. Please try again later.'))
    return false
  }
}

export { restartAction }
