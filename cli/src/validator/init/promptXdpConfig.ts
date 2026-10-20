import { Confirm, Input, prompt } from '@cliffy/prompt'
import { colors } from '@cliffy/colors'
import type { NetworkType, SolanaNodeType } from '@cmn/types/config.ts'

export interface XdpConfig {
  xdp_enabled?: boolean
  xdp_interface?: string
  xdp_cpu_cores?: number
  xdp_zero_copy?: boolean
  xdp_poh_pinned_cpu_core?: number
}

export const validateXdpConfig = (
  validatorType: SolanaNodeType,
  network: NetworkType,
  config: XdpConfig,
): XdpConfig => {
  if (!config.xdp_zero_copy) return config
  // Preserve the existing Agave/Jito XDP contract. The stricter mainnet-only
  // zero-copy boundary is specific to the new Allnodes-Jito source path.
  if (validatorType !== 'allnodes-jito') return config
  if (network !== 'mainnet') {
    throw new Error('XDP zero-copy is only supported for mainnet')
  }
  if (!config.xdp_enabled || !config.xdp_interface?.trim()) {
    throw new Error(
      'XDP zero-copy requires XDP to be enabled with an explicit interface',
    )
  }
  const xdpCpuCores = config.xdp_cpu_cores
  if (
    typeof xdpCpuCores !== 'number' ||
    !Number.isInteger(xdpCpuCores) ||
    xdpCpuCores < 1
  ) {
    throw new Error('XDP zero-copy requires a positive XDP CPU allocation')
  }
  const pohCpuCore = config.xdp_poh_pinned_cpu_core
  if (
    typeof pohCpuCore !== 'number' ||
    !Number.isInteger(pohCpuCore) ||
    pohCpuCore < xdpCpuCores
  ) {
    throw new Error('XDP zero-copy requires a disjoint PoH CPU declaration')
  }
  return config
}

// Parses a non-negative integer from prompt input, or returns `fallback` when
// the input is blank or not a valid integer. Prevents NaN/garbage from reaching
// the inventory (and the validator launch flags) on a fat-fingered entry.
const parseNonNegativeInt = (
  raw: unknown,
  fallback: number | null,
): number | null => {
  const s = String(raw ?? '').trim()
  if (!s) return fallback
  const n = Number(s)
  if (!Number.isInteger(n) || n < 0) {
    console.log(
      colors.yellow(`⚠️ "${s}" is not a valid non-negative integer — ignored.`),
    )
    return fallback
  }
  return n
}

// XDP (eXpress Data Path) accelerates Turbine retransmit. Firedancer uses its
// own XDP path natively, so for those types we return an empty config and skip
// the prompt entirely.
const promptXdpConfig = async (
  validatorType: SolanaNodeType,
  network: NetworkType = 'mainnet',
  defaults: XdpConfig = {},
): Promise<XdpConfig> => {
  if (
    validatorType !== 'agave' &&
    validatorType !== 'jito' &&
    validatorType !== 'allnodes-jito'
  ) {
    return {}
  }
  const { enable } = await prompt([{
    name: 'enable',
    message: '⚡ Enable XDP retransmit acceleration for this validator?',
    type: Confirm,
    default: defaults.xdp_enabled ?? true,
  }])
  if (!enable) {
    return { xdp_enabled: false }
  }
  console.log(colors.yellow(
    '⚠️ XDP requires a recent kernel (6.8+, igb driver needs 6.14+) and grants\n' +
      '   the validator CAP_NET_RAW/CAP_NET_ADMIN/CAP_BPF/CAP_PERFMON via systemd.',
  ))
  const answers = await prompt([
    {
      name: 'iface',
      message: 'XDP network interface (bond member NIC, e.g. enp196s0f0np0)',
      type: Input,
      default: defaults.xdp_interface ?? '',
    },
    {
      name: 'cores',
      message: 'XDP CPU setting (4.4+: CPU ID; earlier clients: worker count)',
      type: Input,
      default: String(defaults.xdp_cpu_cores ?? 1),
    },
    {
      name: 'zeroCopy',
      message: 'Enable XDP zero-copy? (do NOT enable on bnxt_en / ice drivers)',
      type: Confirm,
      default: defaults.xdp_zero_copy ?? false,
    },
    {
      name: 'pohCore',
      message: 'PoH pinned CPU core (leave blank to skip)',
      type: Input,
      default: defaults.xdp_poh_pinned_cpu_core === undefined
        ? ''
        : String(defaults.xdp_poh_pinned_cpu_core),
    },
  ])
  const iface = String(answers.iface || '').trim()
  if (!iface) {
    console.log(
      colors.yellow('⚠️ No interface given — disabling XDP for this host.'),
    )
    return { xdp_enabled: false }
  }
  const cfg: XdpConfig = {
    xdp_enabled: true,
    xdp_interface: iface,
    xdp_cpu_cores: parseNonNegativeInt(answers.cores, 1) ?? 1,
    xdp_zero_copy: Boolean(answers.zeroCopy),
  }
  const poh = parseNonNegativeInt(answers.pohCore, null)
  if (poh !== null) {
    cfg.xdp_poh_pinned_cpu_core = poh
  }
  return validateXdpConfig(validatorType, network, cfg)
}

export { promptXdpConfig }
