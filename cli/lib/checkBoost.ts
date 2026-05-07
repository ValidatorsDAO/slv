// CPU performance boost diagnostics — Deno port of master-api's
// performanceCheckRouter.ts.  Used by `slv check boost`.

import { colors } from '@cliffy/colors'
import type { InventoryType } from '@cmn/types/config.ts'
import { getInventoryPath } from '@cmn/constants/path.ts'

// ── CPU Catalog ──────────────────────────────────────────────────────────────

type CpuCatalogEntry = { model: string; maxBoostMhz: number }

const CPU_CATALOG: CpuCatalogEntry[] = [
  // AMD EPYC
  { model: '9654', maxBoostMhz: 3700 },
  { model: '9554', maxBoostMhz: 3750 },
  { model: '9454', maxBoostMhz: 3800 },
  { model: '9354', maxBoostMhz: 3800 },
  { model: '9254', maxBoostMhz: 4150 },
  { model: '9174F', maxBoostMhz: 4100 },
  { model: '9124', maxBoostMhz: 3700 },
  { model: '7763', maxBoostMhz: 3500 },
  { model: '7713', maxBoostMhz: 3675 },
  { model: '7543', maxBoostMhz: 3700 },
  { model: '7443', maxBoostMhz: 4000 },
  { model: '7413', maxBoostMhz: 3600 },
  { model: '75F3', maxBoostMhz: 4000 },
  { model: '7B13', maxBoostMhz: 3050 },
  { model: '4584PX', maxBoostMhz: 4200 },
  { model: '9474F', maxBoostMhz: 4100 },
  { model: '9374F', maxBoostMhz: 4300 },
  { model: '9274F', maxBoostMhz: 4050 },
  // AMD Ryzen
  { model: '9950X', maxBoostMhz: 5700 },
  { model: '9900X', maxBoostMhz: 5600 },
  { model: '7950X', maxBoostMhz: 5700 },
  { model: '7900X', maxBoostMhz: 5600 },
]

export function normalizeCpuModel(raw: string): string {
  const epyc = raw.match(/EPYC\s+(\S+)/i)
  if (epyc) return epyc[1]
  const ryzen = raw.match(/Ryzen\s+\d+\s+(\S+)/i)
  if (ryzen) return ryzen[1]
  return raw.trim()
}

export function lookupCatalog(
  normalizedModel: string,
): CpuCatalogEntry | undefined {
  return CPU_CATALOG.find(
    (e) => e.model.toLowerCase() === normalizedModel.toLowerCase(),
  )
}

// ── Types ────────────────────────────────────────────────────────────────────

export type CheckStatus = 'PASS' | 'FAIL' | 'WARN' | 'N/A'
export type CheckCategory =
  | 'OS'
  | 'BIOS'
  | 'CONTROL_PLANE'
  | 'RUNTIME'
  | 'INFO'
export type OverallStatus = 'OK' | 'WARN' | 'NG'

const STATUS_ICON: Record<CheckStatus, string> = {
  PASS: '✅',
  FAIL: '❌',
  WARN: '⚠️',
  'N/A': '➖',
}

export type CheckResult = {
  title: string
  cmd: string
  expected: string
  observed: string
  status: CheckStatus
  icon: string
  message: string
  category: CheckCategory
  blocksBoostCompletion: boolean
}

export type BoostCompletionBlocker = {
  title: string
  status: Exclude<CheckStatus, 'PASS' | 'N/A'>
  category: CheckCategory
  message: string
}

export type BoostCompletion = {
  completed: boolean
  summary: string
  blockers: BoostCompletionBlocker[]
}

type RawCommandResult = {
  cmd: string
  stdout: string
  stderr: string
  rc: number
}

export type PerformanceAssessment = {
  overallStatus: OverallStatus
  boostCompletion: BoostCompletion
}

// ── Evaluators (1:1 port of master-api) ──────────────────────────────────────

function fileNotFound(raw: RawCommandResult): boolean {
  const combined = `${raw.stdout} ${raw.stderr}`.toLowerCase()
  return (
    (raw.rc !== 0 || !raw.stdout.trim()) &&
    (combined.includes('no such file') ||
      combined.includes('not found') ||
      combined.includes('cannot open') ||
      combined.includes('permission denied') ||
      (raw.rc !== 0 && !raw.stdout.trim()))
  )
}

function buildCheckResult(input: Omit<CheckResult, 'icon'>): CheckResult {
  return { ...input, icon: STATUS_ICON[input.status] }
}

