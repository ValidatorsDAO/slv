import { spawnSync } from '@elsoul/child-process'

/**
 * Run an ansible playbook AGAINST THE LOCAL MACHINE with
 * `--connection=local`, so no SSH hop and no `solv` user is
 * required — unlike runAnsibleV2 which targets remote validator
 * hosts. Used by `slv install nginx` and the onboard HTTPS step,
 * both of which operate on the host the CLI itself is running on.
 *
 * Idempotent: if `ansible-playbook` is missing we `apt install -y
 * ansible` first (requires sudo NOPASSWD — the onboard sudoers
 * step already arranges that on Linux hosts).
 */
const ensureAnsiblePlaybook = async (): Promise<boolean> => {
  try {
    const probe = new Deno.Command('which', {
      args: ['ansible-playbook'],
      stdout: 'null',
      stderr: 'null',
    })
    const { success } = await probe.output()
    if (success) return true
  } catch { /* `which` missing — fall through to install */ }

  // Only ansible-from-apt here; the long-tail of other installers
  // (brew / dnf) is out of scope — slv's VPS playbooks target
  // Debian/Ubuntu, same restriction applies to this bootstrap.
  console.log('📦 Installing ansible (one-time) via apt...')
  const install = new Deno.Command('sudo', {
    args: ['-n', 'apt-get', 'install', '-y', 'ansible'],
    stdout: 'inherit',
    stderr: 'inherit',
  })
  const { success } = await install.output()
  if (!success) {
    console.error(
      '❌ could not install ansible. Ensure the ubuntu user has NOPASSWD sudo and retry.',
    )
    return false
  }
  return true
}

export const runAnsibleLocal = async (
  playbookPath: string,
  extraVars?: Record<string, string>,
): Promise<boolean> => {
  const ready = await ensureAnsiblePlaybook()
  if (!ready) return false

  // localhost, with trailing comma is the idiomatic ansible
  // ad-hoc-inventory for "just this machine". --connection=local
  // skips SSH entirely — become escalates via the host's native
  // sudo, which is what we want.
  let cmd =
    `ansible-playbook -i localhost, --connection=local ${playbookPath}`
  if (extraVars) {
    for (const [key, value] of Object.entries(extraVars)) {
      cmd += ` --extra-vars "${key}=${value}"`
    }
  }
  console.log(`🚀 Running ansible: ${cmd}`)
  const result = await spawnSync(cmd)
  if (!result.success) {
    console.error('❌ Ansible playbook failed. See output above.')
    return false
  }
  console.log('✔︎ Ansible playbook completed.')
  return true
}
