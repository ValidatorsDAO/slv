import { colors } from '@cliffy/colors'
import { runReleaseEngine } from '/lib/release/index.ts'
import { VERSION } from '@cmn/constants/version.ts'

export const SKILL_NAMES = [
  'slv-validator',
  'slv-rpc',
  'slv-grpc-geyser',
  'slv-benchmark',
  'slv-app',
  'slv-bot-trade-app',
  'slv-server-procurement',
  'slv-backup',
  'slv-firewall',
  'slv-wireguard',
] as const

type SyncOptions = {
  force?: boolean
  only?: readonly string[]
  quiet?: boolean
}

export type SyncResult = {
  updated: number
  unchanged: number
  added: number
  failed: number
  failedFiles: string[]
}

const knownSkill = (name: string): name is typeof SKILL_NAMES[number] =>
  (SKILL_NAMES as readonly string[]).includes(name)

const parseResult = (raw: string): SyncResult => {
  const value: unknown = JSON.parse(raw)
  if (!value || typeof value !== 'object') throw new Error('release engine returned invalid skill result')
  const result = value as Record<string, unknown>
  for (const field of ['updated', 'unchanged', 'added', 'failed'] as const) {
    if (!Number.isSafeInteger(result[field]) || (result[field] as number) < 0) {
      throw new Error('release engine returned invalid skill counters')
    }
  }
  if (!Array.isArray(result.failedFiles) || !result.failedFiles.every((value) => typeof value === 'string')) {
    throw new Error('release engine returned invalid failed files')
  }
  return result as unknown as SyncResult
}

export const syncSkills = async (options: SyncOptions = {}): Promise<SyncResult> => {
  const targets = options.only && options.only.length > 0 ? [...options.only] : [...SKILL_NAMES]
  const unknown = targets.filter((name) => !knownSkill(name))
  if (unknown.length > 0 || new Set(targets).size !== targets.length) {
    throw new Error(`Unknown or duplicate skill selection: ${[...new Set(unknown)].join(', ') || 'duplicate'}`)
  }
  const args = ['skills', '--version', VERSION]
  if (options.force) args.push('--force')
  for (const name of targets) args.push('--only', name)

  let result: SyncResult
  try {
    result = parseResult((await runReleaseEngine(args)).trim())
  } catch (error) {
    result = { added: 0, updated: 0, unchanged: 0, failed: targets.length, failedFiles: targets }
    if (!options.quiet) console.error(colors.red(`Skill sync failed: ${(error as Error).message}`))
  }
  if (!options.quiet) {
    console.log(result.failed > 0
      ? colors.red(`Skills not changed: ${result.failed} group failure(s).`)
      : colors.green(`Skills synced: ${result.added} added, ${result.updated} updated, ${result.unchanged} unchanged.`))
  }
  return result
}
