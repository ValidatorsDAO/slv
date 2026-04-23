import { colors } from '@cliffy/colors'
import { Confirm } from '@cliffy/prompt'
import { localExec } from '/src/bot/execUtil.ts'

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

// POSIX username validation. useradd enforces this regex on most Linux.
// Rejecting anything that doesn't match closes off sudoers-directive
// injection via a crafted `$USER` (e.g. "foo\nDefaults !authenticate").
// We also reject "root" explicitly — root already has root, so the
// drop-in is both pointless and a misleading footgun, AND reject empty
// strings / the 'solv' fallback when no user env is set.
const USERNAME_RE = /^[a-z_][a-z0-9_-]{0,31}$/

type InstallStatusCore =
  | { state: 'skipped'; reason: 'not_linux' | 'no_systemd' | 'declined' | 'bad_user' | 'root' }
  | { state: 'already_installed'; path: string }
  | { state: 'foreign_file_exists'; path: string }
  | { state: 'installed'; path: string }
  | { state: 'failed'; err: string }
export type InstallStatus = InstallStatusCore

/**
 * Quick platform gate. macOS has no /etc/sudoers.d convention the same
 * way (Homebrew + launchd, no systemd), and we only install sudoers
 * when the user will actually benefit — i.e. Linux with systemd.
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

const rawUsername = (): string =>
  (Deno.env.get('USER') || Deno.env.get('LOGNAME') || '').trim()

const sudoersPath = (user: string) => `${SUDOERS_DROPIN_PREFIX}${user}`

// Stable marker embedded in every file we write. Presence on any line
// of an existing drop-in marks it as "ours" — which lets us revise the
// rest of the comment text in future versions without flipping existing
// installs from 'ours' to 'foreign'.
const SLV_MARKER = '# SLV-MANAGED-ONBOARD-NOPASSWD-V1'

const sudoersContent = (user: string): string =>
  // Trailing newline required — sudoers parser rejects files without
  // one on some distros.
  `${SLV_MARKER}\n` +
  `# Installed by \`slv onboard\` — allow ${user} to run sudo without\n` +
  `# a password on this machine. Intended for dedicated single-user\n` +
  `# dev VPS only. Remove with: sudo rm ${sudoersPath(user)}\n` +
  `${user} ALL=(ALL) NOPASSWD: ALL\n`

/**
 * Returns 'ours' if a drop-in exists at our path AND contains our
 * magic marker; 'foreign' if a file exists but lacks the marker
 * (hand-edited or installed by another tool — we refuse to clobber);
 * 'absent' if no file is there.
 *
 * The drop-in is 0440 root:root, so we read via `sudo -n cat`. If
 * `sudo -n` itself fails (the user has no sudo access at all, or no
 * prior cached ticket AND no matching NOPASSWD rule), we can't tell
 * absent vs present — but we also can't proceed with the install, so
 * returning 'absent' routes to the install flow which will itself
 * prompt interactively.
 */
const inspectExisting = async (
  user: string,
): Promise<'ours' | 'foreign' | 'absent'> => {
  const probe = await localExec('sudo', ['-n', 'cat', sudoersPath(user)])
  if (!probe.success) return 'absent'
  return probe.stdout.includes(SLV_MARKER) ? 'ours' : 'foreign'
}

/**
 * Interactive one-time install. Returns structured status so callers
 * can persist a flag to api.yml and decide whether to re-offer later.
 */
