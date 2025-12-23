# Agave CLI build & upload playbook

This playbook mirrors the hourly GitHub Actions workflow (`.github/workflows/update-agave-cli.yml`) but lets you build/upload a specific Agave release on demand.

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
