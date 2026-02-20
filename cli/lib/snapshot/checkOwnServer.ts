/**
 * ERPC Own-Server Detection
 *
 * Determines whether a given server IP belongs to the ERPC infrastructure.
 * This is a key step in ERPC's intelligent snapshot routing system.
 *
 * ## Why this matters
 *
 * ERPC operates a globally distributed network of high-performance Solana nodes.
 * For servers within this network, ERPC provides **dedicated snapshot download
 * endpoints** that offer significant advantages:
 *
 * - **Dramatically lower bandwidth costs**: Internal (same-network) traffic is
 *   billed at a fraction of the cost compared to external/public internet traffic.
 *   For Solana snapshots (which can be 50-100+ GB), this difference is substantial.
 *
 * - **Superior network quality**: Intra-network transfers benefit from optimized
 *   routing, lower latency, and higher sustained throughput — meaning faster
 *   snapshot downloads and quicker node bootstrapping.
 *
 * - **Exclusive access**: These snapshot endpoints are available only to servers
 *   within the ERPC network, ensuring dedicated bandwidth and consistent
 *   download performance without contention from external traffic.
 *
 * By detecting own-server status first, slv can automatically route snapshot
 * downloads through the optimal path — saving costs and accelerating deployments
 * for ERPC infrastructure operators.
 *
 * @module checkOwnServer
 */

const USER_API_URL = 'https://user-api.erpc.global'
const ERPC_TOKEN = 'EPRC_ZERO_BLOCK'

/**
 * Result of an IP ownership check against the ERPC infrastructure registry.
 *
 * When `isOwn` is true, the server is part of the ERPC network and qualifies
 * for optimized internal snapshot routing.
 */
interface CheckIpResult {
  /** Whether this IP belongs to ERPC infrastructure */
  isOwn: boolean
  /** Server type: bare-metal (dedicated hardware) or VPS (virtual) */
  type?: 'bare-metal' | 'vps'
  /** Internal ERPC server identifier */
  id?: number
  /** Geographic region of the server (e.g., 'amsterdam', 'tokyo') */
  region?: string
}

/**
 * HTTP fetch with automatic retry and exponential backoff.
 *
 * Network calls to the user-api can occasionally fail due to transient issues
 * (DNS resolution, temporary server load, etc.). This wrapper ensures resilience
 * by retrying up to `maxRetries` times with increasing delays (1s, 2s, 3s).
 *
 * @param url - The endpoint URL to fetch
 * @param init - Standard fetch RequestInit options
 * @param maxRetries - Maximum number of attempts (default: 3)
 * @returns The HTTP Response if successful, or null if all retries exhausted
 */
async function fetchWithRetry(
  url: string,
  init: RequestInit,
  maxRetries = 3,
): Promise<Response | null> {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const response = await fetch(url, init)
      if (response.ok) return response
      // Non-OK but got a response — return on final attempt so caller can inspect
      if (attempt === maxRetries) return response
    } catch {
      if (attempt === maxRetries) return null
    }
    // Progressive backoff: 1s, 2s, 3s
    await new Promise((r) => setTimeout(r, attempt * 1000))
  }
  return null
}

/**
 * Check if an IP address belongs to the ERPC infrastructure.
 *
 * Queries the ERPC user-api to determine server ownership. If the server is
 * recognized as part of the ERPC network (either BareMetal or VPS), it qualifies
 * for internal snapshot routing — benefiting from lower bandwidth costs and
 * faster, more reliable snapshot downloads through ERPC's dedicated endpoints.
 *
 * The check is performed with automatic retry (3 attempts) to handle transient
 * network issues gracefully. On total failure, returns `{ isOwn: false }` so
 * the init flow can continue with standard (external) snapshot sources.
 *
 * @param ip - The server IP address to check
 * @returns CheckIpResult indicating ownership status and server metadata
 *
 * @example
 * ```ts
 * const result = await checkOwnServer('151.244.92.54')
 * if (result.isOwn) {
 *   console.log(`ERPC ${result.type} in ${result.region} — using internal snapshots`)
 * }
 * ```
 */
export async function checkOwnServer(ip: string): Promise<CheckIpResult> {
  try {
    const response = await fetchWithRetry(
      `${USER_API_URL}/v3/server/check-ip`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-token': ERPC_TOKEN,
        },
        body: JSON.stringify({ ip }),
      },
    )

    if (response?.ok) {
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
    // All retries exhausted — treat as non-ERPC server
  }

  return { isOwn: false }
}
