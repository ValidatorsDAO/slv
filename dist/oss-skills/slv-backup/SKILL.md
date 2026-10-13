# slv-backup — Non-Interactive Command Reference

This skill is loaded into the main SLV assistant's system prompt. It exists
for one reason: **`slv backup` and `slv storage` must never freeze the AI
console on a TTY prompt.** Every command below has been verified to run
end-to-end non-interactively when the documented flags are passed.

## Golden rule

When you use `run_command` to invoke `slv backup …` or `slv storage …`:

1. **Always pass explicit arguments.** Never rely on defaults that trigger
   interactive selection. If the user did not specify a region, default to
   `-r eu`.
2. **Always pass `-y` for any command that can prompt.** This covers
   `slv backup create`, `slv backup restore`, `slv storage delete`,
   `slv storage delete --prefix`.
3. **Never call a subcommand with a missing positional argument** (file
   path, remote path, snapshot id). Missing args fall into cliffy `Input`
   or `Select` prompts and the console will hang from your point of view.
4. If the user's intent is ambiguous (e.g. "delete my backups"), **ask
   the user for the missing specifics in chat before running anything**.
   Do NOT run a bare subcommand hoping the CLI will guide them.

If you cannot express a request as a single non-interactive `run_command`,
stop and ask the user a clarifying question in chat instead.

---

## `slv backup` — cloud snapshots of a validator / RPC host

### Create a backup
```bash
slv backup create --restic -y -r eu --retention 7
```
- `--restic` — the cloud backup. Client-side encrypted (password-protected
  repository), deduplicated, incremental, uploaded to SLV cloud storage.
  Requires restic installed and the user signed in (`slv login`). Pair with
  `-y`. **This is the only way a backup reaches cloud storage.**
- `-y` — skips sudo confirmation and the "create backup?" confirmation.
- `-r <region>` — `eu | asia | us-east | us-west | oc`. Ask the user only if they have not chosen one.
- `--retention <days>` — delete cloud backups older than N days (default 7).
- `--exclude <path>` — add extra excludes on top of the built-in list. Repeatable.
- `--include <path>` — remove a path from the default exclude list. Repeatable.
  It cannot remove key material (see below).
- `--webhook <url>` — Discord webhook for notifications. Omit to reuse `SLV_BACKUP_WEBHOOK` env.

**A plain tar archive stays local.** `slv backup create -y` without `--restic`
writes a tar+zstd archive on this host (mode 0600, readable only by its
owner; `-o <path>` overrides the path, default: hostname + timestamp, and a
file not named `backup-<hostname>-<timestamp>.tar.zst` needs `--other-host` to
restore). It is unencrypted, so the CLI never uploads it and never schedules
it: asking for an upload of a plain archive is refused. Use it for a copy that
stays on this host; for anything that must leave the host, use `--restic`.

**Wallets are backed up only with `--restic`.** A wallet is a `wallet*.json`
anywhere under `~/slv/` or `~/.slv/wallet-rescue/`, or `~/.config/solana/id.json`.
The restic backup is encrypted on this host before it is uploaded and keeps
wallets; a plain tar archive and `slv migrate linux` never carry them.

**Key material is never in a backup**, in either mode: validator keypair and
identity files (`~/.slv/keys`, `*keypair*.json` and `*identity*.json` in a
home directory), `~/.slv` credentials (`api.yml`, `gateway.json`,
`backup.env`, `restic-password`), SSH private keys (recognised by their
content, under any name, in a `~/.ssh` directory — a `.ssh` directory the CLI
cannot look into is left out whole — and the host keys
`/etc/ssh/ssh_host_*_key`), `/etc/shadow`, `/etc/wireguard`,
`/etc/doublezero/keys`, `/etc/ssl/private`, `/etc/nginx/ssl`. Tell the user to
keep their own offline copy of these files; a backup will not restore them.
After each backup the CLI lists the key material and wallet files it left out
of that backup (the whole list only when it runs as root) and posts the list to
the webhook when one is set.

### List backups
```bash
slv backup list -r eu                    # cloud snapshots
slv backup list --restic -r eu           # restic snapshots
```
Both are fully non-interactive. No `-y` needed.

