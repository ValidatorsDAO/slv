const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'

/** A Solana public key or signature as text: 32 to 44 characters of the base58 alphabet. */
const BASE58_PUBKEY = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/

/** The base58 text of `bytes`, in the alphabet that Solana uses. */
const encodeBase58 = (bytes: Uint8Array): string => {
  let zeros = 0
  while (zeros < bytes.length && bytes[zeros] === 0) zeros++
  // The digits of the number, least significant first.
  const digits: number[] = []
  for (let i = zeros; i < bytes.length; i++) {
    let carry = bytes[i]
    for (let j = 0; j < digits.length; j++) {
      carry += digits[j] * 256
      digits[j] = carry % 58
      carry = Math.floor(carry / 58)
    }
    while (carry > 0) {
      digits.push(carry % 58)
      carry = Math.floor(carry / 58)
    }
  }
  let text = '1'.repeat(zeros)
  for (let i = digits.length - 1; i >= 0; i--) text += ALPHABET[digits[i]]
  return text
}

export { BASE58_PUBKEY, encodeBase58 }
