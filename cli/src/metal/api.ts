import { METAL_API_URL } from '@cmn/constants/url.ts'

const makeHeaders = (apiKey: string) => {
  const headers = new Headers()
  headers.append('Authorization', `Bearer ${apiKey}`)
  headers.append('Content-Type', 'application/json')
  return headers
}

export const metalStatus = async (apiKey: string) => {
  const res = await fetch(`${METAL_API_URL}/baremetal/status`, {
    method: 'GET',
    headers: makeHeaders(apiKey),
  })
  return await res.json() as { success: boolean; message: any[] }
}

export const metalAvailability = async (apiKey: string, region: string) => {
  const res = await fetch(
    `${METAL_API_URL}/baremetal/search-available-baremetal?region=${encodeURIComponent(region)}&limit=25`,
    {
      method: 'GET',
      headers: makeHeaders(apiKey),
    },
  )
  return await res.json() as { success: boolean; message: any[] }
}

export const metalRestart = async (apiKey: string, bareMetalIp: string) => {
  const res = await fetch(`${METAL_API_URL}/baremetal/restart`, {
    method: 'POST',
    headers: makeHeaders(apiKey),
    body: JSON.stringify({ bareMetalIp }),
  })
  return await res.json() as { success: boolean; message: string }
}

export const metalRebuild = async (apiKey: string, bareMetalIp: string) => {
  const res = await fetch(`${METAL_API_URL}/baremetal/rebuild-bm`, {
    method: 'POST',
    headers: makeHeaders(apiKey),
    body: JSON.stringify({ bareMetalIp }),
  })
  return await res.json() as { success: boolean; message: string }
}

export const metalChangeRegion = async (
  apiKey: string,
  bareMetalIp: string,
  region: string,
) => {
  const res = await fetch(`${METAL_API_URL}/baremetal/change-region`, {
    method: 'POST',
    headers: makeHeaders(apiKey),
    body: JSON.stringify({ bareMetalIp, region }),
  })
  return await res.json() as { success: boolean; message: string }
}

export const metalRescue = async (apiKey: string, bareMetalIp: string) => {
  const res = await fetch(`${METAL_API_URL}/baremetal/rescue`, {
    method: 'POST',
    headers: makeHeaders(apiKey),
    body: JSON.stringify({ bareMetalIp }),
  })
  return await res.json() as { success: boolean; message: string }
}

export const metalRescueBack = async (apiKey: string, bareMetalIp: string) => {
  const res = await fetch(`${METAL_API_URL}/baremetal/rescue-back`, {
    method: 'POST',
    headers: makeHeaders(apiKey),
    body: JSON.stringify({ bareMetalIp }),
  })
  return await res.json() as { success: boolean; message: string }
}
