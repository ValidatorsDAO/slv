/**
 * Recognize the various shapes of "stream was aborted via AbortSignal"
 * thrown by Anthropic / OpenAI SDKs and Deno's own fetch / stream APIs.
 * Matching on `.name === 'AbortError'` alone misses:
 *   - Anthropic SDK's `APIUserAbortError` (different name)
 *   - DOMException with code 20 (browser fetch)
 *   - Generic TypeError with message 'The operation was aborted.'
 */
export const isAbortLikeError = (e: unknown): boolean => {
  if (!e || typeof e !== 'object') return false
  const err = e as { name?: string; message?: string; code?: unknown }
  if (err.name === 'AbortError' || err.name === 'APIUserAbortError') return true
  if (typeof err.message === 'string' && /aborted/i.test(err.message)) {
    return true
  }
  return false
}
