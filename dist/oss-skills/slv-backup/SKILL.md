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
slv backup create --upload -y -r eu --retention 7
```
- `--upload` — upload to SLV cloud storage (omit to keep the tarball local only).
- `-y` — skips sudo confirmation and the "create backup?" confirmation.
- `-r <region>` — `eu | asia | us-east | us-west | oc`. Ask the user only if they have not chosen one.
- `--retention <days>` — delete cloud backups older than N days (default 7).
- `-o <path>` — override the output path (default: auto-generated from hostname + timestamp).
- `--exclude <path>` — add extra excludes on top of the built-in list. Repeatable.
- `--include <path>` — remove a path from the default exclude list. Repeatable.
- `--webhook <url>` — Discord webhook for notifications. Omit to reuse `SLV_BACKUP_WEBHOOK` env.
- `--restic` — use restic instead of tar+zstd. Requires restic installed. Pair with `-y`.

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

### Schedule a cron backup
```bash
slv backup create --cron daily -r eu --retention 7 -y
# other values: weekly, monthly, off
```

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
| "take a backup of this server" | `slv backup create --upload -y -r <region> --retention 7` |
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
  time to snapshot this box with `slv backup create --upload -y -r <region>
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
slv backup create --upload -y -r <region> --retention 7
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
