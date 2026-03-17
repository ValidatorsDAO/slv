import { Confirm, prompt, Select } from '@cliffy/prompt'
import { colors } from '@cliffy/colors'
import { selectNode } from '/src/metal/selectNode.ts'
import { metalRescue, metalRescueBack } from '/src/metal/api.ts'

const rescueAction = async () => {
  const selection = await selectNode()
  if (!selection) return false

  const { apiKey, ip, node } = selection

  console.log(colors.white(`\n🖥️  Node: ${node.productName || ip}`))
  console.log(colors.white(`📍 IP: ${ip}\n`))

  const enterRescue = '🛟 Enter rescue mode'
  const exitRescue = '🔙 Exit rescue mode'

  const { mode } = await prompt([
    {
      name: 'mode',
      message: '🛟 Select rescue mode action',
      type: Select,
      options: [enterRescue, exitRescue],
    },
  ])

  const isEnter = mode === enterRescue

  console.log('')
  if (isEnter) {
    console.log(colors.yellow('⚠️  Rescue mode will boot the node into a minimal recovery environment.'))
    console.log(colors.yellow('   The normal OS will not be accessible until you exit rescue mode.\n'))
  } else {
    console.log(colors.white('This will exit rescue mode and boot back into the normal OS.\n'))
  }

  const { confirmed } = await prompt([
    {
      name: 'confirmed',
      type: Confirm,
      message: isEnter
        ? colors.yellow('Enter rescue mode?')
        : 'Exit rescue mode and boot normally?',
      default: false,
    },
  ])

  if (!confirmed) {
    console.log(colors.yellow('🚫 Rescue action cancelled'))
    return false
  }

  const actionLabel = isEnter ? 'Entering rescue mode' : 'Exiting rescue mode'
  console.log(colors.cyan(`🛟 ${actionLabel}...`))

  try {
    const result = isEnter
      ? await metalRescue(apiKey, ip)
      : await metalRescueBack(apiKey, ip)

    if (result.success) {
      if (isEnter) {
        console.log(colors.green('✅ Rescue mode activated'))
        console.log(colors.white('Connect via SSH to access the recovery environment.'))
      } else {
        console.log(colors.green('✅ Rescue mode deactivated'))
        console.log(colors.white('The node will boot back into the normal OS.'))
      }
      return true
    }
    console.log(colors.red(`❌ Failed: ${result.message || 'Unknown error'}`))
    return false
  } catch (error) {
    console.log(colors.red('❌ Operation failed. Please try again later.'))
    return false
  }
}

export { rescueAction }
