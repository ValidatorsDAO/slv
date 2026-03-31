import { getApiKeyFromYml } from '/lib/getApiKeyFromYml.ts'
import { colors } from '@cliffy/colors'
import { Row, Table } from '@cliffy/table'
import Kia from 'https://deno.land/x/kia@0.4.1/mod.ts'

type McpResponse = {
  result?: {
    content?: Array<{ type: string; text?: string }>
  }
}

async function callMcp(apiKey: string, toolName: string, args: Record<string, unknown> = {}): Promise<string> {
  const response = await fetch('https://mcp-slv-cloud.erpc.global/mcp', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: Date.now(),
      method: 'tools/call',
      params: { name: toolName, arguments: args },
    }),
  })
  const data = await response.json() as McpResponse
  return data.result?.content?.[0]?.text || ''
}

export const aiUsageAction = async () => {
  const apiKey = await getApiKeyFromYml()

  const spinner = new Kia(colors.cyan('Fetching AI token usage...'))
  spinner.start()

  try {
    const raw = await callMcp(apiKey, 'get_user_get')
    if (!raw) {
      spinner.fail('Failed to fetch usage')
      console.log(colors.red('\n  Could not retrieve account information.'))
      return
    }

    spinner.succeed('AI Token Usage')

    // Parse the user data — try JSON first, fall back to displaying raw text
    let userData: Record<string, unknown> | null = null
    try {
      userData = JSON.parse(raw)
    } catch {
      // Not JSON — display as-is
    }

    if (userData) {
      const table = new Table()
      const rows: Row[] = []

      // Extract AI-related fields from user data
      const aiTokens = userData.ai_tokens ?? userData.aiTokens ?? userData.tokens
      const aiTokensUsed = userData.ai_tokens_used ?? userData.aiTokensUsed ?? userData.tokensUsed
      const aiTokensRemaining = userData.ai_tokens_remaining ?? userData.aiTokensRemaining
      const plan = userData.plan ?? userData.subscription ?? userData.tier

      if (plan !== undefined) {
        rows.push(new Row(colors.blue('Plan'), colors.white(String(plan))).border(true))
      }
      if (aiTokens !== undefined) {
        rows.push(new Row(colors.blue('Token Limit'), colors.white(Number(aiTokens).toLocaleString())).border(true))
      }
      if (aiTokensUsed !== undefined) {
        rows.push(new Row(colors.blue('Tokens Used'), colors.white(Number(aiTokensUsed).toLocaleString())).border(true))
      }
      if (aiTokensRemaining !== undefined) {
        rows.push(new Row(colors.blue('Remaining'), colors.white(Number(aiTokensRemaining).toLocaleString())).border(true))
      }

      if (rows.length > 0) {
        table.body(rows)
        console.log('')
        table.render()
      } else {
        // Show raw data if we couldn't extract specific fields
        console.log(colors.white(`\n${JSON.stringify(userData, null, 2)}`))
      }
    } else {
      console.log(colors.white(`\n${raw}`))
    }

    console.log(colors.gray('\n  Run `slv ai product` to view plans and purchase options.\n'))
  } catch (error) {
    spinner.fail('Failed to fetch AI usage')
    console.log(colors.red(`\n  ${(error as Error).message}`))
  }
}