export function evaluateEpp(
  raw: RawCommandResult,
  scalingDriver?: string,
): CheckResult {
  const cmd = 'cat /sys/devices/system/cpu/cpu0/cpufreq/energy_performance_preference'
  if (fileNotFound(raw)) {
    const usingAcpi = scalingDriver && /acpi[-_]cpufreq/i.test(scalingDriver)
    if (usingAcpi) {
      return buildCheckResult({
        title: 'EPP',
        cmd,
        expected: 'performance',
        observed: 'N/A',
        status: 'WARN',
        message:
          'EPP is unavailable because the host is using acpi-cpufreq. Switch to amd_pstate for full control.',
        category: 'CONTROL_PLANE',
        blocksBoostCompletion: true,
      })
    }
    return buildCheckResult({
      title: 'EPP',
      cmd,
      expected: 'performance',
      observed: 'N/A',
      status: 'N/A',
      message: 'EPP sysfs file not found (driver may not support EPP).',
      category: 'INFO',
      blocksBoostCompletion: false,
    })
  }
  const observed = raw.stdout.trim()
  const pass = observed === 'performance'
  return buildCheckResult({
    title: 'EPP',
    cmd,
    expected: 'performance',
    observed,
    status: pass ? 'PASS' : 'FAIL',
    message: pass
      ? 'EPP is set to performance (best for low latency).'
      : 'EPP is not performance. OS-side power policy is still limiting turbo responsiveness.',
    category: pass ? 'INFO' : 'OS',
    blocksBoostCompletion: !pass,
  })
}

export function evaluateGovernorCpu0(raw: RawCommandResult): CheckResult {
  const cmd = 'cat /sys/devices/system/cpu/cpu0/cpufreq/scaling_governor'
  if (fileNotFound(raw)) {
    return buildCheckResult({
      title: 'Governor (cpu0)',
      cmd,
      expected: 'performance',
      observed: 'N/A',
      status: 'WARN',
      message: 'Governor sysfs file not found.',
      category: 'OS',
      blocksBoostCompletion: true,
    })
  }
  const observed = raw.stdout.trim()
  const pass = observed === 'performance'
  return buildCheckResult({
    title: 'Governor (cpu0)',
    cmd,
    expected: 'performance',
    observed,
    status: pass ? 'PASS' : 'FAIL',
    message: pass
      ? 'Governor is set to performance.'
      : `Governor is ${observed}, expected performance.`,
    category: pass ? 'INFO' : 'OS',
    blocksBoostCompletion: !pass,
  })
}

export function evaluateAmdPstate(
  raw: RawCommandResult,
  cpuModelRaw?: string,
): CheckResult {
  const cmd = 'cat /sys/devices/system/cpu/amd_pstate/status'
  const isAmd = cpuModelRaw ? /epyc|amd|ryzen/i.test(cpuModelRaw) : false
  if (fileNotFound(raw)) {
    if (isAmd) {
      return buildCheckResult({
        title: 'amd_pstate status',
        cmd,
        expected: 'active or passive',
        observed: 'N/A',
        status: 'WARN',
        message:
          'amd_pstate sysfs is missing on an AMD host. Control plane is incomplete until amd_pstate driver is loaded.',
        category: 'CONTROL_PLANE',
        blocksBoostCompletion: true,
      })
    }
    return buildCheckResult({
      title: 'amd_pstate status',
      cmd,
      expected: 'active or passive',
      observed: 'N/A',
      status: 'N/A',
      message: 'amd_pstate sysfs not found (non-AMD or driver not loaded).',
      category: 'INFO',
      blocksBoostCompletion: false,
    })
  }
  const observed = raw.stdout.trim()
  const pass = observed === 'active' || observed === 'passive'
  return buildCheckResult({
    title: 'amd_pstate status',
    cmd,
    expected: 'active or passive',
    observed,
    status: pass ? 'PASS' : 'FAIL',
    message: pass
      ? `amd_pstate is ${observed}.`
      : `amd_pstate is ${observed}, expected active or passive.`,
    category: pass ? 'INFO' : 'OS',
    blocksBoostCompletion: !pass,
  })
}

export function evaluateBoostLscpu(raw: RawCommandResult): CheckResult {
  const cmd = 'lscpu | grep -i boost'
  const observed = raw.stdout.trim()
  if (!observed) {
    return buildCheckResult({
      title: 'Boost (lscpu)',
      cmd,
      expected: 'enabled',
      observed: 'N/A',
      status: 'WARN',
      message: 'No boost information found in lscpu output.',
      category: 'CONTROL_PLANE',
      blocksBoostCompletion: true,
    })
  }
  const pass = observed.toLowerCase().includes('enabled')
  return buildCheckResult({
    title: 'Boost (lscpu)',
    cmd,
    expected: 'enabled',
    observed,
    status: pass ? 'PASS' : 'FAIL',
    message: pass ? 'CPU frequency boost is enabled.' : 'CPU frequency boost is not enabled.',
    category: pass ? 'INFO' : 'OS',
    blocksBoostCompletion: !pass,
  })
}

export function evaluateCpuidle(raw: RawCommandResult): CheckResult {
  const cmd = 'grep . /sys/devices/system/cpu/cpu0/cpuidle/state*/disable'
  if (fileNotFound(raw)) {
    return buildCheckResult({
      title: 'C-States (cpuidle)',
      cmd,
      expected: 'all disabled (1) or no cpuidle support',
      observed: 'N/A (cpuidle sysfs not found)',
      status: 'PASS',
      message: 'cpuidle sysfs not found — C-states are not exposed.',
      category: 'INFO',
      blocksBoostCompletion: false,
    })
  }
  const observed = raw.stdout.trim()
  const hasZero = observed.split('\n').some((line) => line.endsWith(':0'))
  return buildCheckResult({
    title: 'C-States (cpuidle)',
    cmd,
    expected: 'all disabled (1)',
    observed,
    status: hasZero ? 'FAIL' : 'PASS',
    message: hasZero
      ? 'Some C-states are enabled (value 0). Disable them for best latency.'
      : 'All C-states are disabled.',
    category: hasZero ? 'OS' : 'INFO',
    blocksBoostCompletion: hasZero,
  })
}

