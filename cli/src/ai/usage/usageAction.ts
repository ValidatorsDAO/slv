import { getApiKeyFromYml } from '/lib/getApiKeyFromYml.ts'
import { colors } from '@cliffy/colors'
import Kia from 'https://deno.land/x/kia@0.4.1/mod.ts'
import {
  divider,
  formatBulletList,
  formatKeyValueFields,
  getTerminalWidth,
} from '@/ai/rendering.ts'

const USER_API_URL = 'https://user-api.erpc.global/v3/ai/usage'

export const aiUsageAction = async () => {
  const apiKey = await getApiKeyFromYml()

  const spinner = new Kia(colors.cyan('Fetching AI token usage...'))
  spinner.start()

  try {
    const response = await fetch(USER_API_URL, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
    })

    if (!response.ok) {
      const errorData = await response.json().catch(() => null) as
        | Record<string, unknown>
        | null
      const errorMsg = (errorData?.message as string) ??
        `HTTP ${response.status}`
      spinner.fail('Failed to fetch AI usage')
      console.log(colors.red(`  ${errorMsg}`))
      return
    }

    const data = (await response.json()) as Record<string, unknown>
    const msg = (data.message ?? data) as Record<string, unknown>

    spinner.succeed('AI Token Usage')

    const width = getTerminalWidth()
    const aiPlan = String(msg.ai_plan ?? msg.plan_name ?? 'unknown')
    const maxTokens = Number(msg.max_tokens ?? 0)
    const consumedTokens = Number(
      msg.consumedTokens ?? msg.consumed_tokens ?? 0,
    )
    const remainingTokens = Number(msg.remaining_tokens ?? 0)
    const inputTokens = Number(msg.input_tokens ?? 0)
    const outputTokens = Number(msg.output_tokens ?? 0)
    const cacheCreation = Number(msg.cache_creation_input_tokens ?? 0)
    const cacheRead = Number(msg.cache_read_input_tokens ?? 0)

    const usagePercent = maxTokens > 0
      ? ((consumedTokens / maxTokens) * 100).toFixed(1)
      : '0.0'
    const remainingDisplay = remainingTokens.toLocaleString()

    console.log(colors.bold('\nAI Token Usage'))
    console.log(
      formatKeyValueFields([
        { label: 'Plan', value: aiPlan },
        { label: 'Consumed', value: consumedTokens.toLocaleString() },
        {
          label: 'Remaining',
          value: remainingTokens <= 0
            ? colors.red(remainingDisplay)
            : remainingDisplay,
        },
        { label: 'Max Tokens', value: maxTokens.toLocaleString() },
        { label: 'Usage', value: `${usagePercent}%` },
      ], width),
    )
    console.log(divider(width))
    console.log(
      formatKeyValueFields([
        { label: 'Input Tokens', value: inputTokens.toLocaleString() },
        { label: 'Output Tokens', value: outputTokens.toLocaleString() },
        { label: 'Cache Creation', value: cacheCreation.toLocaleString() },
        { label: 'Cache Read', value: cacheRead.toLocaleString() },
      ], width),
    )
    console.log(
      formatBulletList([
        'Run `slv ai product` to view plans and purchase options.',
      ], width),
    )
  } catch (error) {
    spinner.fail('Failed to fetch AI usage')
    console.log(colors.red(`  ${(error as Error).message}`))
  }
}
