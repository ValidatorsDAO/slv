/**
 * Generate `byteCount` bytes of cryptographic randomness and return
 * them as a lowercase hex string. 32 bytes → 64 hex chars = 256 bits
 * of entropy, suitable for auth tokens and API keys.
 */
export const randomHex = (byteCount: number): string => {
  const buf = new Uint8Array(byteCount)
  crypto.getRandomValues(buf)
  return Array.from(buf, (b) => b.toString(16).padStart(2, '0')).join('')
}
