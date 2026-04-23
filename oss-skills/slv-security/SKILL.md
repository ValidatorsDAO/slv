# SLV Security Skill

Walk a non-engineer through hardening their SLV host — firewall
(nftables + fail2ban), SSH (key-based login + password-off),
VPN (WireGuard on their phone), and HTTPS (Cloudflare Origin CA).
All four compose into a stack where each layer still works alone
if one is skipped.

Use this skill when the user says anything like:

- "help me set up the firewall / security / WireGuard"
- "is my VPS exposed?" / "can anyone hit my gateway?"
- "I want to lock down SSH / turn off password login"
- "set up the phone VPN"
- "nftables" / "fail2ban" / "allow only my IP"

---

## EL's walkthrough (the conversation flow, non-engineer friendly)

Run the steps **in this order** — skipping ahead will lock the
user out of their own box. Each step is a single `slv` or `run_command`
invocation; don't make the user SSH or edit files by hand.

### Step 0 — Sanity probe (read-only, no prompts)

Call these MCP tools and state-of-the-box commands in parallel so
you can frame the rest of the walkthrough with real data:

- `get_dns_status` (MCP) — learn the user's default subdomain + whether HTTPS is already set up.
- `get_premium_vps_my_vps` (MCP) — the user's Premium VPS list. Each entry has an `ip`.
- `get_super_vps_my_vps` (MCP) — Super VPS list.
- `get_baremetal_status` (MCP) — BareMetal list.
- `run_command: curl -s https://api.ipify.org` — THIS host's public IP, so you can filter it out of the whitelist-candidate list (no need to whitelist the server to itself).
- `run_command: sudo nft list ruleset 2>/dev/null | head -3` — is nftables already configured?
- `run_command: systemctl is-active fail2ban 2>/dev/null` — fail2ban running?
- `run_command: systemctl is-active wg-quick@wg0 2>/dev/null` — WireGuard up?

Use the results to:

- Say which layers are already on ("✅ HTTPS via u-xxx.erpc.global, ❌ firewall not configured, ❌ WireGuard not up").
- Build the **whitelist candidate list**: every `ip` from the MCP VPS/BM calls that isn't THIS host's IP. Present it to the user verbatim:
  > "Your SLV account has these other hosts — want them whitelisted on the firewall? You'll still be able to SSH between them after we lock down."

### Step 1 — Firewall (nftables + fail2ban)

Confirm the whitelist. Ask:
> "Any additional IPs that should have full access? Your home IP, office VPN, or a friend's laptop. Paste them comma-separated, or say 'none'."

Do NOT auto-add the user's current SSH source IP. They might be
connected over a dynamic home IP and assume it's stable; hard-
coding it causes "my firewall locked me out next Tuesday"
support tickets. Invite them to add it explicitly if they want.

Combine MCP-derived IPs + user-supplied IPs, then run:

```bash
slv install firewall --allow <ip1> --allow <ip2> --allow <ip3> -y
```

The `--allow` flag is repeatable. Order doesn't matter. Don't worry
about de-dupe — the CLI handles it.

**What this does** (tell the user plainly):
- Always-open: SSH (22), HTTP (80), HTTPS (443), WireGuard (51820/udp), localhost, the WG peer subnet 10.0.0.0/24.
- fail2ban watches sshd and bans an IP after 5 wrong passwords in 10 minutes, for 1 hour.
- The whitelisted IPs get ALL ports unconditionally.
- Everything else is silently dropped.

**Why we keep SSH open to the world:**
- Non-engineer users get locked out instantly if SSH is
  whitelist-only and their home IP changes.
- fail2ban shuts down brute-force attempts anyway.
- We tighten SSH separately (next step), by turning off password
  auth and requiring a key — that's the real defense.

### Step 2 — SSH key (ADD THE KEY, THEN VERIFY, THEN DISABLE PASSWORDS)

This order is load-bearing.

**Step 2a.** Ask the user:
> "Paste your SSH public key. It's a one-line string starting with `ssh-ed25519` or `ssh-rsa` — usually in `~/.ssh/id_ed25519.pub` on your laptop. If you don't have one, run `ssh-keygen -t ed25519` on your laptop first and paste the `.pub` contents."

If they don't know how, walk them through: `cat ~/.ssh/id_ed25519.pub` on their laptop → copy → paste here.

Run:

```bash
slv add:ssh '<the pubkey line>'
```

**Step 2b — VERIFY.** Tell the user:
> "Open a NEW terminal and try: `ssh ubuntu@<this-host-ip>`. If it lets you in without asking for a password, key-based login is working. Leave that terminal open as a safety net."

Do NOT proceed until the user confirms this works. If they don't,
roll back and debug — `slv disable pwd-login` after a bad
`add:ssh` locks the user out permanently.

**Step 2c.** Disable password auth:

```bash
slv disable pwd-login
```

Frame it as "this removes a huge attack surface — password
guessing just becomes impossible now."

### Step 3 — WireGuard (optional but recommended for mobile)

