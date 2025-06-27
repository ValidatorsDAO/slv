import { z } from '@hono/zod-openapi'

export type BotTempType = 'geyser-ts' | 'shreds-rust' | 'shreds-ts' | 'geyser-rust'
export const BotTempTypeSchema = z.enum(['geyser-ts', 'geyser-rust', 'shreds-ts','shreds-rust' ])
export const BotTempTypeArray = BotTempTypeSchema.options
export const BotTempDLinkMap: Record<BotTempType, string> = {
  'geyser-ts': 'https://storage.slv.dev/bin/latest/geyser-ts',
  'geyser-rust': 'https://storage.slv.dev/bin/latest/geyser-rs',
  'shreds-rust': 'https://storage.slv.dev/bin/latest/shreds-rs',
  'shreds-ts': 'https://storage.slv.dev/bin/latest/shreds-ts',
}