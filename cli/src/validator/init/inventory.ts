import { dirname } from '@std/path'
import { parse, stringify } from '@std/yaml'
import { getInventoryPath } from '@cmn/constants/path.ts'

type Network = 'mainnet' | 'testnet'
const pathFor = (network: Network) => getInventoryPath(`${network}_validators`)

/** Preserve linked inventories and refuse dangling links before key creation. */
async function inventoryTarget(path: string): Promise<string> {
  try {
    return await Deno.realPath(path)
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error
    try {
      if ((await Deno.lstat(path)).isSymlink) {
        throw new Error(
          'The inventory symlink has no target. Restore its target before init; no identity or inventory was replaced.',
        )
      }
    } catch (statError) {
      if (!(statError instanceof Deno.errors.NotFound)) throw statError
    }
    return path
  }
}

async function documentAt(path: string): Promise<Record<string, unknown>> {
  try {
    const value = parse(await Deno.readTextFile(path))
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('Inventory must be a YAML mapping.')
    }
    return value as Record<string, unknown>
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return {}
    throw error
  }
}

function hostsAt(
  document: Record<string, unknown>,
  group: string,
): Record<string, unknown> {
  const section = document[group]
  if (section === undefined || section === null) return {}
  if (typeof section !== 'object' || Array.isArray(section)) {
    throw new Error('Inventory group must be a mapping.')
  }
  const hosts = (section as Record<string, unknown>).hosts
  if (hosts === undefined || hosts === null) return {}
  if (typeof hosts !== 'object' || Array.isArray(hosts)) {
    throw new Error('Inventory hosts must be a mapping.')
  }
  return hosts as Record<string, unknown>
}

export async function assertNewValidatorHost(
  network: Network,
  name: string,
  path = pathFor(network),
): Promise<void> {
  if (
    Object.hasOwn(
      hostsAt(
        await documentAt(await inventoryTarget(path)),
        `${network}_validators`,
      ),
      name,
    )
  ) {
    throw new Error(
      `Inventory host ${name} already exists. Init will not replace its identity or settings; use another name.`,
    )
  }
}

/** Save a complete public-only host, leaving every existing entry untouched. */
export async function saveValidatorInitHost(
  network: Network,
  name: string,
  host: Record<string, unknown>,
  path = pathFor(network),
): Promise<void> {
  path = await inventoryTarget(path)
  await Deno.mkdir(dirname(path), { recursive: true, mode: 0o700 })
  // Never race another init into replacing an identity or losing an entry.
  const lock = await Deno.open(`${path}.init.lock`, {
    write: true,
    createNew: true,
    mode: 0o600,
  })
  let temp: string | undefined
  try {
    const document = await documentAt(path)
    const group = `${network}_validators`
    const hosts = hostsAt(document, group)
    if (Object.hasOwn(hosts, name)) {
      throw new Error(
        `Inventory host ${name} already exists; nothing was replaced.`,
      )
    }
    document[group] = {
      ...(document[group] as Record<string, unknown> ?? {}),
      hosts: { ...hosts, [name]: host },
    }
    temp = await Deno.makeTempFile({
      dir: dirname(path),
      prefix: '.validator-init-',
    })
    await Deno.writeTextFile(temp, stringify(document), { mode: 0o600 })
    const file = await Deno.open(temp, { write: true })
    try {
      await file.sync()
    } finally {
      file.close()
    }
    await Deno.rename(temp, path)
    temp = undefined
  } finally {
    lock.close()
    await Deno.remove(`${path}.init.lock`)
    if (temp) await Deno.remove(temp)
  }
}
