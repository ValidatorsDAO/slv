import type { SSHConnection } from '@cmn/prompt/checkSSHConnection.ts'
import type { XdpConfig } from '/src/validator/init/promptXdpConfig.ts'

/** Read-only Linux inspection. No sudo, packages, link changes or BPF programs. */
export const NODE_FACTS_PROBE = String.raw`
import json, os, pathlib, platform, subprocess

def read(path):
    try: return pathlib.Path(path).read_text().strip()
    except OSError: return ''
def command(args):
    try:
        r = subprocess.run(args, capture_output=True, text=True, timeout=8)
        return r.stdout if r.returncode == 0 else ''
    except (OSError, subprocess.TimeoutExpired): return ''
try: routes = json.loads(command(['ip', '-j', 'route', 'get', '1.1.1.1']) or '[]')
except ValueError: routes = []
devices = sorted(set(r.get('dev', '') for r in routes if r.get('dev')))
nics = []
for root in sorted(pathlib.Path('/sys/class/net').glob('*')):
    try: driver = (root / 'device/driver').resolve(strict=True).name
    except OSError: driver = ''
    nics.append({'name': root.name, 'driver': driver,
                 'physical': (root / 'device').exists(),
                 'up': read(root / 'operstate') == 'up',
                 'bond': (root / 'bonding').exists(),
                 'bridge': (root / 'bridge').exists(),
                 'slaves': read(root / 'bonding/slaves').split()})
cpus = []
try: available = sorted(os.sched_getaffinity(0))
except AttributeError: available = []
for cpu in available:
    root = pathlib.Path('/sys/devices/system/cpu/cpu' + str(cpu) + '/topology')
    package, core = read(root / 'physical_package_id'), read(root / 'core_id')
    if package.isdigit() and core.isdigit():
        cpus.append({'cpu': cpu, 'package': int(package), 'core': int(core)})
active = command(['systemctl', 'is-active', 'solv.service']).strip() == 'active'
print(json.dumps({'kernel': platform.release(), 'routeDevices': devices,
                  'interfaces': nics, 'cpus': cpus, 'validatorRunning': active}))
`

export type NodeFacts = {
  kernel: string
  routeDevices: string[]
  interfaces: Array<{
    name: string
    driver: string
    physical: boolean
    up: boolean
    bond: boolean
    bridge: boolean
    slaves: string[]
  }>
  cpus: Array<{ cpu: number; package: number; core: number }>
  validatorRunning: boolean
}
const identifier = /^[A-Za-z0-9_.:-]{1,64}$/
export function parseNodeFacts(raw: string): NodeFacts {
  const value = JSON.parse(raw)
  if (
    !value || typeof value !== 'object' ||
    typeof value.kernel !== 'string' ||
    !/^\d+\.\d+[A-Za-z0-9._+-]*$/.test(value.kernel) ||
    !Array.isArray(value.routeDevices) || value.routeDevices.length > 8 ||
    !value.routeDevices.every((s: unknown) =>
      typeof s === 'string' && identifier.test(s)
    ) ||
    !Array.isArray(value.interfaces) || value.interfaces.length > 128 ||
    !Array.isArray(value.cpus) || value.cpus.length > 4096 ||
    typeof value.validatorRunning !== 'boolean'
  ) throw new Error('Incomplete node inspection')
  for (const nic of value.interfaces) {
    if (
      !nic || typeof nic.name !== 'string' || !identifier.test(nic.name) ||
      typeof nic.driver !== 'string' ||
      (nic.driver !== '' && !identifier.test(nic.driver)) ||
      !['physical', 'up', 'bond', 'bridge'].every((key) =>
        typeof nic[key] === 'boolean'
      ) ||
      !Array.isArray(nic.slaves) || nic.slaves.length > 32 ||
      !nic.slaves.every((s: unknown) =>
        typeof s === 'string' && identifier.test(s)
      )
    ) {
      throw new Error('Invalid network inspection')
    }
  }
  for (const cpu of value.cpus) {
    if (
      !cpu ||
      !['cpu', 'package', 'core'].every((key) =>
        Number.isInteger(cpu[key]) && cpu[key] >= 0 && cpu[key] <= 65535
      )
    ) throw new Error('Invalid CPU inspection')
  }
  if (
    new Set(value.cpus.map((c: { cpu: number }) => c.cpu)).size !==
      value.cpus.length
  ) {
    throw new Error('Duplicate CPU inspection')
  }
  if (
    new Set(value.interfaces.map((n: { name: string }) => n.name)).size !==
      value.interfaces.length
  ) {
    throw new Error('Duplicate network inspection')
  }
  return value as NodeFacts
}