export function evaluateCpufreqDriver(
  raw: RawCommandResult,
  cpuModelRaw?: string,
): CheckResult {
  const cmd = 'cat /sys/devices/system/cpu/cpu0/cpufreq/scaling_driver'
  const observed = raw.stdout.trim()
  if (!observed || fileNotFound(raw)) {
    return buildCheckResult({
      title: 'cpufreq driver',
      cmd,
      expected: '(info)',
      observed: 'N/A',
      status: 'WARN',
      message: 'Could not determine cpufreq driver.',
      category: 'OS',
      blocksBoostCompletion: true,
    })
  }
  const isAmd = cpuModelRaw ? /epyc|amd|ryzen/i.test(cpuModelRaw) : false
  const isOptimalAmdDriver = /^amd[-_]pstate/i.test(observed)
  if (isAmd && !isOptimalAmdDriver) {
    return buildCheckResult({
      title: 'cpufreq driver',
      cmd,
      expected: 'amd-pstate / amd-pstate-epp',
      observed,
      status: 'WARN',
      message:
        `cpufreq driver is "${observed}" on AMD. Real clocks may still be high but fine-grained control is incomplete until amd-pstate is used.`,
      category: 'CONTROL_PLANE',
      blocksBoostCompletion: true,
    })
  }
  return buildCheckResult({
    title: 'cpufreq driver',
    cmd,
    expected: '(info)',
    observed,
    status: 'PASS',
    message: `cpufreq driver: ${observed}`,
    category: 'INFO',
    blocksBoostCompletion: false,
  })
}

export function evaluateCpuinfoMaxFreq(
  raw: RawCommandResult,
  cpuModelRaw: string,
): CheckResult {
  const cmd = 'cat /sys/devices/system/cpu/cpu0/cpufreq/cpuinfo_max_freq'
  const observed = raw.stdout.trim()
  if (!observed || fileNotFound(raw)) {
    return buildCheckResult({
      title: 'cpuinfo_max_freq',
      cmd,
      expected: '(hardware max frequency)',
      observed: 'N/A',
      status: 'WARN',
      message: 'Could not read cpuinfo_max_freq.',
      category: 'CONTROL_PLANE',
      blocksBoostCompletion: true,
    })
  }
  const observedKhz = parseInt(observed, 10)
  if (isNaN(observedKhz) || observedKhz <= 0) {
    return buildCheckResult({
      title: 'cpuinfo_max_freq',
      cmd,
      expected: '(parseable value)',
      observed,
      status: 'WARN',
      message: `Could not parse cpuinfo_max_freq value: "${observed}".`,
      category: 'CONTROL_PLANE',
      blocksBoostCompletion: true,
    })
  }
  const normalizedModel = normalizeCpuModel(cpuModelRaw)
  const catalog = lookupCatalog(normalizedModel)
  if (!catalog) {
    return buildCheckResult({
      title: 'cpuinfo_max_freq',
      cmd,
      expected: `catalog missing for ${normalizedModel}`,
      observed: `${observedKhz} kHz`,
      status: 'N/A',
      message: `CPU catalog missing for "${normalizedModel}". Recorded max is ${observedKhz} kHz.`,
      category: 'INFO',
      blocksBoostCompletion: false,
    })
  }
  const expectedKhz = catalog.maxBoostMhz * 1000
  const pass = observedKhz >= expectedKhz * 0.98
  return buildCheckResult({
    title: 'cpuinfo_max_freq',
    cmd,
    expected: `>= ${expectedKhz} kHz (${catalog.maxBoostMhz} MHz * 0.98)`,
    observed: `${observedKhz} kHz`,
    status: pass ? 'PASS' : 'WARN',
    message: pass
      ? `cpuinfo_max_freq ${observedKhz} kHz is within turbo range for ${normalizedModel}.`
      : `cpuinfo_max_freq ${observedKhz} kHz is below catalog turbo (${expectedKhz} kHz) for ${normalizedModel}. This points to a BIOS/firmware-level ceiling.`,
    category: pass ? 'INFO' : 'BIOS',
    blocksBoostCompletion: !pass,
  })
}

