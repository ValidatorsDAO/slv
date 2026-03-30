import type { SSHConnection } from '@cmn/prompt/checkSSHConnection.ts'

/**
 * Return a pseudo-SSHConnection for localhost mode.
 * No SSH is needed — Ansible uses `ansible_connection: local`.
 */
export const getLocalConnection = (): SSHConnection => ({
  username: Deno.env.get('USER') || 'solv',
  ip: 'localhost',
  rsa_key_path: '',
})
