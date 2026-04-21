export type SystemdUnitInput = {
  name: string
  username: string
  workDir: string
  execStart: string
}

export const renderSystemdUnit = (u: SystemdUnitInput): string =>
  `[Unit]
Description=SLV Bot - ${u.name}
After=network.target

[Service]
Type=simple
User=${u.username}
WorkingDirectory=${u.workDir}
ExecStart=${u.execStart}
Restart=on-failure
RestartSec=5
StandardOutput=journal
StandardError=journal
SyslogIdentifier=slv-${u.name}

[Install]
WantedBy=multi-user.target
`

// Matches the rule enforced by `slv bot init`. Keep in sync with
// cli/src/bot/init/initBotTemplate.ts. `appName` flows into a privileged
// systemd unit path via `sudo mv`, so rejecting shell metacharacters and
// path separators here is a security boundary, not cosmetic.
const APP_NAME_RE = /^[a-zA-Z0-9-_]+$/

export const validateAppName = (name: string): string | null => {
  if (!name.trim()) return 'App name cannot be empty'
  if (!APP_NAME_RE.test(name)) {
    return 'App name can only contain letters, numbers, hyphens, and underscores'
  }
  return null
}
