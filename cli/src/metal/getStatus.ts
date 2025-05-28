import { METAL_API_URL } from '@cmn/constants/url.ts'
import type { z } from '@hono/zod-openapi'
import type { BareMetalStatusRes } from '@cmn/types/metal.ts'

export type Subscription = {
  subscriptionID: string
  productId: string
  productName: string
  price: number
  username: string
  host: string
  ip: string
  os: string
  cpu: string
  ram: string
  disk: string
  nics: string
  region: string
  tags: string
  isMainnet: string // "true" | "false" でもOK
  isTestnet: string
  isRPC: string
  isApp: string
  status: string
  startDate: string
  endDate: string
}

export type SubscriptionResponse = {
  success: boolean
  message: Subscription[]
}

const getStatus = async (apiKey: string) => {
  try {
    const myHeaders = new Headers()
    myHeaders.append('x-token', 'solv')
    myHeaders.append(
      'Authorization',
      `Bearer ${apiKey}`,
    )
    myHeaders.append('Content-Type', 'application/json')
    const requestOptions = {
      method: 'GET',
      headers: myHeaders,
    }
    const response = await fetch(
      METAL_API_URL + '/baremetal/status',
      requestOptions,
    )
    const result = await response.json() as z.infer<typeof BareMetalStatusRes>
    return result
  } catch (error) {
    console.error(error)
    throw new Error('Failed to get status')
  }
}

export { getStatus }
