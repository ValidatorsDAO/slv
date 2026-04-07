import { Command } from '@cliffy'
import { colors } from '@cliffy/colors'
import { getTemplatePath } from '/lib/getTemplatePath.ts'
import { runAnsilbe } from '/lib/runAnsible.ts'
import type { InventoryType } from '@cmn/types/config.ts'

export const disableCmd = new Command()
  .description('🔒 Disable server settings')
  .action(() => {
    disableCmd.showHelp()
  })

const runLocal = async (command: string) => {
  console.log(colors.cyan(`🔧 Running locally: ${command}`))
  const result = await new Deno.Command('bash', {
    args: ['-c', command],
    stdout: 'inherit',
    stderr: 'inherit',
  }).output()
  return result.success
}

disableCmd.command('pwd-login')
  .description('🔒 Disable SSH password authentication')
  .option('-t, --target <target>', 'Inventory target (e.g. mainnet_validators)')
  .option('-p, --pubkey <pubkey>', 'Limit to a specific host')
  .action(async (options) => {
    if (options.target) {
      const target = options.target as InventoryType
      const templateRoot = getTemplatePath()
      const playbook = `${templateRoot}/ansible/cmn/disable_pwd_login.yml`
      const result = options.pubkey
        ? await runAnsilbe(playbook, target, options.pubkey)
        : await runAnsilbe(playbook, target)
      if (result) {
        console.log(
          colors.white(
            '✅ Successfully disabled SSH password authentication',
          ),
        )
      }
      return
    }

    const command = `
set -euo pipefail
sudo cp /etc/ssh/sshd_config /etc/ssh/sshd_config.bak.$(date +%Y%m%d%H%M%S)
sudo python3 - <<'PY'
from pathlib import Path

path = Path('/etc/ssh/sshd_config')
text = path.read_text()
replacements = {
    'PasswordAuthentication': 'no',
    'KbdInteractiveAuthentication': 'no',
    'ChallengeResponseAuthentication': 'no',
}
lines = text.splitlines()
seen = set()
out = []
for line in lines:
    stripped = line.strip()
    replaced = False
    for key, value in replacements.items():
        if stripped.startswith(key) or stripped.startswith(f'#{key}'):
            out.append(f'{key} {value}')
            seen.add(key)
            replaced = True
            break
    if not replaced:
        out.append(line)
for key, value in replacements.items():
    if key not in seen:
        out.append(f'{key} {value}')
path.write_text('\n'.join(out) + '\n')
PY
sudo sshd -t
sudo systemctl reload ssh
`
    const success = await runLocal(command)
    if (success) {
      console.log(
        colors.white(
          '✅ Successfully disabled SSH password authentication',
        ),
      )
    } else {
      console.log(
        colors.red('❌ Failed to disable SSH password authentication'),
      )
    }
  })
