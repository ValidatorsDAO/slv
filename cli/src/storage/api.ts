import { METAL_API_URL } from '@cmn/constants/url.ts'


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
          ? `Storage limit exceeded.\n  Check usage:  slv storage usage\n  Free space:   slv storage rm <path>\n  Upgrade:      slv storage upgrade`
          : `No active storage subscription.\n  Browse plans: slv storage product`,
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
  monthlyAccessCount?: number
  monthlyAccessLimit?: number
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
  message: StorageProduct[] | string
  products?: StorageProduct[]
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

export type StorageUpgradeRes = {
  success: boolean
  message: {
    previousQuantityGB: number
    newQuantityGB: number
    subscriptionItemId: string
    note: string
  }
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

// ── Sync API ──

export type StorageSyncRes = {
  success: boolean
  r2UsedBytes: number
  r2FileCount: number
  dbUsedBytes: number
  dbFileCount: number
  corrected: boolean
}

export const storageSync = async (
  apiKey: string,
  region?: StorageRegion,
): Promise<StorageSyncRes> => {
  const body: Record<string, string> = {}
  if (region) body.region = region
  const response = await fetch(`${METAL_API_URL}/storage/sync`, {
    method: 'POST',
    headers: storageHeaders(apiKey),
    body: JSON.stringify(body),
  })
  if (!response.ok) await handleErrorResponse(response)
  return await response.json() as StorageSyncRes
}

// ── Multipart Upload API ──

export type MultipartCreateRes = {
  uploadId: string
  key: string
  region: string
}

export type MultipartUploadPartRes = {
  partNumber: number
  etag: string
}

export type MultipartCompleteRes = {
  success: boolean
  key: string
  region: string
}

export const multipartCreate = async (
  apiKey: string,
  path: string,
  fileSize: number,
  region?: StorageRegion,
  contentType?: string,
): Promise<MultipartCreateRes> => {
  const body: Record<string, string | number> = { path, fileSize }
  if (region) body.region = region
  if (contentType) body.contentType = contentType
  const response = await fetch(`${METAL_API_URL}/storage/multipart/create`, {
    method: 'POST',
    headers: storageHeaders(apiKey),
    body: JSON.stringify(body),
  })
  if (!response.ok) await handleErrorResponse(response)
  return await response.json() as MultipartCreateRes
}

export const multipartUploadPart = async (
  apiKey: string,
  uploadId: string,
  key: string,
  partNumber: number,
  body: Uint8Array,
  region?: StorageRegion,
): Promise<MultipartUploadPartRes> => {
  const params = new URLSearchParams({
    uploadId,
    key,
    partNumber: String(partNumber),
  })
  if (region) params.set('region', region)

  const response = await fetch(
    `${METAL_API_URL}/storage/multipart/upload-part?${params}`,
    {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/octet-stream',
      },
      body,
    },
  )
  if (!response.ok) await handleErrorResponse(response)
  return await response.json() as MultipartUploadPartRes
}

export const multipartComplete = async (
  apiKey: string,
  uploadId: string,
  key: string,
  parts: { partNumber: number; etag: string }[],
  region?: StorageRegion,
): Promise<MultipartCompleteRes> => {
  const body: Record<string, unknown> = { uploadId, key, parts }
  if (region) body.region = region
  const response = await fetch(`${METAL_API_URL}/storage/multipart/complete`, {
    method: 'POST',
    headers: storageHeaders(apiKey),
    body: JSON.stringify(body),
  })
  if (!response.ok) await handleErrorResponse(response)
  return await response.json() as MultipartCompleteRes
}