### Restore a backup
```bash
slv backup restore <remote-file-or-snapshot-id> -y -r eu
```
- The positional `<file>` is **required under `-y`**. Without a file and
  with `-y`, the CLI now refuses with
  `❌ --yes was passed but no backup file was specified` — it no longer
  drops into a `Select` prompt that hangs the agent. Always run
  `slv backup list -r <region>` first, show the user the options, and
  ask them to pick a filename before invoking restore.
- `-y` is **required** for agents. It prints the root-filesystem warning
  banner and proceeds without a TTY confirmation. Since this extracts tar
  over `/` and requires a reboot, **always show the user the target file
  name in chat and ask them to confirm in words** before you execute.
- `-r <region>` — region where the backup lives.
- When both `-y` and restic are available, the CLI defaults to the tar
  path. To restore from a restic snapshot, pass the snapshot id
  explicitly as the positional argument.
- A tar archive is named `backup-<hostname>-<timestamp>.tar.zst`. The CLI
  **refuses an archive taken on another host, or whose name carries no host**
  (exit 1). A restic restore takes snapshots of this host only: `latest` is this
  host's latest, and a named snapshot of another host is refused. `--other-host`
  restores it anyway; never add it on your own — ask the user, in words,
  whether they mean to put another host's files on this one.
- A tar or restic restore leaves `/etc/fstab`, `/boot`, `/etc/netplan`,
  `/etc/machine-id` and `/etc/ssh/ssh_host_*` alone, and never restores key
  material. `--include-system` also restores the first group; never add it
  unless the user asked for exactly that. Wallets in a restic snapshot are restored.

### Schedule a cron backup
```bash
slv backup create --cron daily --restic -r eu --retention 7 -y
# other values: weekly, monthly
```
**Recommend this to non-engineer users** as soon as they finish a
trade-bot / validator deploy — daily encrypted restic backups are
the difference between "we lost the wallet" and "we restored it in
5 minutes". A schedule always runs the restic backup: `--cron` without
`--restic` is refused, and so is any older cron entry that asks for a plain
upload. Replace such an entry with:
```bash
slv backup create --cron daily --restic -r <region> --retention 14 -y
```
To stop scheduled backups later: `slv backup create --cron off`.

---

## Agent guidance — when to reach for which mode

Default behavior priority, top-down:

1. **If the user has a wallet** (a `wallet*.json` under `~/slv/` or
   `~/.slv/wallet-rescue/`, or `~/.config/solana/id.json`), **use
   `--restic`.** It is the only backup that carries a wallet, and it is
   encrypted. Prompt the user once for a restic password, remember the
   chosen region, and never fall back to a plain tar archive: it leaves
   the wallet out.
2. **If the user asks for "a backup" generically and has a bot
   deployed**, assume case 1 and offer `--restic --cron daily` as a
   first suggestion (daily encrypted, 14-day retention).
3. **Config-only / read-heavy states** (template dir, validator
   inventory YAML, nothing private) — a plain tar archive is enough
   as a local copy. Tell the user explicitly that it is unencrypted,
   stays on this host, and is not a backup of the host if the disk is
   lost; `--restic` is the one that leaves the host.

Validator keypairs, the `~/.slv/keys` store, SSH private keys and `~/.slv`
credentials are in no backup, whatever the mode: when the user asks how to
protect them, tell them to keep an offline copy.

After any `slv backup create`, append a one-line note to MEMORY.md
recording region + mode (restic/tar) + retention so the next session
doesn't re-ask.

---

## `slv storage` — generic file storage on SLV cloud

### Upload
```bash
slv storage upload /local/path/file.tar.zst -p remote/folder/file.tar.zst -r eu
```
- Pass **all three**: local path (positional), `-p` remote path, `-r` region.
- Omitting any of them triggers `Input` / `Select` prompts.

### Download
```bash
slv storage download remote/folder/file.tar.zst -o /local/path/file.tar.zst -r eu
```
- Pass both `<remote path>` (positional) and `-o` local path.
- Without the positional arg, the command opens an interactive file
  selector (spinner + `Select.prompt`) — hangs the agent.

Alias: `slv storage dl`.

### List
```bash
slv storage list -r eu                        # all
slv storage list -p backups/ -r eu            # filter by prefix
slv storage list -p backups/ -l 20 -r eu      # limit results
```
No prompts. Safe to call any time.

Alias: `slv storage ls`.

