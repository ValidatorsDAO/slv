# SLV Firewall Skill

Lock down the SLV host's network perimeter: nftables default-drop,
fail2ban for brute-force, SSH key-based login with password auth
off. Non-engineer friendly — three commands, zero file editing.

**Related:** For phone/laptop VPN on top of this, see the
**slv-wireguard** skill. For automatic HTTPS on the chat UI, see
`slv install nginx`.

Use this skill when the user says anything like:

- "help me lock down the firewall / SSH"
- "is my box exposed? / what ports are open?"
- "allow only my IP" / "whitelist my laptop"
- "turn off SSH passwords" / "disable password login"
- "nftables" / "fail2ban" / "brute force"

---

## EL's walkthrough (run in this order — skipping ahead locks users out)

### Step 0 — Sanity probe (read-only, parallelizable)

Fire these in parallel so the rest of the conversation has real
data to work with:

- `get_premium_vps_my_vps` (MCP) — user's Premium VPS list.
- `get_super_vps_my_vps` (MCP) — Super VPS list.
- `get_baremetal_status` (MCP) — BareMetal list.
- `run_command: curl -s https://api.ipify.org` — THIS host's public IP (so you filter it out of whitelist candidates — no point whitelisting the server to itself).
- `run_command: sudo nft list ruleset 2>/dev/null | head -3` — is nftables already configured?
- `run_command: systemctl is-active fail2ban 2>/dev/null` — is fail2ban running?
- `run_command: sudo grep -r PasswordAuthentication /etc/ssh/` — is password auth still on?

Use the results to:

- Say what's already on / off.
- Build the **whitelist candidate list**: every `ip` from the MCP VPS/BM calls that isn't THIS host's IP. Present to the user verbatim:
  > "Your SLV account has these other hosts — want them whitelisted? You'll still be able to SSH between them after we lock down."

### Step 1 — How will the user reach this box from outside?

Before collecting any `--allow` IPs, decide the remote-access
method with the user. This single question prevents the #1
support ticket (self-lockout from a rotating home IP).

Ask, in plain language:

> "自宅やスマホからこのサーバーに入る方法として、どちらを使いたい
> ですか? 非エンジニアの方なら 1 を強くおすすめします。
>
> 1. **WireGuard VPN**（推奨）— スマホと PC に VPN を入れて、VPN
>    経由で入る方式。ポートは 22/80/443 と VPN の 51820 だけ開け
>    ておけば済みます。家のルーターの IP が変わっても関係なく繋が
>    ります。
>
> 2. **固定 IP を whitelist** — 会社のビジネス回線など、変わらな
>    い IP を 1 つ持っていればそれを登録します。**家のルーターの
>    IP は ISP の都合で数日〜数週間で変わるので、これを登録すると
>    後日閉め出されます**。固定と明言できる IP 以外は登録しないで
>    ください。
>
> 3. **両方** — 念のため固定 IP も登録した上で VPN も用意する。"

**Default recommendation: option 1.** If the user picks 1 or is
unsure, proceed with firewall install WITHOUT any `--allow` IPs,
then immediately hand off to the **slv-wireguard** skill as Step
1.5 below. If they pick 2 or 3, collect the IPs now.

**Never auto-add the user's current SSH source IP.** Their home
IP is probably dynamic; hardcoding it leads to "my firewall locked
me out next Tuesday" support tickets. Invite them to add it
explicitly only if they swear it's static.

### Step 1.5 — Install the firewall

Combine MCP-derived IPs (from Step 0) + user-supplied IPs, then run:

```bash
slv install firewall --allow <ip1> --allow <ip2> -y
```

`--allow` is repeatable. Order doesn't matter. The CLI dedupes.
If the user picked WireGuard-only (option 1 above), omit `--allow`
entirely — the box will still be reachable via SSH (port 22 open,
fail2ban-protected) and via WG once it's up.

### Step 1.6 — If they picked WireGuard, hand off now

After the firewall install succeeds, and BEFORE SSH hardening:

> "ファイアウォールは有効化できました。次は VPN を用意します。
> **slv-wireguard** スキルに切り替えます — VPN 用の VPS を別で
> 持っていないと進められないので、そこから確認します。"

Invoke the slv-wireguard skill. It will (a) check whether the user
has a dedicated core1 VPS for the VPN or needs to buy one, and
(b) walk them through the phone pairing. Once WG is up, come back
to Step 2 below.

