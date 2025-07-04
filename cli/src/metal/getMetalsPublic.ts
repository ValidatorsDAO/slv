import { METAL_API_URL } from '@cmn/constants/url.ts'
import type { z } from '@hono/zod-openapi'
import type { ListProductRes } from '@cmn/types/metal.ts'

export type MetalType = 'APP' | 'RPC' | 'MV'

const getMetalsPublic = async (
  metalType: MetalType = 'APP',
) => {
  try {
    const myHeaders = new Headers()
    myHeaders.append('x-token', 'solv')
    myHeaders.append('Content-Type', 'application/json')
    const requestOptions = {
      method: 'GET',
      headers: myHeaders,
    }
    const response = await fetch(
      `${METAL_API_URL}/baremetal/list/public/${metalType}`,
      requestOptions,
    )
    const result = await response.json() as z.infer<typeof ListProductRes>
    return result
  } catch (error) {
    console.error(error)
    throw new Error('Failed to get metals')
  }
}

export { getMetalsPublic }
