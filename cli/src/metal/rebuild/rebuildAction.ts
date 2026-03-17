import { Confirm, Input, prompt } from '@cliffy/prompt'
import { colors } from '@cliffy/colors'
import { selectNode } from '/src/metal/selectNode.ts'
import { metalRebuild } from '/src/metal/api.ts'

const rebuildAction = async () => {
  const selection = await selectNode()
  if (!selection) return false

  const { apiKey, ip, node } = selection

  console.log(colors.white(`\n🖥️  Node: ${node.productName || ip}`))
  console.log(colors.white(`📍 IP: ${ip}\n`))

  // First confirmation
  console.log(colors.red('═══════════════════════════════════════════════════'))
  console.log(colors.red('⚠️  WARNING: DESTRUCTIVE OPERATION'))
  console.log(colors.red('═══════════════════════════════════════════════════'))
  console.log(colors.red('This will completely wipe and reinstall the OS.'))
  console.log(colors.red('ALL DATA WILL BE PERMANENTLY LOST.'))
  console.log(colors.red('═══════════════════════════════════════════════════\n'))

  const { confirmed } = await prompt([
    {
      name: 'confirmed',
      type: Confirm,
      message: colors.red('Do you understand that all data will be lost?'),
      default: false,
    },
  ])

  if (!confirmed) {
    console.log(colors.yellow('🚫 Rebuild cancelled'))
    return false
  }

  // Second confirmation — type IP to confirm
  const { confirmIp } = await prompt([
    {
      name: 'confirmIp',
      type: Input,
      message: colors.red(`Type the IP address (${ip}) to confirm rebuild`),
    },
  ])

  if (confirmIp !== ip) {
    console.log(colors.yellow('🚫 IP address does not match. Rebuild cancelled.'))
    return false
  }

  console.log(colors.cyan('🏭 Rebuilding OS...'))
  try {
    const result = await metalRebuild(apiKey, ip)
    if (result.success) {
      console.log(colors.green('✅ Rebuild initiated successfully'))
      console.log(colors.white('The node will be reprovisioned. This may take several minutes.'))
      console.log(colors.white('Check status with: slv metal status'))
      return true
    }
    console.log(colors.red(`❌ Failed to rebuild: ${result.message || 'Unknown error'}`))
    return false
  } catch (error) {
    console.log(colors.red('❌ Failed to rebuild node. Please try again later.'))
    return false
  }
}

export { rebuildAction }