export type XdpRecommendation = { config: XdpConfig; reason: string }
/** Conservative setup recommendation, not a live XDP compatibility test. */
export function recommendXdp(facts: NodeFacts | null): XdpRecommendation {
  const off = (reason: string): XdpRecommendation => ({
    config: { xdp_enabled: false },
    reason,
  })
  if (!facts) {
    return off('node inspection unavailable; using standard networking')
  }
  const [major, minor] = facts.kernel.split('.').map(Number)
  if (major < 6 || (major === 6 && minor < 8)) {
    return off('kernel is older than 6.8')
  }
  if (facts.routeDevices.length !== 1) {
    return off('no unambiguous outbound interface')
  }
  const nic = facts.interfaces.find((n) => n.name === facts.routeDevices[0])
  // A bond/bridge can use several physical paths. Do not guess one and break its failover.
  if (!nic || !nic.up || !nic.physical || nic.bond || nic.bridge) {
    return off('outbound interface is virtual, bonded, bridged or not active')
  }
  if (
    !['mlx5_core', 'ixgbe', 'i40e', 'ice', 'bnxt_en', 'igb'].includes(
      nic.driver,
    )
  ) {
    return off('network driver needs a compatibility check')
  }
  if (nic.driver === 'igb' && major === 6 && minor < 14) {
    return off('igb automatic setup requires kernel 6.14 or newer')
  }
  // Legacy flags treat 1 as a worker count (CPU 0); Agave 4.4 treats
  // --xdp-cpu-cores 1 as CPU ID 1. Keep PoH physically disjoint from both.
  // Source: anza-xyz/agave v4.4.0-beta.1, build_xdp_config in run/execute.rs.
  const first = facts.cpus.find((c) => c.cpu === 0)
  const second = facts.cpus.find((c) => c.cpu === 1)
  const physical = new Set(facts.cpus.map((c) => `${c.package}:${c.core}`))
  if (!first || !second || physical.size < 4) {
    return off(
      'CPU topology is incomplete or has fewer than four physical cores',
    )
  }
  const poh = facts.cpus.find((c) =>
    c.cpu >= 2 && (c.package !== first.package || c.core !== first.core) &&
    (c.package !== second.package || c.core !== second.core)
  )
  if (!poh) return off('no separate physical core for PoH')
  return {
    config: {
      xdp_enabled: true,
      xdp_interface: nic.name,
      xdp_cpu_cores: 1,
      xdp_zero_copy: false,
      xdp_poh_pinned_cpu_core: poh.cpu,
    },
    reason:
      `${nic.name} (${nic.driver}), kernel ${facts.kernel}; copy mode, PoH CPU ${poh.cpu}`,
  }
}

export async function inspectNode(
  connection: SSHConnection,
  localhost = false,
): Promise<NodeFacts | null> {
  let child: Deno.ChildProcess
  try {
    child = new Deno.Command(localhost ? 'python3' : 'ssh', {
      args: localhost ? ['-'] : [
        '-i',
        connection.rsa_key_path,
        '-o',
        'ConnectTimeout=10',
        '-o',
        'StrictHostKeyChecking=yes',
        '--',
        `${connection.username}@${connection.ip}`,
        'python3',
        '-',
      ],
      stdin: 'piped',
      stdout: 'piped',
      stderr: 'null',
    }).spawn()
  } catch {
    return null
  }
  const timeout = setTimeout(() => {
    try {
      child.kill('SIGKILL')
    } catch { /* exited */ }
  }, 30_000)
  try {
    const writer = child.stdin.getWriter()
    await writer.write(new TextEncoder().encode(NODE_FACTS_PROBE))
    await writer.close()
    const result = await child.output()
    if (!result.success || result.stdout.length > 128_000) return null
    return parseNodeFacts(new TextDecoder().decode(result.stdout))
  } catch {
    try {
      child.kill('SIGKILL')
    } catch { /* already exited */ }
    await child.status.catch(() => undefined)
    await child.stdout.cancel().catch(() => undefined)
    return null
  } finally {
    clearTimeout(timeout)
  }
}