export function evaluateScalingMaxFreq(
  raw: RawCommandResult,
  cpuModelRaw: string,
  cpuinfoMaxFreqKhz?: number,
): CheckResult {
  const cmd = 'cat /sys/devices/system/cpu/cpu*/cpufreq/scaling_max_freq | sort -u'
  const observed = raw.stdout.trim()
  if (!observed || fileNotFound(raw)) {
    return buildCheckResult({
      title: 'scaling_max_freq',
      cmd,
      expected: '(turbo range)',
      observed: 'N/A',
      status: 'WARN',
      message: 'Could not read scaling_max_freq.',
      category: 'OS',
      blocksBoostCompletion: true,
    })
  }
  const lines = observed.split('\n').filter(Boolean)
  if (lines.length > 1) {
    return buildCheckResult({
      title: 'scaling_max_freq',
      cmd,
      expected: 'uniform across all CPUs',
      observed,
      status: 'FAIL',
      message: `Multiple distinct scaling_max_freq values found (${lines.length}).`,
      category: 'OS',
      blocksBoostCompletion: true,
    })
  }
  const observedKhz = parseInt(lines[0], 10)
  if (isNaN(observedKhz) || observedKhz <= 0) {
    return buildCheckResult({
      title: 'scaling_max_freq',
      cmd,
      expected: '(valid frequency)',
      observed: lines[0],
      status: 'WARN',
      message: `Could not parse scaling_max_freq value: "${lines[0]}".`,
      category: 'OS',
      blocksBoostCompletion: true,
    })
  }
  const normalizedModel = normalizeCpuModel(cpuModelRaw)
  const catalog = lookupCatalog(normalizedModel)
  if (cpuinfoMaxFreqKhz && cpuinfoMaxFreqKhz > 0) {
    if (observedKhz >= cpuinfoMaxFreqKhz * 0.98) {
      const biosLimited = catalog &&
        cpuinfoMaxFreqKhz < catalog.maxBoostMhz * 1000 * 0.98
      return buildCheckResult({
        title: 'scaling_max_freq',
        cmd,
        expected: `>= ${cpuinfoMaxFreqKhz} kHz (cpuinfo_max_freq * 0.98)`,
        observed: `${observedKhz} kHz`,
        status: 'PASS',
        message: biosLimited
          ? `scaling_max_freq ${observedKhz} kHz matches the hardware-reported max (${cpuinfoMaxFreqKhz} kHz). OS-side tuning is correct; any remaining ceiling is BIOS/firmware.`
          : `scaling_max_freq ${observedKhz} kHz matches hardware max.`,
        category: 'INFO',
        blocksBoostCompletion: false,
      })
    }
    return buildCheckResult({
      title: 'scaling_max_freq',
      cmd,
      expected: `>= ${cpuinfoMaxFreqKhz} kHz (cpuinfo_max_freq * 0.98)`,
      observed: `${observedKhz} kHz`,
      status: 'FAIL',
      message:
        `scaling_max_freq ${observedKhz} kHz is below hardware max (${cpuinfoMaxFreqKhz} kHz). OS-side max-frequency limit is in place.`,
      category: 'OS',
      blocksBoostCompletion: true,
    })
  }
  if (!catalog) {
    const suspiciouslyLow = observedKhz < 1_000_000
    return buildCheckResult({
      title: 'scaling_max_freq',
      cmd,
      expected: `catalog missing for ${normalizedModel}`,
      observed: `${observedKhz} kHz`,
      status: suspiciouslyLow ? 'WARN' : 'PASS',
      message: suspiciouslyLow
        ? `CPU catalog missing for "${normalizedModel}". Observed ${observedKhz} kHz is suspiciously low.`
        : `CPU catalog missing for "${normalizedModel}". Observed ${observedKhz} kHz.`,
      category: suspiciouslyLow ? 'CONTROL_PLANE' : 'INFO',
      blocksBoostCompletion: suspiciouslyLow,
    })
  }
  const expectedKhz = catalog.maxBoostMhz * 1000
  const pass = observedKhz >= expectedKhz * 0.98
  return buildCheckResult({
    title: 'scaling_max_freq',
    cmd,
    expected: `>= ${expectedKhz} kHz (${catalog.maxBoostMhz} MHz * 0.98)`,
    observed: `${observedKhz} kHz`,
    status: pass ? 'PASS' : 'FAIL',
    message: pass
      ? `scaling_max_freq ${observedKhz} kHz is within turbo range for ${normalizedModel}.`
      : `scaling_max_freq ${observedKhz} kHz is below 98% of expected turbo (${expectedKhz} kHz) for ${normalizedModel}.`,
    category: pass ? 'INFO' : 'OS',
    blocksBoostCompletion: !pass,
  })
}

export function evaluateCpupowerInfo(raw: RawCommandResult): CheckResult {
  const cmd = "cpupower frequency-info | egrep -i 'driver:|hardware limits:|...'"
  const observed = raw.stdout.trim()
  if (!observed || fileNotFound(raw)) {
    return buildCheckResult({
      title: 'cpupower frequency-info',
      cmd,
      expected: '(info)',
      observed: 'N/A',
      status: 'WARN',
      message: 'Could not retrieve cpupower frequency-info.',
      category: 'CONTROL_PLANE',
      blocksBoostCompletion: true,
    })
  }
  const lower = observed.toLowerCase()
  const hasSupportedYes = lower.includes('supported: yes')
  const hasActiveNo = lower.includes('active: no')
  const warn = hasSupportedYes && hasActiveNo
  return buildCheckResult({
    title: 'cpupower frequency-info',
    cmd,
    expected: '(info)',
    observed,
    status: warn ? 'WARN' : 'PASS',
    message: warn
      ? 'Boost is supported but not active. OS-side turbo enablement is incomplete.'
      : 'cpupower frequency-info collected.',
    category: warn ? 'OS' : 'INFO',
    blocksBoostCompletion: warn,
  })
}