Walk the user through the phone side first:

> "On your phone, install the official **WireGuard** app (iOS App Store / Google Play — look for the purple dragon logo)."
>
> "Open the app, tap the `+` button, choose **Create from scratch**."
>
> "Name the tunnel something like 'slv-<vps-name>'. Scroll to the **Public key** field and copy that 44-character string ending in `=`. Do NOT copy the Private key — that one stays on your phone forever."

Ask them to paste the PUBLIC key, then run:

```bash
slv install wireguard --iphone-pubkey '<the-pubkey>'
```

When it finishes, SLV prints the **server public key**. Tell them:

> "Copy the server public key I just printed. Back on your phone, in the WireGuard tunnel you started, fill in:
> - **Addresses:** `10.0.0.2/32`
> - **DNS servers:** `1.1.1.1` (any public resolver)
> - Tap **Add peer**, then fill:
>   - **Public key:** (paste the server key I just gave you)
>   - **Endpoint:** `<this-host-ip>:51820`
>   - **Allowed IPs:** `10.0.0.0/24` for split-tunnel (only SLV traffic goes through VPN), or `0.0.0.0/0` for full-tunnel (all phone traffic)."

Turn the tunnel on. Ask them to try hitting `http://10.0.0.1:20026/ui/`
directly over the VPN to confirm it's working. Optional: now they
can `slv gateway config set-mode local` to drop LAN exposure,
since the VPN is the only non-nginx path in.

### Step 4 — Verify (read-back)

After all three steps, state the final posture plainly:

```
🛡  Your SLV box is locked down:
  • Firewall: nftables drops everything except SSH (22) + HTTP/HTTPS (80/443) + WireGuard (51820)
  • SSH: password disabled, only your key (`slv add:ssh`) works
  • Brute-force: fail2ban blocks 5-retry-in-10m for 1 hour
  • VPN: WireGuard up, phone connects via <slug>.erpc.global or <ip>:51820
  • HTTPS: Cloudflare Full-strict + Origin CA cert (if you ran `slv install nginx` earlier)
```

Offer to export the settings (ssh config, WG peer config) to
their laptop for safekeeping.

---

## Reference

### `slv install firewall`

```
slv install firewall --allow <ip> [--allow <ip>] ... [-y]
```

- Each `--allow` adds a trusted source IP to the nftables whitelist.
- Without `--allow`, only the always-open ports (22/80/443/51820) accept traffic.
- Idempotent: re-running with a different set overwrites the ruleset.
- Playbook: `template/latest/ansible/cmn/software/install-firewall.yaml`.

### `slv install wireguard`

```
slv install wireguard --iphone-pubkey '<44-char-pubkey>='
```

- Prompts interactively if `--iphone-pubkey` is missing.
- Writes exported server pubkey to `/tmp/slv-wg-server-pubkey.txt` (mode 0644) so the CLI can echo it to the user without a second sudo.
- Playbook: `template/latest/ansible/cmn/software/install-wireguard.yaml`.

### `slv add:ssh` + `slv disable pwd-login`

```
slv add:ssh '<pubkey-line>'    # appends to ~/.ssh/authorized_keys
slv disable pwd-login          # sets PasswordAuthentication no + reloads sshd
```

### Nice-to-have follow-ups (not in the default walkthrough)

- `slv gateway config set-mode local` — once WireGuard works, drop
  the gateway from `lan` back to loopback-only. nginx + Cloudflare
  still reach it; everything else goes through the VPN.
- Cloudflare zone → **Security → WAF** → enable managed rules. Free
  tier covers the basics; worth 5 minutes to check.
- SSH port 22 ban-list review: `sudo fail2ban-client status sshd`
  monthly to see what got caught.

### Common failure modes + fixes

| User says | Likely cause | Fix |
|-----------|-------------|-----|
| "I ran `slv disable pwd-login` and now I'm locked out" | `slv add:ssh` was skipped or the pubkey was malformed | Cloud provider console → boot in rescue → re-enable password in `/etc/ssh/sshd_config.d/` or add a good authorized_keys |
| "My whitelist IP is wrong now" | dynamic home IP rotated | re-run `slv install firewall --allow <new-ip> [other ips]` — idempotent rewrite |
| "nftables says default-deny but I can still connect over SSH" | expected — SSH is an always-open exception | not a bug |
| "fail2ban banned me" | typed a wrong password 5 times | `sudo fail2ban-client set sshd unbanip <your-ip>` |

### Don't do

- Don't disable password auth BEFORE verifying key-based login works.
- Don't whitelist `0.0.0.0/0` — it defeats the default-deny.
- Don't auto-add the operator's current SSH source IP — dynamic home IPs rotate and the rule silently stops matching.
- Don't expose the gateway on 0.0.0.0 without either (a) WireGuard fronting it or (b) Cloudflare Origin CA cert + nginx.
- Don't commit WireGuard private keys anywhere. The phone's private key stays on the phone; the server's private key stays in `/etc/wireguard/` on the VPS (mode 0600).