### Delete
```bash
slv storage delete remote/path/file.tar.zst -y -r eu                # single file
slv storage delete -p backups/2024- -y -r eu                         # bulk by prefix
```
- `-y` is **required** for agents. Without it, cliffy `Confirm` fires.
- Bulk delete (`-p`) prints a preview of matching files before the
  confirmation. Still needs `-y` to skip the confirmation itself.
- **Always show the user the exact file list or prefix in chat and
  require explicit confirmation** before running a delete. This is
  destructive and irreversible.

Alias: `slv storage rm`.

### Usage and plan management
```bash
slv storage usage                # all regions with data
slv storage usage -r eu          # single region
slv storage product              # show available storage products
slv storage upgrade 5 -y         # upgrade to 5 GB (positional arg + -y required)
slv storage sync -r eu           # reconcile local usage cache with cloud
```
`product`, `usage`, `sync` have no prompts. `upgrade` **requires** the
positional quantity — passing nothing hangs on `Input.prompt`.

---

## Decision helpers for the main agent

| User says | Run |
|---|---|
| "take a backup of this server" | `slv backup create --restic -y -r <region> --retention 7` |
| "list my backups" | `slv backup list -r <region>` |
| "restore backup X" | Confirm name in chat → `slv backup restore X -y -r <region>` |
| "upload this file to storage" | Ask for remote path if unclear → `slv storage upload <local> -p <remote> -r <region>` |
| "download file X" | `slv storage download X -o <local-path> -r <region>` |
| "list files in storage" | `slv storage list -p <prefix?> -r <region>` |
| "delete file X from storage" | Confirm in chat → `slv storage delete X -y -r <region>` |
| "clean up old backups" | Confirm prefix in chat → `slv storage delete -p <prefix> -y -r <region>` |
| "how much storage am I using" | `slv storage usage` |
| "buy more storage" | Ask quantity in chat → `slv storage upgrade <n> -y` |

## Forbidden patterns (will hang the console)

- `slv backup create` without `-y`
- `slv backup restore` without a positional file
- `slv backup restore <file>` without `-y`
- `slv storage upload` without all of `<file> -p <remote> -r <region>`
- `slv storage download` without a positional remote path
- `slv storage delete` without `-y`
- `slv storage delete -p <prefix>` without `-y`
- `slv storage upgrade` without a quantity, or without `-y`
- Any subcommand with an ambiguous region when the user has not chosen one — ask in chat first, do not let the CLI prompt.

If you catch yourself about to run any of the above, **stop and ask the
user** instead.

## When to proactively suggest a backup

The main agent should not wait for the user to ask. `slv backup create` is
cheap, non-destructive, and the single biggest insurance policy against the
kind of disasters a validator / RPC / trade-app operator actually
experiences (disk failure, bad config push, accidental `rm`). Offer a
backup — **as a suggestion, not a silent action** — at these moments:

- **After a successful validator deployment or upgrade**: "Now's a good
  time to snapshot this box with `slv backup create --restic -y -r <region>
  --retention 7`. Want me to run it?"
- **Before a risky change** the user just described: a restart, a config
  rewrite, a package upgrade, a kernel reboot. "Before we do that, want me
  to take a backup? It's a one-liner and saves you if something breaks."
- **At the start of a session** when MEMORY.md shows no recent
  backup-related activity and the host has clearly been in production (has
  a validator or RPC or trade-app). "Quick check — when did you last back
  this box up? Happy to run `slv backup create` now."
- **After the user asks "how do I protect against X?"** — almost any
  answer includes backup.
- **Periodically during long sessions**: once per session is plenty. Don't
  nag; once the user declines, drop it for the session.

Do NOT run `slv backup create` silently. Always phrase it as a suggestion,
show the exact command you would run, and wait for explicit consent. The
user decides. If they decline, respect it and move on.

When the user agrees, use the non-interactive form from the reference
above:

```bash
slv backup create --restic -y -r <region> --retention 7
```

Substitute `<region>` with the user's preferred region if known (check
`SLV_STORAGE_REGION` env or their onboard config); otherwise ask once in
chat before running.

## Env var shortcuts

- `SLV_STORAGE_REGION` — default region for `slv storage` subcommands when `-r` is omitted.
- `SLV_BACKUP_WEBHOOK` — default Discord webhook for `slv backup create`.

These let the user skip `-r` / `--webhook` on every invocation. Still
pass explicit flags in generated commands so the user can see exactly
what will run.