export function evaluateGovernorAll(raw: RawCommandResult): CheckResult {
  const cmd = 'cat /sys/devices/system/cpu/cpu*/cpufreq/scaling_governor | sort -u'
  if (fileNotFound(raw)) {
    return buildCheckResult({
      title: 'Governor (all CPUs)',
      cmd,
      expected: 'performance (uniform)',
      observed: 'N/A',
      status: 'WARN',
      message: 'Governor sysfs not found.',
      category: 'OS',
      blocksBoostCompletion: true,
    })
  }
  const observed = raw.stdout.trim()
  const lines = observed.split('\n').filter(Boolean)
  const allPerf = lines.length === 1 && lines[0] === 'performance'
  return buildCheckResult({
    title: 'Governor (all CPUs)',
    cmd,
    expected: 'performance (uniform)',
    observed,
    status: allPerf ? 'PASS' : 'FAIL',
    message: allPerf
      ? 'All CPUs have governor set to performance.'
      : lines.length > 1
      ? `Multiple governor values: ${lines.join(', ')}. Expected uniform "performance".`
      : `Governor is "${lines[0]}", expected "performance".`,
    category: allPerf ? 'INFO' : 'OS',
    blocksBoostCompletion: !allPerf,
  })
}

export function evaluateBoostSysfs(raw: RawCommandResult): CheckResult {
  const cmd = 'cat /sys/devices/system/cpu/cpufreq/boost'
  if (fileNotFound(raw)) {
    return buildCheckResult({
      title: 'Boost (sysfs)',
      cmd,
      expected: '1',
      observed: 'N/A',
      status: 'WARN',
      message: 'Boost sysfs file not found.',
      category: 'CONTROL_PLANE',
      blocksBoostCompletion: true,
    })
  }
  const observed = raw.stdout.trim()
  const pass = observed === '1'
  return buildCheckResult({
    title: 'Boost (sysfs)',
    cmd,
    expected: '1',
    observed,
    status: pass ? 'PASS' : 'FAIL',
    message: pass
      ? 'CPU boost is enabled (sysfs).'
      : 'CPU boost is not enabled (sysfs).',
    category: pass ? 'INFO' : 'OS',
    blocksBoostCompletion: !pass,
  })
}

export function evaluateCpuMhz(
  raw: RawCommandResult,
  cpuModelRaw: string,
): CheckResult {
  const cmd = "grep 'cpu MHz' /proc/cpuinfo"
  if (fileNotFound(raw) || !raw.stdout.trim()) {
    return buildCheckResult({
      title: 'CPU MHz (actual)',
      cmd,
      expected: '(max core above 50% of max boost)',
      observed: 'N/A',
      status: 'WARN',
      message: 'Could not read actual CPU MHz from /proc/cpuinfo.',
      category: 'RUNTIME',
      blocksBoostCompletion: true,
    })
  }
  const normalizedModel = normalizeCpuModel(cpuModelRaw)
  const catalog = lookupCatalog(normalizedModel)
  if (!catalog) {
    return buildCheckResult({
      title: 'CPU MHz (actual)',
      cmd,
      expected: '(catalog missing)',
      observed: 'see raw',
      status: 'N/A',
      message: `CPU catalog missing for "${normalizedModel}".`,
      category: 'INFO',
      blocksBoostCompletion: false,
    })
  }
  const lines = raw.stdout.trim().split('\n').filter(Boolean)
  const freqs = lines
    .map((line) => {
      const m = line.match(/:\s*([\d.]+)/)
      return m ? parseFloat(m[1]) : NaN
    })
    .filter((f) => !isNaN(f))
  if (freqs.length === 0) {
    return buildCheckResult({
      title: 'CPU MHz (actual)',
      cmd,
      expected: '(parseable frequencies)',
      observed: raw.stdout.trim().slice(0, 100),
      status: 'WARN',
      message: 'Could not parse any CPU MHz values.',
      category: 'RUNTIME',
      blocksBoostCompletion: true,
    })
  }
  const threshold = catalog.maxBoostMhz * 0.5
  const minFreq = Math.min(...freqs)
  const maxFreq = Math.max(...freqs)
  const observed =
    `${freqs.length} cores, min=${minFreq.toFixed(0)} MHz, max=${maxFreq.toFixed(0)} MHz`
  if (maxFreq < threshold) {
    return buildCheckResult({
      title: 'CPU MHz (actual)',
      cmd,
      expected: `max core >= ${threshold.toFixed(0)} MHz (50% of ${catalog.maxBoostMhz} MHz)`,
      observed,
      status: 'FAIL',
      message:
        `Max core frequency ${maxFreq.toFixed(0)} MHz is below 50% of max boost (${threshold.toFixed(0)} MHz).`,
      category: 'RUNTIME',
      blocksBoostCompletion: true,
    })
  }
  return buildCheckResult({
    title: 'CPU MHz (actual)',
    cmd,
    expected: `max core >= ${threshold.toFixed(0)} MHz (50% of ${catalog.maxBoostMhz} MHz)`,
    observed,
    status: 'PASS',
    message:
      `Max core frequency ${maxFreq.toFixed(0)} MHz is above 50% threshold. Range: ${minFreq.toFixed(0)}-${maxFreq.toFixed(0)} MHz.`,
    category: 'INFO',
    blocksBoostCompletion: false,
  })
}

