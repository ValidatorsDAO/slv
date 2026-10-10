import { METAL_API_URL } from '@cmn/constants/url.ts'
import { type UserApiAuth, userApiAuthHeader } from '/lib/userApi/auth.ts'

const makeHeaders = async (auth: UserApiAuth) => {
  const headers = new Headers()
  headers.append('Authorization', await userApiAuthHeader(auth))
  headers.append('Content-Type', 'application/json')
  return headers
}

export const metalStatus = async (auth: UserApiAuth) => {
  const res = await fetch(`${METAL_API_URL}/baremetal/status`, {
    method: 'GET',
    headers: await makeHeaders(auth),
  })
  return await res.json() as { success: boolean; message: any[] }
}

export const metalAvailability = async (auth: UserApiAuth, region: string) => {
  const res = await fetch(
    `${METAL_API_URL}/baremetal/search-available-baremetal?region=${encodeURIComponent(region)}&limit=25`,
    {
      method: 'GET',
      headers: await makeHeaders(auth),
    },
  )
  return await res.json() as { success: boolean; message: any[] }
}

export const metalRestart = async (auth: UserApiAuth, bareMetalIp: string) => {
  const res = await fetch(`${METAL_API_URL}/baremetal/restart`, {
    method: 'POST',
    headers: await makeHeaders(auth),
    body: JSON.stringify({ bareMetalIp }),
  })
  return await res.json() as { success: boolean; message: string }
}

export const metalRebuild = async (auth: UserApiAuth, bareMetalIp: string) => {
  const res = await fetch(`${METAL_API_URL}/baremetal/rebuild-bm`, {
    method: 'POST',
    headers: await makeHeaders(auth),
    body: JSON.stringify({ bareMetalIp }),
  })
  return await res.json() as { success: boolean; message: string }
}

export const metalChangeRegion = async (
  auth: UserApiAuth,
  bareMetalIp: string,
  region: string,
) => {
  const res = await fetch(`${METAL_API_URL}/baremetal/change-region`, {
    method: 'POST',
    headers: await makeHeaders(auth),
    body: JSON.stringify({ bareMetalIp, region }),
  })
  return await res.json() as { success: boolean; message: string }
}

export const metalRescue = async (auth: UserApiAuth, bareMetalIp: string) => {
  const res = await fetch(`${METAL_API_URL}/baremetal/rescue`, {
    method: 'POST',
    headers: await makeHeaders(auth),
    body: JSON.stringify({ bareMetalIp }),
  })
  return await res.json() as { success: boolean; message: string }
}

export const metalRescueBack = async (auth: UserApiAuth, bareMetalIp: string) => {
  const res = await fetch(`${METAL_API_URL}/baremetal/rescue-back`, {
    method: 'POST',
    headers: await makeHeaders(auth),
    body: JSON.stringify({ bareMetalIp }),
  })
  return await res.json() as { success: boolean; message: string }
}
