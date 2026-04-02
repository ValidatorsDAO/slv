import { getApiKeyFromYml } from '/lib/getApiKeyFromYml.ts'
import { colors } from '@cliffy/colors'
import { Row, Table } from '@cliffy/table'
import Kia from 'https://deno.land/x/kia@0.4.1/mod.ts'

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
      const errorData = await response.json().catch(() => null) as Record<string, unknown> | null
      const errorMsg =
        (errorData?.message as string) ?? `HTTP ${response.status}`
      spinner.fail('Failed to fetch AI usage')
      console.log(colors.red(`\n  ${errorMsg}`))
      return
    }

    const data = (await response.json()) as Record<string, unknown>
    const msg = (data.message ?? data) as Record<string, unknown>

    spinner.succeed('AI Token Usage')

    const aiPlan = msg.ai_plan ?? 'unknown'
    const maxTokens = Number(msg.max_tokens ?? 0)
    const rawConsumed = Number(msg.consumedTokens ?? msg.consumed_tokens ?? 0)
    const remainingTokens = Number(msg.remaining_tokens ?? 0)
    const inputTokens = Number(msg.input_tokens ?? 0)
    const outputTokens = Number(msg.output_tokens ?? 0)
    const cacheCreation = Number(msg.cache_creation_input_tokens ?? 0)
    const cacheRead = Number(msg.cache_read_input_tokens ?? 0)

    // Use max - remaining as consumed when the API field is stale/zero
    const derivedConsumed = maxTokens > 0 && remainingTokens >= 0
      ? maxTokens - remainingTokens
      : 0
    const consumedTokens = rawConsumed > 0 ? rawConsumed : derivedConsumed

    const usagePercent = maxTokens > 0
      ? ((consumedTokens / maxTokens) * 100).toFixed(1)
      : '0'
    const remainingColor = remainingTokens <= 0 ? colors.red : colors.white

    const table = new Table()
    const rows: Row[] = [
      new Row(
        colors.blue('Input Tokens'),
        colors.white(inputTokens.toLocaleString()),
      ).border(true),
      new Row(
        colors.blue('Output Tokens'),
        colors.white(outputTokens.toLocaleString()),
      ).border(true),
      new Row(
        colors.blue('Cache Creation Tokens'),
        colors.white(cacheCreation.toLocaleString()),
      ).border(true),
      new Row(
        colors.blue('Cache Read Tokens'),
        colors.white(cacheRead.toLocaleString()),
      ).border(true),
      new Row(colors.gray('─────────────────────'), colors.gray('─────────────────')).border(true),
      new Row(
        colors.blue('Consumed Tokens'),
        colors.white(consumedTokens.toLocaleString()),
      ).border(true),
      new Row(
        colors.blue('Max Tokens'),
        colors.white(maxTokens.toLocaleString()),
      ).border(true),
      new Row(
        colors.blue('Remaining'),
        remainingColor(remainingTokens.toLocaleString()),
      ).border(true),
      new Row(
        colors.blue('Usage'),
        colors.white(`${usagePercent}%`),
      ).border(true),
      new Row(
        colors.blue('Plan'),
        colors.white(String(aiPlan)),
      ).border(true),
    ]

    table.body(rows)
    console.log('')
    table.render()

    console.log(
      colors.gray(
        '\n  Run `slv ai product` to view plans and purchase options.\n',
      ),
    )
  } catch (error) {
    spinner.fail('Failed to fetch AI usage')
    console.log(colors.red(`\n  ${(error as Error).message}`))
  }
}