export function evaluateScalingDriverAmdPstate(raw: RawCommandResult): CheckResult {
  const cmd = 'cat /sys/devices/system/cpu/cpu0/cpufreq/scaling_driver'
  if (fileNotFound(raw)) {
    return buildCheckResult({
      title: 'amd_pstate scaling_driver',
      cmd,
      expected: 'amd-pstate-epp or amd-pstate',
      observed: 'N/A',
      status: 'WARN',
      message: 'scaling_driver sysfs not found.',
      category: 'CONTROL_PLANE',
      blocksBoostCompletion: false,
    })
  }
  const observed = raw.stdout.trim()
  const pass = /^amd[-_]pstate(-epp)?$/i.test(observed)
  return buildCheckResult({
    title: 'amd_pstate scaling_driver',
    cmd,
    expected: 'amd-pstate-epp or amd-pstate',
    observed,
    status: pass ? 'PASS' : 'WARN',
    message: pass
      ? `scaling_driver is ${observed} (optimal amd_pstate driver).`
      : `scaling_driver is ${observed}, not amd-pstate.`,
    category: pass ? 'INFO' : 'CONTROL_PLANE',
    blocksBoostCompletion: !pass,
  })
}

export function evaluatePrefcore(raw: RawCommandResult): CheckResult {
  const cmd = 'cat /sys/devices/system/cpu/amd_pstate/prefcore'
  if (fileNotFound(raw)) {
    return buildCheckResult({
      title: 'amd_pstate prefcore',
      cmd,
      expected: 'enabled',
      observed: 'N/A',
      status: 'WARN',
      message: 'prefcore sysfs not found.',
      category: 'CONTROL_PLANE',
      blocksBoostCompletion: false,
    })
  }
  const observed = raw.stdout.trim()
  const pass = observed === 'enabled'
  return buildCheckResult({
    title: 'amd_pstate prefcore',
    cmd,
    expected: 'enabled',
    observed,
    status: pass ? 'PASS' : 'WARN',
    message: pass
      ? 'amd_pstate prefcore is enabled.'
      : `amd_pstate prefcore is ${observed}, expected enabled.`,
    category: pass ? 'INFO' : 'CONTROL_PLANE',
    blocksBoostCompletion: !pass,
  })
}

export function evaluateKernelVersion(raw: RawCommandResult): CheckResult {
  const cmd = 'uname -r'
  const observed = raw.stdout.trim()
  if (!observed) {
    return buildCheckResult({
      title: 'Kernel version',
      cmd,
      expected: '>= 6.14',
      observed: 'N/A',
      status: 'WARN',
      message: 'Could not determine kernel version.',
      category: 'CONTROL_PLANE',
      blocksBoostCompletion: true,
    })
  }
  const m = observed.match(/^(\d+)\.(\d+)/)
  let major = 0
  let minor = 0
  if (m) {
    major = parseInt(m[1], 10)
    minor = parseInt(m[2], 10)
  }
  const pass = major > 6 || (major === 6 && minor >= 14)
  return buildCheckResult({
    title: 'Kernel version',
    cmd,
    expected: '>= 6.14',
    observed,
    status: pass ? 'PASS' : 'WARN',
    message: pass
      ? `Kernel ${observed} meets recommended version (6.14+).`
      : `Kernel ${observed} is below 6.14. Boost validation fidelity is weaker until kernel is upgraded.`,
    category: pass ? 'INFO' : 'CONTROL_PLANE',
    blocksBoostCompletion: !pass,
  })
}

export function assessPerformanceChecks(
  checks: CheckResult[],
): PerformanceAssessment {
  const hasFail = checks.some((c) => c.status === 'FAIL')
  const hasWarn = checks.some((c) => c.status === 'WARN')
  const blockers = checks
    .filter(
      (c) =>
        c.blocksBoostCompletion &&
        (c.status === 'FAIL' || c.status === 'WARN'),
    )
    .map((c) => ({
      title: c.title,
      status: c.status as Exclude<CheckStatus, 'PASS' | 'N/A'>,
      category: c.category,
      message: c.message,
    }))

  const categoryOrder: CheckCategory[] = ['OS', 'BIOS', 'CONTROL_PLANE', 'RUNTIME']
  const orderedCategories = [
    ...new Set(
      blockers
        .map((b) => b.category)
        .filter(
          (cat): cat is Exclude<CheckCategory, 'INFO'> => cat !== 'INFO',
        )
        .sort(
          (a, b) => categoryOrder.indexOf(a) - categoryOrder.indexOf(b),
        ),
    ),
  ]

  const categoryLabels: Record<Exclude<CheckCategory, 'INFO'>, string> = {
    OS: 'OS-side settings still need correction',
    BIOS: 'BIOS/firmware is capping the hardware ceiling',
    CONTROL_PLANE: 'control-plane validation is still incomplete',
    RUNTIME: 'runtime clock/latency behavior is still below target',
  }

  const summary = blockers.length === 0
    ? 'Boost complete: OS-side performance controls and runtime checks are fully aligned.'
    : `Boost incomplete: ${
      orderedCategories.map((c) => categoryLabels[c]).join('; ')
    }.`

  return {
    overallStatus: hasFail ? 'NG' : hasWarn ? 'WARN' : 'OK',
    boostCompletion: { completed: blockers.length === 0, summary, blockers },
  }
}