export const promptAndInstallSudoers = async (options: {
  t: (msg: string) => string
  /**
   * When set, skip the Confirm and apply this answer directly —
   * used by `slv onboard --config <path>` to drive the flow
   * non-interactively.
   */
  preset?: boolean
}): Promise<InstallStatus> => {
  const { t, preset } = options

  if (Deno.build.os !== 'linux') {
    return { state: 'skipped', reason: 'not_linux' }
  }
  if (!(await isSudoersTarget())) {
    return { state: 'skipped', reason: 'no_systemd' }
  }

  const user = rawUsername()
  if (user === 'root') {
    // root already has root; the drop-in is pointless and would be a
    // misleading artifact. Silently skip.
    return { state: 'skipped', reason: 'root' }
  }
  if (!USERNAME_RE.test(user)) {
    // Either empty ($USER/$LOGNAME unset, as in some containers) or a
    // malformed value. Refuse to write anything derived from it.
    return { state: 'skipped', reason: 'bad_user' }
  }

  const existing = await inspectExisting(user)
  if (existing === 'ours') {
    return { state: 'already_installed', path: sudoersPath(user) }
  }
  if (existing === 'foreign') {
    // Something else is already at our target path. Surface a clear
    // message and DON'T overwrite — the user may have tightened the
    // rule manually.
    return { state: 'foreign_file_exists', path: sudoersPath(user) }
  }

  console.log()
  console.log(
    colors.bold.yellow(
      `  🔧 ${t('Set up passwordless sudo for slv on this machine?')}`,
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
          'Real threat model: anything running as your user — a compromised',
        )
      }`,
    ),
  )
  console.log(
    colors.white(
      `    ${
        t(
          'shell, browser extension, npm install script, or editor plugin —',
        )
      }`,
    ),
  )
  console.log(
    colors.white(
      `    ${t('gains root without needing your password.')}`,
    ),
  )
  console.log(
    colors.white(
      `    ${t('Remove later with:')}`,
    ),
  )
  console.log(colors.gray(`        sudo rm ${sudoersPath(user)}`))
  console.log()

  const ok = preset !== undefined ? preset : await Confirm.prompt({
    message: t('Install passwordless sudo for this user now?'),
    default: false,
  })
  if (!ok) {
    console.log(
      colors.gray(
        `  ${t('Skipped. You can re-run `slv onboard` to set this up later.')}`,
      ),
    )
    return { state: 'skipped', reason: 'declined' }
  }

  // Use a 0700 tempdir so only the current user can reach the staging
  // file. `install(8)` below does an atomic copy + owner + mode set, so
  // no separate `sudo chmod` and no window between move + chmod.
  let tmpDir: string
  let tmpPath: string
  try {
    tmpDir = await Deno.makeTempDir({ prefix: 'slv-sudoers-' })
    try {
      await Deno.chmod(tmpDir, 0o700)
    } catch { /* non-POSIX filesystems; harmless */ }
    tmpPath = `${tmpDir}/slv-sudoers`
    await Deno.writeTextFile(tmpPath, sudoersContent(user))
    await Deno.chmod(tmpPath, 0o440).catch(() => {})
  } catch (err) {
    return {
      state: 'failed',
      err: `staging file write failed: ${err instanceof Error ? err.message : String(err)}`,
    }
  }

  try {
    const check = await localExec('visudo', ['-cf', tmpPath])
    if (!check.success) {
      return {
        state: 'failed',
        err: `visudo validation failed (visudo may not be installed): ${
          check.stderr.trim() || 'unknown error'
        }`,
      }
    }

    // One interactive sudo. stdin is inherited so the TTY password
    // prompt can reach the user. `install -o root -g root -m 0440`
    // copies, sets ownership to root:root, and enforces exact mode
    // atomically — eliminating both the mv-preserves-ownership bug
    // and the between-mv-and-chmod race.
    const dest = sudoersPath(user)
    console.log(
      colors.cyan(`\n  🔐 ${t('sudo is about to ask for your password once.')}`),
    )
    const install = await localExec(
      'sudo',
      ['install', '-o', 'root', '-g', 'root', '-m', '0440', tmpPath, dest],
      { stdin: 'inherit' },
    )
    if (!install.success) {
      return {
        state: 'failed',
        err: `sudo install failed: ${install.stderr.trim() || 'unknown error'}`,
      }
    }
    console.log(
      colors.green(`  ✅ ${t('Passwordless sudo installed at')} ${dest}`),
    )
    return { state: 'installed', path: dest }
  } finally {
    // Clean up the whole staging dir regardless of outcome.
    await Deno.remove(tmpDir, { recursive: true }).catch(() => {})
  }
}
