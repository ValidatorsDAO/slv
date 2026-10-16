import { colors } from '@cliffy/colors'
import { Input, prompt, Select } from '@cliffy/prompt'
import type { InventoryType } from '@cmn/types/config.ts'
import {
  type AlpenglowReading,
  checkAlpenglowState,
  readAlpenglowState,
} from '/lib/alpenglowState.ts'
import { switchValidator } from '/src/validator/switch/switchValidator.ts'

type SwitchOptions = {
  from?: string
  to?: string
  network?: string
}

type SwitchDeps = {
  isTty: () => boolean
  /** The network chosen at the prompt, when -n was not given. */
  selectNetwork: () => Promise<string | undefined>
  /** One name typed at the prompt. */
  askName: (message: string) => Promise<string | undefined>
  /** True when the operator answers yes; the default answer is no. */
  confirm: (message: string) => Promise<boolean>
  /** The consensus the cluster runs, read the way alpenglow_state.yml reads it. */
  readState: (network: 'mainnet' | 'testnet') => Promise<AlpenglowReading>
  switchValidator: (
    inventoryType: InventoryType,
    from: string,
    to: string,
  ) => Promise<boolean>
  info: (line: string) => void
  warn: (line: string) => void
  error: (line: string) => void
  success: (line: string) => void
  setExitCode: (code: number) => void
}

const defaultSwitchDeps = (): SwitchDeps => ({
  isTty: () => Deno.stdin.isTerminal(),
  selectNetwork: async () => {
    const answer = await prompt([{
      name: 'network',
      message: 'Select Solana Network',
      type: Select,
      options: ['testnet', 'mainnet'],
      default: 'testnet',
    }])
    return answer.network
  },
  askName: async (message) => {
    const answer = await prompt([{ name: 'name', message, type: Input }])
    return answer.name
  },
  confirm: async (message) => {
    const answer = await prompt([{
      name: 'confirm',
      message,
      type: Select,
      options: ['yes', 'no'],
      default: 'no',
    }])
    return answer.confirm === 'yes'
  },
  readState: (network) => readAlpenglowState(network),
  switchValidator,
  info: (line) => console.log(colors.blue(line)),
  warn: (line) => console.log(colors.yellow(line)),
  error: (line) => console.error(colors.red(line)),
  success: (line) => console.log(colors.white(line)),
  setExitCode: (code) => {
    Deno.exitCode = code
  },
})

/**
 * `slv v switch`: the no-downtime migration of a validator identity from one
 * host to another. It needs a terminal, reads the consensus of the cluster and
 * waits in the migration window and when that cannot be read, all before a
 * playbook runs. Returns true when the switch ran and succeeded.
 */
const runSwitchCommand = async (
  options: SwitchOptions,
  overrides: Partial<SwitchDeps> = {},
): Promise<boolean> => {
  const deps: SwitchDeps = { ...defaultSwitchDeps(), ...overrides }
  const refuse = (message: string): false => {
    deps.error(`❌ ${message}`)
    deps.setExitCode(1)
    return false
  }

  if (!deps.isTty()) {
    return refuse(
      'slv v switch needs an interactive terminal; it will not run without one.',
    )
  }

  const network = options.network || (await deps.selectNetwork()) || 'testnet'
  if (network !== 'mainnet' && network !== 'testnet') {
    return refuse(
      `slv v switch supports -n mainnet or -n testnet, got "${network}".`,
    )
  }
  const inventoryType: InventoryType = network === 'mainnet'
    ? 'mainnet_validators'
    : 'testnet_validators'
  const networkString = network === 'mainnet' ? 'Mainnet' : 'Testnet'

  // Before a prompt about the hosts and before any playbook.
  const reading = await checkAlpenglowState(network, {
    read: deps.readState,
    info: deps.info,
    error: deps.error,
    setExitCode: deps.setExitCode,
  })
  if (reading === null) return false

  deps.info(`✨ Switching ${networkString} Validator Identity...`)
  const from = options.from || await deps.askName('From Validator Name')
  const to = options.to || await deps.askName('To Validator Name')
  const accepted = await deps.confirm(
    `Are you sure you want to switch ${networkString} Validator Identity from ${from} to ${to}?`,
  )
  if (!accepted) {
    deps.error('❌ Switch Cancelled')
    return false
  }
  if (!from || !to) {
    deps.warn('⚠️ From and To Validators are required')
    return false
  }
  deps.info(
    `✨ Switching ${networkString} Validator Identity from ${from} to ${to}...`,
  )
  const switched = await deps.switchValidator(inventoryType, from, to)
  if (switched) deps.success('✅ Successfully Switched Validator Identity')
  return switched
}

export { runSwitchCommand }
export type { SwitchDeps, SwitchOptions }