// ── Remote command execution ─────────────────────────────────────────────────

const CMD_SEPARATOR = '---SLV_BOOST_SEPARATOR---'

const CHECK_COMMANDS = [
  'cat /sys/devices/system/cpu/cpu0/cpufreq/energy_performance_preference 2>/dev/null', // 0
  'cat /sys/devices/system/cpu/cpu0/cpufreq/scaling_governor 2>/dev/null', //              1
  'cat /sys/devices/system/cpu/amd_pstate/status 2>/dev/null', //                          2
  'lscpu | grep -i boost', //                                                              3
  'grep . /sys/devices/system/cpu/cpu0/cpuidle/state*/disable 2>/dev/null', //             4
  'cat /sys/devices/system/cpu/cpu0/cpufreq/scaling_driver 2>/dev/null', //                5
  'cat /sys/devices/system/cpu/cpu*/cpufreq/scaling_max_freq 2>/dev/null | sort -u', //    6
  "cpupower frequency-info 2>/dev/null | egrep -i 'driver:|hardware limits:|available cpufreq governors:|current policy:|boost state support:|Active:|Supported:'", // 7
  'cat /sys/devices/system/cpu/cpu*/cpufreq/scaling_governor 2>/dev/null | sort -u', //    8
  'cat /sys/devices/system/cpu/cpufreq/boost 2>/dev/null', //                              9
  'uname -r', //                                                                          10
  'lscpu | head -20', //                                                                  11
  'cat /sys/devices/system/cpu/cpu0/cpufreq/cpuinfo_max_freq 2>/dev/null', //             12
  "grep 'cpu MHz' /proc/cpuinfo", //                                                      13
  'cat /sys/devices/system/cpu/amd_pstate/prefcore 2>/dev/null', //                       14
]

function buildBatchedCommand(): string {
  return CHECK_COMMANDS
    .map((cmd) => `echo '${CMD_SEPARATOR}'; ${cmd}; echo`)
    .join('; ')
}

function parseBatchedOutput(stdout: string): RawCommandResult[] {
  const sections = stdout.split(CMD_SEPARATOR)
  return CHECK_COMMANDS.map((cmd, i) => {
    const out = (sections[i + 1] ?? '').trim()
    return { cmd, stdout: out, stderr: '', rc: out ? 0 : 1 }
  })
}

type AdhocResult = {
  host: string
  rc: number
  stdout: string
  stderr: string
}

/**
 * Run an ad-hoc shell command on hosts via ansible.  The output is parsed
 * from the standard `host | CHANGED | rc=N >>\n<stdout>` format ansible
 * uses for ad-hoc shell tasks.
 */
async function runAnsibleAdhoc(
  cmd: string,
  inventoryType: InventoryType,
  limit?: string,
): Promise<AdhocResult[]> {
  const inventoryPath = getInventoryPath(inventoryType)
  const groupTarget = inventoryType
  const args = [
    '-i',
    inventoryPath,
    limit || groupTarget,
    '--limit',
    limit || groupTarget,
    '-m',
    'shell',
    '-a',
    cmd,
  ]
  const result = await new Deno.Command('ansible', {
    args,
    stdout: 'piped',
    stderr: 'piped',
  }).output()
  const stdout = new TextDecoder().decode(result.stdout)
  const stderr = new TextDecoder().decode(result.stderr)
  if (!result.success && !stdout) {
    throw new Error(`ansible exited rc=${result.code}: ${stderr.trim()}`)
  }
  return parseAdhocOutput(stdout)
}

function parseAdhocOutput(stdout: string): AdhocResult[] {
  // Format: `<host> | <STATUS> | rc=<n> >>\n<body>\n`
  // Multiple hosts emit blocks separated by blank lines.
  const results: AdhocResult[] = []
  const headerRe = /^(\S+)\s+\|\s+(?:CHANGED|SUCCESS|FAILED|UNREACHABLE)(?:\s+\|\s+rc=(\d+))?\s+>>\s*$/m
  let cursor = 0
  while (cursor < stdout.length) {
    const slice = stdout.slice(cursor)
    const match = headerRe.exec(slice)
    if (!match) break
    const headerStart = cursor + match.index
    const headerEnd = headerStart + match[0].length
    const host = match[1]
    const rc = match[2] ? parseInt(match[2], 10) : 0

    const remainder = stdout.slice(headerEnd)
    const next = headerRe.exec(remainder)
    const bodyEnd = next
      ? headerEnd + next.index
      : stdout.length
    const body = stdout.slice(headerEnd, bodyEnd).replace(/^\s*\n/, '')
    results.push({ host, rc, stdout: body.trim(), stderr: '' })
    cursor = bodyEnd
  }
  return results
}

// ── High-level: check a target ───────────────────────────────────────────────

export type TargetCheckResult = {
  target: string
  overallStatus: OverallStatus
  cpuModel: string
  checks: CheckResult[]
  boostCompletion: BoostCompletion
}

export async function checkBoostForTargets(
  inventoryType: InventoryType,
  limit?: string,
): Promise<TargetCheckResult[]> {
  const batched = buildBatchedCommand()
  const adhoc = await runAnsibleAdhoc(batched, inventoryType, limit)
  return adhoc.map((entry) => evaluateAdhocResult(entry))
}

