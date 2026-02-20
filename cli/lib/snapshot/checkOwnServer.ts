/**
 * Check if a server IP belongs to ERPC infrastructure
 * Uses user-api check-ip endpoint (public-facing, rate-limited)
 */

const USER_API_URL = 'https://user-api.erpc.global'
const SOLV_TOKEN = 'heySOLV420!'

interface CheckIpResult {
  isOwn: boolean
  type?: 'bare-metal' | 'vps'
  id?: number
  region?: string
}

/**
 * Check if an IP belongs to ERPC BareMetal or VPS infrastructure
 * @param ip - The server IP address to check
 * @returns CheckIpResult with ownership info
 */
export async function checkOwnServer(ip: string): Promise<CheckIpResult> {
  try {
    const response = await fetch(`${USER_API_URL}/v3/server/check-ip`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-token': SOLV_TOKEN,
      },
      body: JSON.stringify({ ip }),
    })

    if (response.ok) {
      const data = await response.json()
      if (data.success && data.data?.exists) {
        return {
          isOwn: true,
          type: data.data.type,
          id: data.data.id,
          region: data.data.region,
        }
      }
    }
  } catch {
    // API check failed
  }

  return { isOwn: false }
}