**What this does:**
- Always-open: SSH (22), HTTP (80), HTTPS (443), WireGuard (51820/udp), lo, WG peer subnet 10.0.0.0/24.
- Whitelist IPs get ALL ports unconditionally.
- Everything else silently dropped.
- fail2ban watches sshd: 5 wrong passwords in 10 min → 1 h ban.

### Step 2 — SSH hardening (ADD → VERIFY → DISABLE, in that order)

This order is load-bearing.

**Step 2a — Install the public key.** Ask:

> "Paste your SSH public key. It's a one-line string starting with `ssh-ed25519` or `ssh-rsa` — usually in `~/.ssh/id_ed25519.pub` on your laptop.
>
> If you don't have one: run `ssh-keygen -t ed25519` on your laptop first and paste the `.pub` contents here."

Run:

```bash
slv add:ssh '<the pubkey line>'
```

**Step 2b — VERIFY in a second terminal.** Tell the user:

> "Open a NEW terminal and try `ssh ubuntu@<this-host-ip>`. If it logs you in without asking for a password, key-based login is working. LEAVE THAT TERMINAL OPEN as a safety net — if the next step goes wrong you can fix it from there."

**Do not proceed until the user confirms this works.** Running
`slv disable pwd-login` after a bad `slv add:ssh` is how people
permanently lock themselves out.

**Step 2c — Disable password auth:**

```bash
slv disable pwd-login
```

Frame it: "this removes a huge attack surface — password guessing is now impossible."

### Step 3 — Verify + read-back

State the final posture plainly:

```
🛡  Firewall + SSH locked down:
  • nftables: default-drop, SSH/HTTP/HTTPS/WireGuard always open
  • Whitelist: <ips> (all ports)
  • fail2ban: sshd jail, 5/10m → 1h ban
  • SSH: password auth OFF, key-only
```

Offer to back up the ssh key to the user's laptop if they haven't
already.

If they also want VPN access from their phone, hand off to the
**slv-wireguard** skill.

---

## Why SSH stays open to the world

Engineer impulse: "whitelist SSH too." Don't. Two reasons:

1. **Non-engineer users on dynamic home IPs lock themselves out.** Their ISP rotates their IP, the firewall rule silently stops matching, they panic. fail2ban + key-only auth is equivalent defense without the foot-gun.
2. **SSH key auth is already near-unbreakable.** An attacker without the key gets nowhere; an attacker WITH the key would bypass a whitelist (they'd spoof the source IP or tunnel through an allowed host anyway).

Repeat this explanation to every user who asks "why is SSH open?" — it's the #1 security question on this skill.

---

## Reference

### `slv install firewall`

```
slv install firewall [--allow <ip>]... [-y]
```

- `--allow <ip>` — repeatable. IPv4 dotted-quad. Gets all-port access.
- `-y` — skip the confirmation prompt.
- Idempotent: re-running with a different set **overwrites** the ruleset.
- Playbook: `template/latest/ansible/cmn/software/install-firewall.yaml`.

### `slv add:ssh`

```
slv add:ssh '<pubkey line>'
```

- Appends to `~/.ssh/authorized_keys`. De-dupes.

### `slv disable pwd-login`

```
slv disable pwd-login
```

- Sets `PasswordAuthentication no` in sshd config, reloads sshd.
- **Destructive:** if you haven't verified key login, this locks you out.

---

## Common failure modes + fixes

| User says | Likely cause | Fix |
|-----------|-------------|-----|
| "I ran `slv disable pwd-login` and now I'm locked out" | `slv add:ssh` was skipped or pubkey was malformed | Cloud provider rescue console → re-enable password in `/etc/ssh/sshd_config.d/` or fix `authorized_keys` |
| "My whitelist IP rotated" | Dynamic home IP changed | `slv install firewall --allow <new-ip> [<rest>]` — idempotent rewrite |
| "fail2ban banned me" | Typed wrong password 5× | `sudo fail2ban-client set sshd unbanip <your-ip>` |
| "nftables says default-deny but SSH still works" | Expected — SSH is an always-open exception | Not a bug |

---

## Don't do

- Don't disable password auth BEFORE verifying key login works in a second terminal.
- Don't whitelist `0.0.0.0/0` — it defeats default-deny.
- Don't auto-add the operator's current SSH source IP — dynamic home IPs rotate.
