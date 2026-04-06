import { getApiKeyFromYml } from '/lib/getApiKeyFromYml.ts'
import { colors } from '@cliffy/colors'
import Kia from 'https://deno.land/x/kia@0.4.1/mod.ts'
import {
  divider,
  formatBulletList,
  formatKeyValueFields,
  formatLink,
  getTerminalWidth,
  type KeyValueField,
  wrapText,
} from '@/ai/rendering.ts'
import {
  type AuthorizationStatus,
  fetchAuthorizationStatus,
} from '@/ai/authorization.ts'

type McpResponse = {
  result?: {
    content?: Array<{ type: string; text?: string }>
  }
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
  authorizationLink?: string
  authorizationUrl?: string
  authLink?: string
  authUrl?: string
  [key: string]: unknown
}

async function callMcp(
  apiKey: string,
  toolName: string,
  args: Record<string, unknown> = {},
): Promise<string> {
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

function getAuthorizationLink(product: Product): string {
  return String(
    product.authorizationLink ?? product.authorizationUrl ??
      product.authLink ?? product.authUrl ??
      product.paymentLink ??
      '',
  )
}

function isSecureAuthorizationProduct(product: Product): boolean {
  const name = String(product.name ?? product.product ?? '').toLowerCase()
  return name.includes('secure authorization') || name.includes('authorization')
}

function normalizeDescription(product: Product): string {
  const name = String(product.name ?? product.product ?? '').toLowerCase()
  if (!isSecureAuthorizationProduct(product)) {
    return String(product.description ?? '').trim()
  }

  if (name.includes('secure authorization')) {
    return 'Complete Authorization to receive 100,000 free AI tokens and unlock additional shared SLV services.'
  }

  return String(product.description ?? '').trim()
}

function getAuthorizationCtaLink(
  authorizationStatus: AuthorizationStatus,
  products: Product[],
): string | null {
  if (authorizationStatus.authorizationLink) {
    return authorizationStatus.authorizationLink
  }

  const authorizationProduct = products.find((product) =>
    isSecureAuthorizationProduct(product)
  )

  if (!authorizationProduct) return null

  const link = getAuthorizationLink(authorizationProduct)
  return link || null
}

export const aiProductAction = async () => {
  const apiKey = await getApiKeyFromYml()

  const spinner = new Kia(colors.cyan('Fetching AI plans and products...'))
  spinner.start()

  try {
    const [raw, authorizationStatus] = await Promise.all([
      callMcp(apiKey, 'get_ai_product_list'),
      fetchAuthorizationStatus(apiKey),
    ])

    if (!raw) {
      spinner.fail('Failed to fetch products')
      console.log(colors.red('  Could not retrieve product information.'))
      console.log(colors.gray('  Visit https://slv.dev for plan details.'))
      return
    }

    spinner.succeed('AI Plans & Products')

    let products: Product[] | null = null
    try {
      const parsed = JSON.parse(raw)
      products = Array.isArray(parsed)
        ? parsed
        : (parsed.products ?? parsed.items ?? parsed.message ?? null)
      if (products && !Array.isArray(products)) products = null
    } catch {
      // Not JSON
    }

    if (!products || products.length === 0) {
      console.log(colors.white(wrapText(raw, getTerminalWidth(), '  ', '  ')))
      return
    }

    const width = getTerminalWidth()
    const visibleProducts = products.filter((product) => {
      if (authorizationStatus.state !== 'authorized') return true
      return !isSecureAuthorizationProduct(product)
    })
    const authorizationCtaLink = getAuthorizationCtaLink(
      authorizationStatus,
      products,
    )

    console.log(colors.bold('\nAI Plans & Products\n'))

    if (visibleProducts.length === 0) {
      console.log(
        formatBulletList([
          'No purchasable AI products are currently available for this account.',
        ], width),
      )
      return
    }

    for (const [index, product] of visibleProducts.entries()) {
      const name = String(product.name ?? product.product ?? 'Unknown')
      const description = normalizeDescription(product)
      const fields: KeyValueField[] = [{ label: 'Plan', value: name }]

      if (description) {
        fields.push({ label: 'Description', value: description })
      }
      if (product.tokens !== undefined) {
        fields.push({
          label: 'Tokens',
          value: Number(product.tokens).toLocaleString(),
        })
      }
      if (product.price !== undefined) {
        const currency = product.currency ?? 'EUR'
        const interval = product.interval ? `/${product.interval}` : ''
        fields.push({
          label: 'Price',
          value: `${product.price} ${currency}${interval}`,
        })
      }

      const lines: string[] = [formatKeyValueFields(fields, width)]

      const purchaseUrl = product.paymentLink ? String(product.paymentLink) : ''
      if (purchaseUrl && !isSecureAuthorizationProduct(product)) {
        lines.push(formatLink('Purchase', purchaseUrl, width))
      }

      if (
        isSecureAuthorizationProduct(product) &&
        authorizationStatus.state === 'unauthorized'
      ) {
        if (authorizationCtaLink) {
          lines.push(formatLink('Authorization', authorizationCtaLink, width))
        }
      }

      console.log(lines.join('\n'))

      if (index < visibleProducts.length - 1) {
        console.log(divider(width))
      }
    }

    console.log(
      colors.gray(
        '\n  You can also purchase from Discord: https://discord.com/channels/1278625724248494120/1488527495639601233',
      ),
    )
    console.log()
  } catch (error) {
    spinner.fail('Failed to fetch AI products')
    console.log(colors.red(`  ${(error as Error).message}`))
    console.log(colors.gray('  Visit https://slv.dev for plan details.'))
  }
}
