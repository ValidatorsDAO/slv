import { z } from '@hono/zod-openapi'

export type BotTempType =
  | 'geyser-ts'
  | 'shreds-rust'
  | 'shreds-ts'
  | 'geyser-rust'
  | 'shreds-udp-rust'
export const BotTempTypeSchema = z.enum([
  'geyser-ts',
  'geyser-rust',
  'shreds-ts',
  'shreds-rust',
  'shreds-udp-rust',
])
export const BotTempTypeArray = BotTempTypeSchema.options

/**
 * GitHub repo and branch for downloading templates directly from temp-release/
 */
export const BOT_TEMP_REPO = 'ValidatorsDAO/solana-stream'
export const BOT_TEMP_BRANCH = 'main'
export const BOT_TEMP_ARCHIVE_URL = `https://github.com/${BOT_TEMP_REPO}/archive/refs/heads/${BOT_TEMP_BRANCH}.tar.gz`

/**
 * Maps template type to the directory name inside temp-release/
 */
export const BotTempDirMap: Record<BotTempType, string> = {
  'geyser-ts': 'geyser-ts',
  'geyser-rust': 'geyser-rs',
  'shreds-rust': 'shreds-rs',
  'shreds-ts': 'shreds-ts',
  'shreds-udp-rust': 'shreds-udp-rs',
}