function evaluateAdhocResult(entry: AdhocResult): TargetCheckResult {
  const rawResults = parseBatchedOutput(entry.stdout)
  const lscpuOutput = rawResults[11]?.stdout ?? ''
  const modelMatch = lscpuOutput.match(/Model name:\s*(.+)/i)
  const cpuModel = modelMatch ? modelMatch[1].trim() : 'unknown'
  const scalingDriver = rawResults[5]?.stdout?.trim() ?? ''
  const cpuinfoMaxFreqRaw = rawResults[12]?.stdout?.trim() ?? ''
  const cpuinfoMaxFreqKhz = parseInt(cpuinfoMaxFreqRaw, 10) || undefined
  const isAmd = /epyc|amd|ryzen/i.test(cpuModel)

  const checks: CheckResult[] = [
    evaluateEpp(rawResults[0], scalingDriver),
    evaluateGovernorCpu0(rawResults[1]),
    evaluateAmdPstate(rawResults[2], cpuModel),
    evaluateBoostLscpu(rawResults[3]),
    evaluateCpuidle(rawResults[4]),
    ...(!isAmd ? [evaluateCpufreqDriver(rawResults[5], cpuModel)] : []),
    evaluateScalingMaxFreq(rawResults[6], cpuModel, cpuinfoMaxFreqKhz),
    evaluateCpupowerInfo(rawResults[7]),
    evaluateGovernorAll(rawResults[8]),
    evaluateBoostSysfs(rawResults[9]),
    evaluateKernelVersion(rawResults[10]),
    evaluateCpuinfoMaxFreq(rawResults[12], cpuModel),
    evaluateCpuMhz(rawResults[13], cpuModel),
    ...(isAmd
      ? [evaluateScalingDriverAmdPstate(rawResults[5]), evaluatePrefcore(rawResults[14])]
      : []),
  ]

  const assessment = assessPerformanceChecks(checks)
  return {
    target: entry.host,
    overallStatus: assessment.overallStatus,
    cpuModel,
    checks,
    boostCompletion: assessment.boostCompletion,
  }
}

// ── Pretty printing for CLI ──────────────────────────────────────────────────

const CATEGORY_COLORS: Record<CheckCategory, (s: string) => string> = {
  OS: colors.yellow,
  BIOS: colors.magenta,
  CONTROL_PLANE: colors.cyan,
  RUNTIME: colors.blue,
  INFO: colors.gray,
}

const STATUS_COLORS: Record<OverallStatus, (s: string) => string> = {
  OK: colors.green,
  WARN: colors.yellow,
  NG: colors.red,
}

const STATUS_BANNER: Record<OverallStatus, string> = {
  OK: '✅ OK — boost is fully active 🎉',
  WARN: '⚠️  WARN — boost is partially active',
  NG: '❌ NG — boost is not active',
}

const BIOS_FRIENDLY_MESSAGE = [
  '🛠  Your BIOS has a little more room to shine 🚀',
  '   Lift the firmware-side ceiling and the CPU will hit its real top gear.',
  '   Suggested BIOS knobs:',
  '     • Determinism Slider              → "Performance"',
  '     • CPPC / Core Performance Boost   → "Enabled"',
  '     • Global C-States Control         → "Disabled"',
  '     • Power Profile                   → "Maximum Performance" / "Top Performance"',
  '     • P-State / Cool\'n\'Quiet          → "Disabled" (when running amd_pstate=active)',
].join('\n')

export function printTargetReport(result: TargetCheckResult): void {
  const banner = STATUS_BANNER[result.overallStatus]
  const colored = STATUS_COLORS[result.overallStatus]
  console.log()
  console.log(colored(`── Boost Check: ${result.target} ── ${banner}`))
  console.log(colors.gray(`CPU: ${result.cpuModel}`))
  const completion = result.boostCompletion.completed
    ? colors.green('✅ COMPLETE')
    : colors.yellow('⚠️  INCOMPLETE')
  console.log(`Boost completion: ${completion}`)
  console.log(colors.gray(result.boostCompletion.summary))
  console.log()
  for (const c of result.checks) {
    const cat = CATEGORY_COLORS[c.category](`[${c.category}]`.padEnd(16))
    const title = c.title.padEnd(28)
    const observed = c.observed.length > 50
      ? `${c.observed.slice(0, 47)}...`
      : c.observed
    console.log(`${c.icon}  ${cat} ${title} ${colors.gray('= ' + observed)}`)
    if (c.status !== 'PASS' && c.status !== 'N/A') {
      console.log(`   ${colors.gray('└─ ' + c.message)}`)
    }
  }

  const biosBlocked = result.boostCompletion.blockers.some(
    (b) => b.category === 'BIOS',
  )
  if (biosBlocked) {
    console.log()
    console.log(colors.magenta(BIOS_FRIENDLY_MESSAGE))
  } else if (result.overallStatus !== 'OK' && result.boostCompletion.blockers.length > 0) {
    console.log()
    console.log(colors.yellow('💡 Tip: re-run `slv v init` (or the optimize_node.yml playbook) to apply the OS-side fixes, then re-check.'))
  }
}
