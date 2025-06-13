import { z } from '@hono/zod-openapi'

export type BotTempType = 'geyser-typescript' | 'shreds-rust' | 'shreds-ts'
export const BotTempTypeSchema = z.enum(['geyser-typescript', 'shreds-rust', 'shreds-ts'])
export const BotTempTypeArray = BotTempTypeSchema.options
export const BotTempDLinkMap: Record<BotTempType, string> = {
  'geyser-typescript': 'https://storage.slv.dev/template/geyser-ts3.tar.gz',
  'shreds-rust': 'https://storage.slv.dev/template/shreds-rs3.tar.gz',
  'shreds-ts': 'https://storage.slv.dev/bin/latest/shreds-ts',
}