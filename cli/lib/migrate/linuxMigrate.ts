import { colors } from '@cliffy/colors'

/** Excluded paths for rsync full-disk copy */
const RSYNC_EXCLUDES = [
  '/dev/*',
  '/proc/*',
  '/sys/*',
  '/tmp/*',
  '/run/*',
  '/mnt/*',
  '/media/*',
  '/lost+found',
  '/swapfile',
  // Preserve remote SSH access — these are merged/regenerated in post-copy step
  '/root/.ssh/authorized_keys',
  '/home/*/.ssh/authorized_keys',
  '/etc/ssh/sshd_config',
  '/etc/ssh/sshd_config.d/*',
  '/etc/ssh/ssh_host_*',
  // Snap loopback mounts (Ubuntu)
  '/snap/*',
]

interface MigrateOptions {
  /** SSH destination, e.g. "root@192.168.1.100" */
  to: string
  /** SSH port (default 22) */
  port?: number
  /** Extra rsync excludes */
  extraExcludes?: string[]
  /** Skip reboot step */
  skipReboot?: boolean
  /** Skip confirmation prompt */
  yes?: boolean
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function run(
  cmd: string,
  args: string[],
  opts?: { stdin?: 'inherit' | 'piped' | 'null'; captureOutput?: boolean },
): Promise<{ success: boolean; stdout: string; stderr: string; code: number }> {
  const command = new Deno.Command(cmd, {
    args,
    stdout: opts?.captureOutput ? 'piped' : 'inherit',
    stderr: opts?.captureOutput ? 'piped' : 'inherit',
    stdin: opts?.stdin ?? 'inherit',
  })
  const result = await command.output()
  const stdout = opts?.captureOutput && result.stdout ? new TextDecoder().decode(result.stdout) : ''
  const stderr = opts?.captureOutput && result.stderr ? new TextDecoder().decode(result.stderr) : ''
  return { success: result.success, stdout, stderr, code: result.code }
}

async function runCapture(cmd: string, args: string[]): Promise<string> {
  const { stdout } = await run(cmd, args, { captureOutput: true })
  return stdout.trim()
}

async function sshRun(
  target: string,
  command: string,
  port: number,
  capture = false,
): Promise<{ success: boolean; stdout: string; stderr: string; code: number }> {
  return run('ssh', [
    '-o', 'StrictHostKeyChecking=no',
    '-o', 'UserKnownHostsFile=/dev/null',
    '-p', String(port),
    target,
    command,
  ], { captureOutput: capture })
}

async function sshCapture(
  target: string,
  command: string,
  port: number,
): Promise<string> {
  const result = await sshRun(target, command, port, true)
  return result.stdout.trim()
}

// ---------------------------------------------------------------------------
// Pre-flight checks
// ---------------------------------------------------------------------------

async function checkPrerequisites(
  target: string,
  port: number,
): Promise<boolean> {
  console.log(colors.blue('\n🔍 Running pre-flight checks...\n'))

  // Check rsync is available locally
  const rsyncCheck = await run('which', ['rsync'], { captureOutput: true })
  if (!rsyncCheck.success) {
    console.error(colors.red('❌ rsync is not installed on the local machine.'))
    return false
  }
  console.log(colors.green('  ✔ rsync available locally'))

  // Check SSH connectivity
  const sshCheck = await sshRun(target, 'echo ok', port, true)
  if (!sshCheck.success || !sshCheck.stdout.includes('ok')) {
    console.error(
      colors.red(`❌ Cannot SSH to ${target} on port ${port}.`),
    )
    return false
  }
  console.log(colors.green(`  ✔ SSH connection to ${target} successful`))

  // Check rsync on remote
  const remoteRsync = await sshRun(target, 'which rsync', port, true)
  if (!remoteRsync.success) {
    console.error(
      colors.red('❌ rsync is not installed on the remote server.'),
    )
    return false
  }
  console.log(colors.green('  ✔ rsync available on remote'))

  return true
}

// ---------------------------------------------------------------------------
// Disk usage info
// ---------------------------------------------------------------------------

async function showDiskUsage(target: string, port: number): Promise<boolean> {
  console.log(colors.blue('\n📊 Disk usage summary\n'))

  // Local usage (root filesystem)
  const localUsage = await runCapture('df', ['-h', '--output=size,used,avail,pcent', '/'])
  console.log(colors.white('  Source (local /):'))
  for (const line of localUsage.split('\n')) {
    console.log(colors.dim(`    ${line}`))
  }

  // Local used bytes for estimation
  const localUsedKB = await runCapture('df', ['--output=used', '/'])
  const usedKBLine = localUsedKB.split('\n').pop()?.trim() ?? '0'
  const usedGB = (parseInt(usedKBLine, 10) / 1024 / 1024).toFixed(1)

  // Remote disk
  const remoteUsage = await sshCapture(target, 'df -h --output=size,used,avail,pcent /', port)
  console.log(colors.white('\n  Destination (remote /):'))
  for (const line of remoteUsage.split('\n')) {
    console.log(colors.dim(`    ${line}`))
  }

  // Check remote has enough space
  const remoteAvailKB = await sshCapture(target, "df --output=avail / | tail -1", port)
  const remoteAvailGB = parseInt(remoteAvailKB.trim(), 10) / 1024 / 1024
  const usedGBNum = parseInt(usedKBLine, 10) / 1024 / 1024

  if (remoteAvailGB < usedGBNum) {
    console.error(
      colors.red(
        `\n❌ Remote has ${remoteAvailGB.toFixed(1)} GB available but source uses ${usedGB} GB.`,
      ),
    )
    return false
  }

  // Rough transfer time estimate (assume ~50 MB/s over SSH)
  const estimatedMinutes = Math.ceil(usedGBNum * 1024 / 50 / 60)
  console.log(
    colors.yellow(
      `\n  📦 ~${usedGB} GB to transfer (estimated ${estimatedMinutes} min at ~50 MB/s)`,
    ),
  )
  return true
}

// ---------------------------------------------------------------------------
// rsync
// ---------------------------------------------------------------------------

async function runRsync(
  target: string,
  port: number,
  extraExcludes: string[],
): Promise<boolean> {
  console.log(colors.blue('\n🚀 Starting rsync full-disk copy...\n'))

  const excludes = [...RSYNC_EXCLUDES, ...extraExcludes]
  const excludeArgs = excludes.flatMap((e) => ['--exclude', e])

  const args = [
    '-aHAXSx',
    '--numeric-ids',
    '--info=progress2',
    ...excludeArgs,
    '-e', `ssh -o StrictHostKeyChecking=no -p ${port}`,
    '/',
    `${target}:/`,
  ]

  const result = await run('rsync', args)
  if (!result.success) {
    console.error(colors.red('\n❌ rsync failed.'))
    return false
  }
  console.log(colors.green('\n✅ rsync completed successfully.'))
  return true
}

// ---------------------------------------------------------------------------
// Post-copy environment patching (via SSH, not chroot)
// ---------------------------------------------------------------------------

async function patchRemoteEnvironment(
  target: string,
  port: number,
): Promise<boolean> {
  console.log(colors.blue('\n🔧 Applying environment patches on remote...\n'))

  // Build a single script to run on the remote to minimize SSH roundtrips
  const patchScript = `
set -e

echo "==> Patching /etc/fstab UUIDs..."
# Get current disk UUIDs on the new server and update fstab
NEW_ROOT_UUID=$(blkid -s UUID -o value $(findmnt -n -o SOURCE /) 2>/dev/null || true)
if [ -n "$NEW_ROOT_UUID" ] && [ -f /etc/fstab ]; then
  # Get the UUID currently referenced for / in fstab
  OLD_ROOT_UUID=$(grep -E '\\s+/\\s+' /etc/fstab | grep -oP 'UUID=\\K[a-fA-F0-9-]+' || true)
  if [ -n "$OLD_ROOT_UUID" ] && [ "$OLD_ROOT_UUID" != "$NEW_ROOT_UUID" ]; then
    sed -i "s|UUID=$OLD_ROOT_UUID|UUID=$NEW_ROOT_UUID|g" /etc/fstab
    echo "  Updated root UUID: $OLD_ROOT_UUID -> $NEW_ROOT_UUID"
  else
    echo "  Root UUID unchanged or already correct."
  fi
else
  echo "  Skipped fstab patching (no UUID found or no fstab)."
fi

echo "==> Merging SSH authorized_keys..."
# Source's authorized_keys were excluded from rsync and placed at /tmp/.slv_src_authorized_keys.
# Merge them into remote's preserved authorized_keys (remote keys + source keys, deduplicated).
if [ -f /tmp/.slv_src_authorized_keys ]; then
  for keydir in /root/.ssh /home/*/.ssh; do
    [ -d "$keydir" ] || continue
    ak="$keydir/authorized_keys"
    touch "$ak"
    cat /tmp/.slv_src_authorized_keys >> "$ak"
    sort -u -o "$ak" "$ak"
    chmod 600 "$ak"
  done
  rm -f /tmp/.slv_src_authorized_keys
  echo "  Source authorized_keys merged into remote."
else
  echo "  No source authorized_keys to merge."
fi

echo "==> Regenerating SSH host keys..."
# Host keys were excluded from rsync to avoid 2 servers sharing the same keys.
# Regenerate fresh host keys for the new server.
rm -f /etc/ssh/ssh_host_*
ssh-keygen -A 2>/dev/null || dpkg-reconfigure openssh-server 2>/dev/null || true
echo "  SSH host keys regenerated."

echo "==> Updating SSH server config..."
# sshd_config was excluded from rsync, so the remote's config is preserved.
# Ensure PermitRootLogin remains enabled for post-migration access.
if grep -q "^PermitRootLogin" /etc/ssh/sshd_config 2>/dev/null; then
  sed -i 's/^PermitRootLogin.*/PermitRootLogin yes/' /etc/ssh/sshd_config
else
  echo "PermitRootLogin yes" >> /etc/ssh/sshd_config
fi
systemctl restart ssh 2>/dev/null || systemctl restart sshd 2>/dev/null || true
echo "  SSH config updated, PermitRootLogin enabled."

echo "==> Updating /etc/hostname..."
ORIG_HOSTNAME=$(hostname)
echo "$ORIG_HOSTNAME" > /etc/hostname
echo "  Hostname: $ORIG_HOSTNAME"

echo "==> Regenerating /etc/machine-id..."
rm -f /etc/machine-id
systemd-machine-id-setup 2>/dev/null || dbus-uuidgen --ensure=/etc/machine-id 2>/dev/null || true
echo "  machine-id: $(cat /etc/machine-id 2>/dev/null || echo 'unknown')"

echo "==> Updating network configuration..."
# Detect primary interface on new server
PRIMARY_IF=$(ip -o link show up | grep -v lo | head -1 | awk -F': ' '{print $2}' || true)
PRIMARY_IP=$(ip -4 addr show "$PRIMARY_IF" 2>/dev/null | grep -oP 'inet \\K[\\d.]+' | head -1 || true)
GATEWAY=$(ip route | grep default | awk '{print $3}' | head -1 || true)

# Netplan
if [ -d /etc/netplan ]; then
  for f in /etc/netplan/*.yaml /etc/netplan/*.yml; do
    [ -f "$f" ] || continue
    echo "  ⚠️  Netplan config found: $f"
    echo "  Source netplan was synced via rsync. If NIC names or IPs differ,"
    echo "  you MUST manually update this file before reboot or network will be lost."
    echo "  Current remote IP: $PRIMARY_IP  Interface: $PRIMARY_IF  Gateway: $GATEWAY"
  done
fi

echo "==> Reinstalling bootloader..."
# Detect EFI vs BIOS
if [ -d /sys/firmware/efi ]; then
  echo "  EFI system detected"
  BOOT_DISK=$(findmnt -n -o SOURCE / | sed 's/[0-9]*$//' | sed 's/p$//')
  grub-install --target=x86_64-efi --efi-directory=/boot/efi --bootloader-id=GRUB "$BOOT_DISK" 2>/dev/null || \
  grub-install --target=x86_64-efi --efi-directory=/boot/efi "$BOOT_DISK" 2>/dev/null || \
  echo "  Warning: grub-install for EFI may need manual intervention"
else
  echo "  BIOS system detected"
  BOOT_DISK=$(findmnt -n -o SOURCE / | sed 's/[0-9]*$//' | sed 's/p$//')
  grub-install "$BOOT_DISK" 2>/dev/null || echo "  Warning: grub-install failed (may need manual intervention)"
fi

echo "==> Updating initramfs..."
update-initramfs -u -k all 2>/dev/null || echo "  Warning: update-initramfs not available or failed"

echo "==> Updating GRUB config..."
update-grub 2>/dev/null || grub-mkconfig -o /boot/grub/grub.cfg 2>/dev/null || true

echo "==> Environment patching complete."
`

  const result = await sshRun(target, patchScript, port)
  if (!result.success) {
    console.error(
      colors.red(
        '\n❌ Environment patching failed. SSH to remote may be broken.',
      ),
    )
    console.error(
      colors.yellow(
        '  Hint: Connect via provider console to check SSH access and review patch output.',
      ),
    )
    return false
  }
  console.log(colors.green('\n✅ Environment patches applied.'))
  return true
}

// ---------------------------------------------------------------------------
// Reboot and wait
// ---------------------------------------------------------------------------

async function rebootAndWait(target: string, port: number): Promise<boolean> {
  console.log(colors.blue('\n🔄 Rebooting remote server...\n'))

  // Send reboot (will disconnect SSH)
  await sshRun(target, 'nohup bash -c "sleep 2 && reboot" &>/dev/null &', port, true)
    .catch(() => {})

  console.log(colors.dim('  Reboot signal sent. Waiting for server to come back...'))

  // Wait for the server to go down first
  await new Promise((r) => setTimeout(r, 10000))

  // Poll SSH connectivity (up to 5 minutes)
  const maxAttempts = 30
  const intervalMs = 10000
  let connected = false

  for (let i = 1; i <= maxAttempts; i++) {
    console.log(colors.dim(`  Attempt ${i}/${maxAttempts}...`))
    const check = await sshRun(target, 'echo ok', port, true).catch(() => ({
      success: false,
      stdout: '',
      stderr: '',
      code: 1,
    }))
    if (check.success && check.stdout.includes('ok')) {
      connected = true
      break
    }
    await new Promise((r) => setTimeout(r, intervalMs))
  }

  if (!connected) {
    console.error(
      colors.red('\n❌ Server did not come back after reboot within 5 minutes.'),
    )
    return false
  }

  console.log(colors.green('\n✅ Server is back online!\n'))

  // Post-reboot verification
  console.log(colors.blue('📋 Post-reboot verification:\n'))

  const hostname = await sshCapture(target, 'hostname', port)
  console.log(colors.white(`  Hostname: ${hostname}`))

  const ip = await sshCapture(
    target,
    "ip -4 addr show scope global | grep -oP 'inet \\K[\\d.]+' | head -1",
    port,
  )
  console.log(colors.white(`  IP Address: ${ip}`))

  const diskInfo = await sshCapture(target, 'df -h / | tail -1', port)
  console.log(colors.white(`  Disk: ${diskInfo}`))

  const uptime = await sshCapture(target, 'uptime -p', port)
  console.log(colors.white(`  Uptime: ${uptime}`))

  return true
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export async function migrateLinux(options: MigrateOptions): Promise<boolean> {
  const { to, port = 22, extraExcludes = [], skipReboot = false, yes = false } = options

  console.log(colors.bold(colors.blue('\n🚀 SLV Linux Server Migration\n')))
  console.log(colors.white(`  Source:      localhost (this machine)`))
  console.log(colors.white(`  Destination: ${to}`))
  console.log(colors.white(`  SSH Port:    ${port}`))
  console.log('')

  // Step 1: Pre-flight checks
  const prereqOk = await checkPrerequisites(to, port)
  if (!prereqOk) return false

  // Step 2: Disk usage
  const diskOk = await showDiskUsage(to, port)
  if (!diskOk) return false

  // Step 3: Confirmation
  if (!yes) {
    const { Confirm } = await import('@cliffy/prompt')
    const proceed = await Confirm.prompt({
      message: 'Proceed with migration?',
      default: false,
    })
    if (!proceed) {
      console.log(colors.yellow('\n⚠️  Migration cancelled.'))
      return false
    }
  }

  // Step 4: Collect source authorized_keys before rsync (they are excluded from rsync)
  console.log(colors.blue('  Collecting source authorized_keys for post-copy merge...'))
  const sourceKeys = await runCapture('bash', ['-c',
    'cat /root/.ssh/authorized_keys 2>/dev/null; for u in /home/*; do [ -f "$u/.ssh/authorized_keys" ] && cat "$u/.ssh/authorized_keys"; done',
  ])

  // Step 5: rsync (SSH keys, sshd_config and host keys are excluded to preserve remote access)
  const rsyncOk = await runRsync(to, port, extraExcludes)
  if (!rsyncOk) return false

  // Step 5.5: Copy source authorized_keys to remote temp file for merge
  if (sourceKeys.trim()) {
    const escaped = sourceKeys.replace(/'/g, "'\\''")
    await sshRun(to, `echo '${escaped}' > /tmp/.slv_src_authorized_keys`, port)
  }

  // Step 6: Environment patches (includes SSH key merge + host key regen + sshd_config fixup)
  const patchOk = await patchRemoteEnvironment(to, port)
  if (!patchOk) return false

  // Step 7: Reboot
  if (!skipReboot) {
    const rebootOk = await rebootAndWait(to, port)
    if (!rebootOk) {
      console.log(
        colors.yellow(
          '\n⚠️  Server may need manual intervention. Migration data has been copied.',
        ),
      )
      return false
    }
  } else {
    console.log(colors.yellow('\n⏭️  Skipping reboot (--skip-reboot).'))
  }

  // Step 7: Done
  console.log(
    colors.bold(
      colors.green('\n🎉 Migration completed successfully!\n'),
    ),
  )

  return true
}
