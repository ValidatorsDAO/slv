import { colors } from '@cliffy/colors'
import { Confirm } from '@cliffy/prompt'
import { errToString } from '/lib/errToString.ts'

/**
 * Opt-in NOPASSWD sudoers installer for dev-VPS use.
 *
 * Installs `<user> ALL=(ALL) NOPASSWD: ALL` in a drop-in file at
 * `/etc/sudoers.d/slv-<user>`. The scope is broad on purpose — this is
 * aimed at a dedicated single-user development VPS where the user
 * already has unrestricted sudo. The payoff is that `slv c` can run
 * `systemctl`, `mv` into `/etc/systemd/system/`, and anything else the
 * AI may need, without ever prompting for a password mid-build.
 *
 * NOT for shared hosts, production, or any machine the user doesn't
 * fully own. The onboard prompt spells this out before the one-time
 * interactive sudo that writes the file.
 */

const SUDOERS_DROPIN_PREFIX = '/etc/sudoers.d/slv-'

export type InstallStatus =
  | { state: 'skipped'; reason: 'not_linux' | 'no_systemd' | 'declined' }
  | { state: 'already_installed'; path: string }
  | { state: 'installed'; path: string }
  | { state: 'failed'; err: string }

const runAndCapture = async (
  cmd: string,
  args: string[],
  stdin: 'null' | 'inherit' = 'null',
): Promise<{ success: boolean; stdout: string; stderr: string }> => {
  const c = new Deno.Command(cmd, {
    args,
    stdin,
    stdout: 'piped',
    stderr: 'piped',
  })
  const out = await c.output()
  const decoder = new TextDecoder()
  return {
    success: out.success,
    stdout: decoder.decode(out.stdout),
    stderr: decoder.decode(out.stderr),
  }
}

/**
 * Quick platform gate. macOS has no /etc/sudoers.d convention the same way
 * (Homebrew + launchd, no systemd), and we only install sudoers when the
 * user will actually benefit — i.e. Linux with systemd present.
 */
export const isSudoersTarget = async (): Promise<boolean> => {
  if (Deno.build.os !== 'linux') return false
  try {
    const st = await Deno.stat('/run/systemd/system')
    return st.isDirectory
  } catch {
    return false
  }
}

const currentUsername = (): string =>
  Deno.env.get('USER') || Deno.env.get('LOGNAME') || 'solv'

const sudoersPath = (user: string) => `${SUDOERS_DROPIN_PREFIX}${user}`

const sudoersContent = (user: string): string =>
  // Trailing newline required — sudoers parser rejects files without one on
  // some distros.
  `# Installed by \`slv onboard\` — allow ${user} to run sudo without a\n` +
  `# password on this machine. Intended for dedicated single-user dev VPS\n` +
  `# only. Remove with: sudo rm ${sudoersPath(user)}\n` +
  `${user} ALL=(ALL) NOPASSWD: ALL\n`

/**
 * Test if our sudoers drop-in already exists with the expected contents.
 * If present + matching we skip the install prompt entirely — makes
 * re-running `slv onboard` idempotent.
 */
const alreadyInstalled = async (user: string): Promise<boolean> => {
  const path = sudoersPath(user)
  // The file is 0440 root:root, so we can't read it as a normal user. Use
  // `sudo -n cat` — if sudo is already set up via this file, -n succeeds
  // silently. If it's not set up, -n fails and we treat that as "not
  // installed" (the next step will write it).
  const probe = await runAndCapture('sudo', ['-n', 'cat', path])
  if (!probe.success) return false
  return probe.stdout.includes(`${user} ALL=(ALL) NOPASSWD: ALL`)
}

/**
 * Interactive one-time install. Returns structured status so callers can
 * persist a timestamp to api.yml and decide whether to re-offer later.
 */
