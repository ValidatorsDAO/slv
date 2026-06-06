import { Confirm, Input, prompt } from '@cliffy/prompt'
import { colors } from '@cliffy/colors'
import type { SolanaNodeType } from '@cmn/types/config.ts'

export interface XdpConfig {
  xdp_enabled?: boolean
  xdp_interface?: string
  xdp_cpu_cores?: number
  xdp_zero_copy?: boolean
  xdp_poh_pinned_cpu_core?: number
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

// XDP (eXpress Data Path) accelerates Turbine retransmit. Only Agave/Jito
// validators take these flags; Firedancer uses its own XDP path natively, so
// for those types we return an empty config and skip the prompt entirely.
const promptXdpConfig = async (
  validatorType: SolanaNodeType,
): Promise<XdpConfig> => {
  if (validatorType !== 'agave' && validatorType !== 'jito') {
    return {}
  }
  const { enable } = await prompt([{
    name: 'enable',
    message: '⚡ Enable XDP retransmit acceleration for this validator?',
    type: Confirm,
    default: true,
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
    },
    {
      name: 'cores',
      message: 'XDP retransmit CPU cores (count)',
      type: Input,
      default: '1',
    },
    {
      name: 'zeroCopy',
      message: 'Enable XDP zero-copy? (do NOT enable on bnxt_en / ice drivers)',
      type: Confirm,
      default: false,
    },
    {
      name: 'pohCore',
      message: 'PoH pinned CPU core (leave blank to skip)',
      type: Input,
      default: '',
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
  return cfg
}

export { promptXdpConfig }
