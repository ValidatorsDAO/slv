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

type Product = {
  name?: string
  product?: string
  description?: string
  price?: string | number
  tokens?: string | number
  currency?: string
  interval?: string
  paymentLink?: string
  [key: string]: unknown
}

export const aiProductAction = async () => {
  const apiKey = await getApiKeyFromYml()

  const spinner = new Kia(colors.cyan('Fetching AI plans and products...'))
  spinner.start()

  try {
    const raw = await callMcp(apiKey, 'get_ai_product_list')
    if (!raw) {
      spinner.fail('Failed to fetch products')
      console.log(colors.red('\n  Could not retrieve product information.'))
      console.log(colors.gray('  Visit https://slv.dev for plan details.\n'))
      return
    }

    spinner.succeed('AI Plans & Products')

    // Try to parse as JSON
    let products: Product[] | null = null
    try {
      const parsed = JSON.parse(raw)
      products = Array.isArray(parsed) ? parsed : (parsed.products ?? parsed.items ?? parsed.message ?? null)
      if (products && !Array.isArray(products)) products = null
    } catch {
      // Not JSON
    }

    if (products && products.length > 0) {
      for (const product of products) {
        const table = new Table()
        const rows: Row[] = []

        const name = product.name ?? product.product ?? 'Unknown'
        rows.push(new Row(colors.blue('Plan'), colors.bold(colors.white(String(name)))).border(true))

        if (product.description) {
          rows.push(new Row(colors.blue('Description'), colors.white(String(product.description))).border(true))
        }
        if (product.tokens !== undefined) {
          rows.push(new Row(colors.blue('Tokens'), colors.white(Number(product.tokens).toLocaleString())).border(true))
        }
        if (product.price !== undefined) {
          const currency = product.currency ?? 'EUR'
          const interval = product.interval ? `/${product.interval}` : ''
          rows.push(new Row(colors.blue('Price'), colors.white(`${product.price} ${currency}${interval}`)).border(true))
        }
        if (product.paymentLink) {
          rows.push(new Row(colors.blue('Purchase'), colors.cyan(String(product.paymentLink))).border(true))
        }

        table.body(rows)
        console.log('')
        table.render()
      }
    } else if (raw) {
      // Show raw response if not parseable as product list
      console.log(colors.white(`\n${raw}`))
    }

    console.log(colors.gray('\n  Run `slv ai usage` to check your current token balance.\n'))
  } catch (error) {
    spinner.fail('Failed to fetch AI products')
    console.log(colors.red(`\n  ${(error as Error).message}`))
    console.log(colors.gray('  Visit https://slv.dev for plan details.\n'))
  }
}
