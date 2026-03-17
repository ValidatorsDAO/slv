import { Confirm, prompt, Select } from '@cliffy/prompt'
import { colors } from '@cliffy/colors'
import { selectNode } from '/src/metal/selectNode.ts'
import { metalChangeRegion } from '/src/metal/api.ts'
import { REGIONS, REGION_LABELS } from '/src/metal/regions.ts'

const changeRegionAction = async () => {
  const selection = await selectNode()
  if (!selection) return false

  const { apiKey, ip, node } = selection
  const currentRegion = node.region || 'Unknown'

  console.log(colors.white(`\n🖥️  Node: ${node.productName || ip}`))
  console.log(colors.white(`📍 IP: ${ip}`))
  console.log(colors.white(`🌏 Current region: ${currentRegion}\n`))

  const regionOptions = REGIONS.map((r) => ({
    name: colors.white(REGION_LABELS[r]),
    value: r,
  }))

  const { newRegion } = await prompt([
    {
      name: 'newRegion',
      message: '🌏 Select new region',
      type: Select,
      options: regionOptions,
    },
  ])

  const label = REGION_LABELS[newRegion as keyof typeof REGION_LABELS] || newRegion

  const { confirmed } = await prompt([
    {
      name: 'confirmed',
      type: Confirm,
      message: colors.yellow(
        `Move node ${ip} from ${currentRegion} to ${label}?`,
      ),
      default: false,
    },
  ])

  if (!confirmed) {
    console.log(colors.yellow('🚫 Region change cancelled'))
    return false
  }

  console.log(colors.cyan('🌏 Changing region...'))
  try {
    const result = await metalChangeRegion(apiKey, ip, newRegion as string)
    if (result.success) {
      console.log(colors.green(`✅ Region change to ${label} initiated successfully`))
      console.log(colors.white('This may take some time. Check status with: slv metal status'))
      return true
    }
    console.log(colors.red(`❌ Failed to change region: ${result.message || 'Unknown error'}`))
    return false
  } catch (error) {
    console.log(colors.red('❌ Failed to change region. Please try again later.'))
    return false
  }
}

export { changeRegionAction }