export const promptAndInstallSudoers = async (options: {
  t: (msg: string) => string
}): Promise<InstallStatus> => {
  const { t } = options

  if (Deno.build.os !== 'linux') {
    return { state: 'skipped', reason: 'not_linux' }
  }
  if (!(await isSudoersTarget())) {
    return { state: 'skipped', reason: 'no_systemd' }
  }

  const user = currentUsername()

  if (await alreadyInstalled(user)) {
    return { state: 'already_installed', path: sudoersPath(user) }
  }

  console.log()
  console.log(
    colors.bold.yellow(
      `  🔧 ${
        t(
          'Set up passwordless sudo for slv on this machine?',
        )
      }`,
    ),
  )
  console.log()
  console.log(
    colors.white(
      `    ${
        t(
          'This installs {path} so `slv c` can run systemctl and file installs without',
        ).replace('{path}', sudoersPath(user))
      }`,
    ),
  )
  console.log(
    colors.white(
      `    ${
        t(
          'prompting for a password mid-build. The rule grants NOPASSWD: ALL to your user.',
        )
      }`,
    ),
  )
  console.log()
  console.log(
    colors.bold.red(
      `    ⚠ ${
        t(
          'Only choose Yes on a dedicated single-user dev VPS you fully own.',
        )
      }`,
    ),
  )
  console.log(
    colors.white(
      `    ${
        t(
          'Do NOT enable on shared hosts, staging, or production. Remove later with:',
        )
      }`,
    ),
  )
  console.log(colors.gray(`        sudo rm ${sudoersPath(user)}`))
  console.log()

  const ok = await Confirm.prompt({
    message: t('Install passwordless sudo for this user now?'),
    default: false,
  })
  if (!ok) {
    console.log(
      colors.gray(
        `  ${
          t(
            'Skipped. You can re-run `slv onboard` to set this up later.',
          )
        }`,
      ),
    )
    return { state: 'skipped', reason: 'declined' }
  }

  // Write content to a staging file we control, validate with visudo, and
  // hand off to `sudo mv` — this is the one interactive sudo in the flow
  // (stdin inherited so the user can type their password).
  let tmpPath: string
  try {
    tmpPath = await Deno.makeTempFile({
      prefix: 'slv-sudoers-',
      suffix: '.tmp',
    })
    await Deno.writeTextFile(tmpPath, sudoersContent(user))
    await Deno.chmod(tmpPath, 0o440).catch(() => {})
  } catch (err) {
    return {
      state: 'failed',
      err: `staging file write failed: ${errToString(err)}`,
    }
  }

  try {
    const check = await runAndCapture('visudo', ['-cf', tmpPath])
    if (!check.success) {
      return {
        state: 'failed',
        err: `visudo validation failed: ${check.stderr.trim() || 'unknown'}`,
      }
    }

    // One interactive sudo. We intentionally inherit stdin so the TTY
    // password prompt can reach the user. If we're somehow invoked with
    // no TTY this will fail fast (not hang) because sudo detects
    // isatty(0) and refuses to prompt.
    const dest = sudoersPath(user)
    console.log(
      colors.cyan(`\n  🔐 ${t('sudo is about to ask for your password once.')}`),
    )
    const install = await runAndCapture('sudo', ['mv', tmpPath, dest], 'inherit')
    if (!install.success) {
      return {
        state: 'failed',
        err: `sudo mv failed: ${install.stderr.trim() || 'unknown'}`,
      }
    }
    // sudoers requires exactly 0440; the previous chmod was on the tmp copy.
    const chmod = await runAndCapture(
      'sudo',
      ['chmod', '0440', dest],
      'inherit',
    )
    if (!chmod.success) {
      // Non-fatal but unusual; surface it.
      console.log(
        colors.yellow(
          `  ⚠ ${
            t(
              'Could not chmod 0440 on sudoers file. sudo may refuse to read it.',
            )
          }`,
        ),
      )
    }
    console.log(
      colors.green(`  ✅ ${t('Passwordless sudo installed at')} ${dest}`),
    )
    return { state: 'installed', path: dest }
  } finally {
    // If anything failed above, the staging file might still exist.
    await Deno.remove(tmpPath).catch(() => {})
  }
}
