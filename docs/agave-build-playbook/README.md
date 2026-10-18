# Agave CLI build & upload playbook

This is a manual Agave playbook backed by `ansible/agave-build-playbook.yml`. The former hourly `update-agave-cli` workflow is absent from the current repository. Its manually supplied environment/.env credentials and `slv`/`slv-asia` operations are separate from the verified SLV CLI release and the one-object `slv/install` migration.

## Prerequisites
- Target host: Debian/Ubuntu with sudo.
- Environment variables (can also be passed via `-e`):
  - `CLOUDFLARE_ACCOUNT_ID`
  - `CLOUDFLARE_API_TOKEN`
  - Optional: `DISCORD_WEBHOOK_URL` for notifications.
- Ansible inventory that reaches the build host.

## Command examples
- Build a specific tag and upload to both `slv` and `slv-asia` buckets:
  ```bash
  ansible-playbook agave-build-playbook.yml -i <host>, -e version=vX.Y.Z
  ```
- If creds are not in env:
  ```bash
  ansible-playbook agave-build-playbook.yml -i <host>, \
    -e "version=vX.Y.Z cloudflare_account_id=... cloudflare_api_token=..."
  ```
- Add Discord notification:
  ```bash
  ansible-playbook agave-build-playbook.yml -i <host>, \
    -e "version=vX.Y.Z discord_webhook_url=https://discord.com/api/webhooks/..."
  ```

## What it does
1) Checks `https://storage.slv.dev/agave/<version>/` for `agave-validator`, `solana`, `solana-keygen`.  
2) Clones `https://github.com/anza-xyz/agave.git` at the requested tag and runs `./scripts/cargo-install-all.sh .` (only if something is missing).  
3) Uploads missing binaries to both R2 buckets (`slv`, `slv-asia`) and updates `agave/latest.txt`.  
4) Optionally posts a Discord embed when uploads happen.  
5) Cleans up the build directory and temp artifacts.
