/** Bootstrap and 1Password-backed identities must not fall into legacy file signers. */
export const validatorSigningRefusal = (
  host: { noVoting?: boolean; identityRef?: string },
): string | null => {
  if (host.noVoting) {
    return 'This host is configured for sync-only startup (no_voting). Voting activation is not part of this setup. Do not remove the flag to bypass this guard.'
  }
  if (host.identityRef?.startsWith('op://')) {
    return 'This identity is stored in 1Password. This operation still requires the legacy file-based signer; 1Password-backed voting activation is not implemented. Do not export a key to bypass this guard.'
  }
  return null
}
