import { Confirm } from '@cliffy/prompt'
import { colors } from '@cliffy/colors'
import type { InventoryType } from '@cmn/types/config.ts'
import { getTemplatePath } from '/lib/getTemplatePath.ts'
import { runAnsilbe } from '/lib/runAnsible.ts'

type OptimizeOptions = {
  inventoryType: InventoryType
  pubkey: string
  /** Skip the interactive confirmation. Default false. */
  skipConfirm?: boolean
  /** Override the amd_pstate mode passed to boost_performance.yml. */
  amdPstateMode?: 'active' | 'passive'
}

/**
 * Run pre-deploy node optimization: SMT disable + IRQ tune + CPU boost
 * (with kernel update on AMD nodes if needed). The orchestrator playbook
 * reboots the node when GRUB / kernel changes require it and waits for it
 * to come back online.
 *
 * Used by `slv v init` and `slv r init` after the inventory entry and the
 * solv user are in place — it touches the node before any validator/RPC
 * binaries are deployed.
 */
export const optimizeNode = async (
  opts: OptimizeOptions,
): Promise<boolean> => {
  console.log(
    colors.cyan(
      '\n🛠  Running node performance optimization (SMT off + IRQ tune + CPU boost + kernel update if needed)...',
    ),
  )
  console.log(
    colors.yellow(
      '⚠️  This step may install a newer kernel and reboot the node.',
    ),
  )

  if (!opts.skipConfirm) {
    const confirm = await Confirm.prompt({
      message:
        'Apply tuning now? (Reboot will happen automatically if required)',
      default: true,
    })
    if (!confirm) {
      console.log(colors.yellow('⏭  Skipping node optimization.'))
      return false
    }
  }

  const templateRoot = getTemplatePath()
  const playbook = `${templateRoot}/ansible/cmn/optimize_node.yml`
  const extraVars: Record<string, string> = {}
  if (opts.amdPstateMode) {
    extraVars.amd_pstate_mode = opts.amdPstateMode
  }

  const result = await runAnsilbe(
    playbook,
    opts.inventoryType,
    opts.pubkey,
    Object.keys(extraVars).length > 0 ? extraVars : undefined,
  )
  if (result) {
    console.log(
      colors.green('✅ Node optimization complete. Node is up and ready.'),
    )
    console.log(
      colors.gray(
        '💡 Verify boost is fully green with: slv check boost' +
          (opts.inventoryType.endsWith('_rpcs')
            ? ` -t rpc -n ${opts.inventoryType.split('_')[0]} -p ${opts.pubkey}`
            : ` -t validator -n ${opts.inventoryType.split('_')[0]} -p ${opts.pubkey}`),
      ),
    )
    return true
  }
  console.log(
    colors.red(
      '❌ Node optimization reported failures. Review the output above before deploying.',
    ),
  )
  return false
}
