import { colors } from '@cliffy/colors'
import { parse } from '@std/yaml'

export const isInventoryFilePath = (value: string): boolean => {
  return /\.ya?ml$/i.test(value)
}

export const resolveIpsFromInventoryFile = async (
  filePath: string,
  limitArg?: string,
): Promise<string[]> => {
  try {
    await Deno.stat(filePath)
  } catch (_error) {
    console.error(colors.red(`❌ Inventory file not found: ${filePath}`))
    return []
  }

  let yamlText: string
  try {
    yamlText = await Deno.readTextFile(filePath)
  } catch (_error) {
    console.error(colors.red(`❌ Failed to read inventory file: ${filePath}`))
    return []
  }

  let parsed: Record<string, unknown>
  try {
    parsed = parse(yamlText) as Record<string, unknown>
  } catch (_error) {
    console.error(colors.red(`❌ Failed to parse inventory YAML: ${filePath}`))
    return []
  }

  const { hostMap, groupHosts } = collectInventoryHosts(parsed)
  if (Object.keys(hostMap).length === 0) {
    console.error(
      colors.red(`❌ No ansible_host entries found in inventory: ${filePath}`),
    )
    return []
  }

  return selectHostsForLimit(hostMap, groupHosts, limitArg)
}

const collectInventoryHosts = (
  data: Record<string, unknown>,
): {
  hostMap: Record<string, string>
  groupHosts: Record<string, Set<string>>
} => {
  const hostMap: Record<string, string> = {}
  const directGroupHosts: Record<string, Set<string>> = {}
  const groupChildren: Record<string, Set<string>> = {}

  const visitGroup = (groupName: string, groupData: unknown) => {
    const groupSet = directGroupHosts[groupName] ?? new Set<string>()
    directGroupHosts[groupName] = groupSet

    if (groupData && typeof groupData === 'object') {
      const groupObj = groupData as Record<string, unknown>

      if (
        groupObj.hosts &&
        typeof groupObj.hosts === 'object' &&
        !Array.isArray(groupObj.hosts)
      ) {
        for (const [hostName, hostData] of Object.entries(
          groupObj.hosts as Record<string, unknown>,
        )) {
          if (hostData && typeof hostData === 'object') {
            const ansibleHost = (hostData as Record<string, unknown>)
              .ansible_host
            if (typeof ansibleHost === 'string') {
              hostMap[hostName] = ansibleHost
              groupSet.add(hostName)
            }
          }
        }
      }

      if (
        groupObj.children &&
        typeof groupObj.children === 'object' &&
        !Array.isArray(groupObj.children)
      ) {
        const childrenSet =
          groupChildren[groupName] ?? new Set<string>()
        groupChildren[groupName] = childrenSet
        for (const [childName, childData] of Object.entries(
          groupObj.children as Record<string, unknown>,
        )) {
          childrenSet.add(childName)
          visitGroup(childName, childData)
        }
      }
    }
  }

  for (const [key, value] of Object.entries(data)) {
    if (key === '_meta' && value && typeof value === 'object') {
      const metaObj = value as Record<string, unknown>
      const hostvars = metaObj.hostvars
      if (hostvars && typeof hostvars === 'object') {
        for (const [hostName, hostData] of Object.entries(
          hostvars as Record<string, unknown>,
        )) {
          if (hostData && typeof hostData === 'object') {
            const ansibleHost = (hostData as Record<string, unknown>)
              .ansible_host
            if (typeof ansibleHost === 'string') {
              hostMap[hostName] = ansibleHost
            }
          }
        }
      }
      continue
    }

    if (value && typeof value === 'object') {
      const node = value as Record<string, unknown>
      if (typeof node.ansible_host === 'string') {
        hostMap[key] = node.ansible_host
      }

      visitGroup(key, value)
    }
  }

  const groupHosts: Record<string, Set<string>> = {}
  const memo = new Map<string, Set<string>>()

  const resolveGroup = (
    groupName: string,
    stack: Set<string> = new Set<string>(),
  ): Set<string> => {
    if (memo.has(groupName)) {
      return memo.get(groupName)!
    }

    if (stack.has(groupName)) {
      return new Set<string>()
    }

    stack.add(groupName)
    const base =
      directGroupHosts[groupName] != null
        ? new Set<string>(directGroupHosts[groupName])
        : new Set<string>()
    const children = groupChildren[groupName]
    if (children && children.size > 0) {
      children.forEach((child) => {
        resolveGroup(child, stack).forEach((host) => base.add(host))
      })
    }
    stack.delete(groupName)

    memo.set(groupName, base)
    groupHosts[groupName] = base
    return base
  }

  const allGroups = new Set<string>([
    ...Object.keys(directGroupHosts),
    ...Object.keys(groupChildren),
  ])
  allGroups.forEach((group) => {
    resolveGroup(group)
  })

  return { hostMap, groupHosts }
}

const selectHostsForLimit = (
  hostMap: Record<string, string>,
  groupHosts: Record<string, Set<string>>,
  limitArg?: string,
): string[] => {
  const uniqueIps = new Set<string>()

  const pushHosts = (hosts: Iterable<string>) => {
    for (const hostName of hosts) {
      const ip = hostMap[hostName]
      if (ip && !uniqueIps.has(ip)) {
        uniqueIps.add(ip)
      }
    }
  }

  if (!limitArg || limitArg.trim().length === 0) {
    pushHosts(Object.keys(hostMap))
    return Array.from(uniqueIps)
  }

  const normalized = limitArg.trim().toLowerCase()
  if (normalized === 'all') {
    pushHosts(Object.keys(hostMap))
    return Array.from(uniqueIps)
  }

  const limits = limitArg
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)

  const matchedHosts = new Set<string>()

  limits.forEach((entry) => {
    if (hostMap[entry]) {
      matchedHosts.add(entry)
      return
    }
    const group = groupHosts[entry]
    if (group && group.size > 0) {
      group.forEach((host) => matchedHosts.add(host))
      return
    }
    console.log(
      colors.yellow(`⚠️ No matching hosts found for limit entry: ${entry}`),
    )
  })

  if (matchedHosts.size === 0) {
    pushHosts(Object.keys(hostMap))
    return Array.from(uniqueIps)
  }

  pushHosts(matchedHosts)
  return Array.from(uniqueIps)
}
