import { t } from '@/ai/i18n/index.ts'
import type { SpecialistAgent } from '@/ai/console/intentClassifier.ts'

/**
 * Central registry of specialist agent metadata.
 *
 * This replaces the three hardcoded tables that previously lived in:
 *  - consoleAction.ts  (agentDescriptions + preferredOrder — greeting)
 *  - systemPrompt.ts   (agentLabels — team summary)
 *  - systemPrompt.ts   (Tina/Cid extra gRPC Geyser skill registration)
 *
 * Descriptions are lazy (`() => t('…')`) so i18n resolution happens after
 * `initI18n()` has settled, not at module import time.
 */

export type AgentId = SpecialistAgent

export interface AgentMeta {
  id: AgentId
  /** Routing tag used in system prompts and intent classifier. */
  label: string
  /** Human-facing description for greeting / team list. */
  description: () => string
  /** Display order (lower = earlier). */
  order: number
  /** Additional skill SKILL.md files to inject for this agent beyond the
   *  one paired with it in config.yml. */
  extraSkills?: string[]
  /** When set, the agent is auto-enabled if the named skill directory
   *  exists and config.yml does not explicitly list the agent. Explicit
   *  `enabled: false` in config.yml always wins over auto-enable. */
  autoEnableIfSkillPresent?: string
}

export const AGENT_REGISTRY: Record<AgentId, AgentMeta> = {
  Cecil: {
    id: 'Cecil',
    label: 'validator',
    description: () => t('Solana Validator deployments & management'),
    order: 1,
  },
  Tina: {
    id: 'Tina',
    label: 'rpc',
    description: () => t('RPC nodes (Index RPC, gRPC Geyser, combos)'),
    order: 2,
    extraSkills: ['slv-grpc-geyser'],
  },
  Setzer: {
    id: 'Setzer',
    label: 'app',
    description: () => t('Trading bots & Solana apps'),
    order: 3,
  },
  Figaro: {
    id: 'Figaro',
    label: 'server-procurement',
    description: () => t('Find optimized Solana server resources'),
    order: 4,
    autoEnableIfSkillPresent: 'slv-server-procurement',
  },
  Cid: {
    id: 'Cid',
    label: 'benchmark',
    description: () => t('Benchmarks & connectivity testing'),
    order: 5,
    extraSkills: ['slv-grpc-geyser'],
  },
}

export const ALL_AGENT_IDS: AgentId[] = Object.keys(
  AGENT_REGISTRY,
) as AgentId[]

export const isKnownAgentId = (id: string): id is AgentId =>
  Object.prototype.hasOwnProperty.call(AGENT_REGISTRY, id)

/** Order agent ids by registry `order`, ignoring unknown ids silently. */
export const listAgentsByOrder = (ids: readonly string[]): AgentMeta[] => {
  const seen = new Set<AgentId>()
  const known: AgentMeta[] = []
  for (const id of ids) {
    if (!isKnownAgentId(id)) continue
    if (seen.has(id)) continue
    seen.add(id)
    known.push(AGENT_REGISTRY[id])
  }
  known.sort((a, b) => a.order - b.order)
  return known
}

/** Flat list of all SKILL.md paths that should be registered for an agent,
 *  given the skill names pulled from config.yml that were paired with this
 *  agent. Handles deduplication of extraSkills. */
export const collectSkillNamesForAgent = (
  agent: AgentId,
  configPaired: readonly string[],
): string[] => {
  const meta = AGENT_REGISTRY[agent]
  const set = new Set<string>(configPaired)
  for (const extra of meta.extraSkills ?? []) set.add(extra)
  return [...set]
}
