import { METAL_API_URL } from '@cmn/constants/url.ts'
import { DISCORD_LINK } from '@cmn/constants/url.ts'

const storageHeaders = (apiKey: string) => {
  const headers = new Headers()
  headers.append('Authorization', `Bearer ${apiKey}`)
  headers.append('Content-Type', 'application/json')
  return headers
}

export class StorageApiError extends Error {
  name = 'StorageApiError'
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

const handleErrorResponse = async (response: Response): Promise<never> => {
  let serverMessage = ''
  try {
    const err = await response.json()
    serverMessage = err.message || ''
  } catch {
    // ignore parse errors
  }

  switch (response.status) {
    case 401:
      throw new StorageApiError(
        401,
        'Authentication failed. Please run `slv login` to set your API key.',
      )
    case 403:
      throw new StorageApiError(
        403,
        serverMessage.includes('limit')
          ? `Storage limit exceeded. Upgrade your plan or delete unused files.\n  Manage plan: ${DISCORD_LINK}`
          : `No active storage subscription. Purchase storage first:\n  $ slv storage usage\n  Get started: ${DISCORD_LINK}`,
      )
    case 429:
      throw new StorageApiError(
        429,
        'Monthly request limit exceeded. Your limit resets next month.\n  Upgrade your plan for higher limits.',
      )
    case 404:
      throw new StorageApiError(
        404,
        serverMessage || 'File or resource not found.',
      )
    default:
      throw new StorageApiError(
        response.status,
        serverMessage || `Request failed (HTTP ${response.status}). Please try again later.`,
      )
  }
}

export type StorageRegion = 'eu' | 'asia' | 'us-east' | 'us-west' | 'oc'

export type PresignUploadRes = {
  url: string
  method: 'PUT'
  region: string
  key: string
  expiresAt: string
}

export type PresignDownloadRes = {
  url: string
  method: 'GET'
  region: string
  expiresAt: string
}

export type StorageFile = {
  path: string
  size: number
  lastModified: string
}

export type StorageListRes = {
  files: StorageFile[]
  cursor?: string
  truncated: boolean
}

export type StorageUsageRes = {
  usedBytes: number
  fileCount: number
  egressBytes: number
  storageLimitBytes: number
  region: string
}

export const presignUpload = async (
  apiKey: string,
  path: string,
  region?: StorageRegion,
  contentType?: string,
): Promise<PresignUploadRes> => {
  const body: Record<string, string> = { path }
  if (region) body.region = region
  if (contentType) body.contentType = contentType
  const response = await fetch(`${METAL_API_URL}/storage/presign/upload`, {
    method: 'POST',
    headers: storageHeaders(apiKey),
    body: JSON.stringify(body),
  })
  if (!response.ok) await handleErrorResponse(response)
  return await response.json() as PresignUploadRes
}

export const presignDownload = async (
  apiKey: string,
  path: string,
  region?: StorageRegion,
): Promise<PresignDownloadRes> => {
  const body: Record<string, string> = { path }
  if (region) body.region = region
  const response = await fetch(`${METAL_API_URL}/storage/presign/download`, {
    method: 'POST',
    headers: storageHeaders(apiKey),
    body: JSON.stringify(body),
  })
  if (!response.ok) await handleErrorResponse(response)
  return await response.json() as PresignDownloadRes
}

export const storageList = async (
  apiKey: string,
  options?: {
    prefix?: string
    region?: StorageRegion
    limit?: number
    cursor?: string
  },
): Promise<StorageListRes> => {
  const params = new URLSearchParams()
  if (options?.prefix) params.set('prefix', options.prefix)
  if (options?.region) params.set('region', options.region)
  if (options?.limit) params.set('limit', String(options.limit))
  if (options?.cursor) params.set('cursor', options.cursor)
  const qs = params.toString()
  const url = `${METAL_API_URL}/storage/list${qs ? `?${qs}` : ''}`
  const response = await fetch(url, {
    method: 'GET',
    headers: storageHeaders(apiKey),
  })
  if (!response.ok) await handleErrorResponse(response)
  return await response.json() as StorageListRes
}

export const storageDelete = async (
  apiKey: string,
  path: string,
  region?: StorageRegion,
): Promise<{ success: boolean }> => {
  const body: Record<string, string> = { path }
  if (region) body.region = region
  const response = await fetch(`${METAL_API_URL}/storage/delete`, {
    method: 'DELETE',
    headers: storageHeaders(apiKey),
    body: JSON.stringify(body),
  })
  if (!response.ok) await handleErrorResponse(response)
  return await response.json() as { success: boolean }
}

export type StorageProduct = {
  product: string
  description: string
  imageUrls: string[]
  paymentLink: string
  price: number
}

export type StorageProductListRes = {
  success: boolean
  hasExistingStorage?: boolean
  currentStorage?: {
    storageLimitBytes: number
    currentQuantityGB: number
    usedBytes: number
    subscriptionItemId: string
  }
  upgradeEndpoint?: string
  upgradeMethod?: string
  upgradeBody?: string
  message: StorageProduct[] | string
  products?: StorageProduct[]
}

export type StorageUpgradeRes = {
  success: boolean
  message: {
    previousQuantity: number
    newQuantity: number
    proratedAmount?: string
  }
}

export const storageProductList = async (
  apiKey: string,
): Promise<StorageProductListRes> => {
  const response = await fetch(`${METAL_API_URL}/storage/product-list`, {
    method: 'GET',
    headers: storageHeaders(apiKey),
  })
  if (!response.ok) await handleErrorResponse(response)
  return await response.json() as StorageProductListRes
}

export const storageUpgradePlan = async (
  apiKey: string,
  quantity: number,
): Promise<StorageUpgradeRes> => {
  const response = await fetch(`${METAL_API_URL}/storage/upgrade-plan`, {
    method: 'POST',
    headers: storageHeaders(apiKey),
    body: JSON.stringify({ quantity }),
  })
  if (!response.ok) await handleErrorResponse(response)
  return await response.json() as StorageUpgradeRes
}

export const storageUsage = async (
  apiKey: string,
): Promise<StorageUsageRes> => {
  const response = await fetch(`${METAL_API_URL}/storage/usage`, {
    method: 'GET',
    headers: storageHeaders(apiKey),
  })
  if (!response.ok) await handleErrorResponse(response)
  return await response.json() as StorageUsageRes
}
