# SLV WireGuard Skill

Stand up a WireGuard VPN on the SLV host and pair it with a
non-engineer user's phone or laptop. Guided pubkey exchange —
the private key never leaves the phone; the server's private key
never leaves the VPS.

**Related:** For nftables / fail2ban / SSH hardening, see the
**slv-firewall** skill. Run that first if you haven't yet — the
firewall playbook already opens UDP 51820 for WireGuard, so the
VPN will work out of the box.

Use this skill when the user says anything like:

- "set up the phone VPN" / "WireGuard on my iPhone"
- "I want to access SLV from my phone securely"
- "how do I VPN into this box"
- "can I close the gateway from the public internet?"

---

## EL's walkthrough

### Step 0 — Sanity probe

- `run_command: systemctl is-active wg-quick@wg0 2>/dev/null` — is WG already up?
- `run_command: command -v wg >/dev/null && wg show 2>&1 | head -20` — current peers, if any.
- `run_command: ss -lun | grep 51820` — is the server listening?

If WG is already up, read back the current peers and ask whether
the user wants to add another peer or replace the config.

### Step 1 — Phone side (walk the user through this BEFORE running anything on the server)

Tell the user, verbatim:

> "On your phone:
> 1. Install the official **WireGuard** app from the App Store / Google Play — it's free, made by the WireGuard project itself, look for the purple dragon logo. (Jason A. Donenfeld / Edge Security publisher.)
> 2. Open the app, tap the **+** button, pick **Create from scratch**.
> 3. Give the tunnel a name like `slv-<short-vps-name>` so you can identify it later.
> 4. The app auto-generates a key pair. Scroll down to the **Public key** field — it's a 44-character string ending in `=`. Tap it to copy.
>
> ⚠ Do NOT touch the **Private key** field. That one stays on your phone forever. Pasting it anywhere else (including to me) would invalidate the whole tunnel's security."

Desktop flow is identical: `wireguard` app from https://www.wireguard.com/install/
→ Add tunnel → From scratch → copy Public key.

Ask them to paste the **public** key.

### Step 2 — Server side

With their public key in hand, run:

```bash
slv install wireguard --iphone-pubkey '<the-44-char-pubkey>='
```

The playbook:
- Installs `wireguard` via apt.
- Generates (or reuses) the server's key pair at `/etc/wireguard/server_{private,public}.key`.
- Writes `/etc/wireguard/wg0.conf` with the user's pubkey as the sole peer.
- Sets up NAT masquerading (iptables POSTROUTING) so phone traffic can exit through the VPS's public interface.
- `systemctl enable --now wg-quick@wg0`.
- Exports the server's public key to `/tmp/slv-wg-server-pubkey.txt` (mode 0644) so the CLI can echo it to you without a second sudo.

When the playbook finishes, SLV prints the **server public key**
in a highlighted block. Copy that.

### Step 3 — Finish the phone-side config

Back on the user's phone, inside the tunnel they started in
Step 1, tell them:

> "Fill in these fields:
>
> **Addresses:** `10.0.0.2/32`
>
> **DNS servers:** `1.1.1.1` (or any public resolver)
>
> Then tap **Add peer** and fill:
>
> - **Public key:** (paste the server key I just showed you)
> - **Endpoint:** `<this-host-public-ip>:51820`
> - **Allowed IPs:** choose one:
>   - `10.0.0.0/24` — **split-tunnel** (only SLV traffic goes through the VPN; faster, keeps your regular phone traffic direct). Recommended for most users.
>   - `0.0.0.0/0` — **full-tunnel** (ALL phone traffic goes through the VPS; privacy-first, but slower and counts against your phone's perceived IP).
>
> Save. Slide the tunnel toggle to ON."

### Step 4 — Verify

Ask the user to try opening `http://10.0.0.1:20026/ui/` on their
phone while the VPN is on. If the SLV chat UI loads, the VPN
works — the phone is now reaching the gateway over the tunnel.

If they previously had the gateway in `lan` mode (0.0.0.0 bound),
suggest flipping back to loopback now:

```bash
slv gateway config set-mode local
```

The gateway is no longer directly exposed — only the WireGuard
peers on 10.0.0.0/24 can reach it. Cloudflare-fronted HTTPS (if
they ran `slv install nginx`) still works because nginx lives on
the same box on loopback.

---

## Adding a second peer (new phone, laptop, co-worker)

The current playbook only supports ONE peer at a time —
re-running `slv install wireguard --iphone-pubkey <new-pubkey>`
**replaces** the peer list. If the user needs multiple peers (e.g.
phone + laptop + partner's phone), either:

1. Run the playbook once per peer, and tell them only the
   most-recently-added peer can connect at a time.
2. Edit `/etc/wireguard/wg0.conf` manually to add more `[Peer]`
   blocks and run `sudo wg syncconf wg0 <(wg-quick strip wg0)`.

Proper multi-peer CLI is a future improvement tracked as a
follow-up — for now flag this limitation if the user asks.

---

## Reference

### `slv install wireguard`

```
slv install wireguard --iphone-pubkey '<44-char-pubkey>='
```

- Prompts interactively if `--iphone-pubkey` is missing.
- Validates the key is 44 base64 chars (23 bytes + 1 char padding) ending in `=`.
- Playbook: `template/latest/ansible/cmn/software/install-wireguard.yaml`.
- Idempotent: the server private key is preserved across runs; only the peer list gets rewritten.

### WireGuard apps (non-engineer friendly)

| Platform | App | Link |
|----------|-----|------|
| iOS | WireGuard | App Store — search "WireGuard" (purple dragon) |
| Android | WireGuard | Play Store — search "WireGuard" |
| macOS | WireGuard | https://www.wireguard.com/install/ or Mac App Store |
| Windows | WireGuard | https://www.wireguard.com/install/ |
| Linux | wireguard-tools | `sudo apt install wireguard` + `wg-quick` |

---

## Common failure modes + fixes

| User says | Likely cause | Fix |
|-----------|-------------|-----|
| "tunnel's on but I can't reach anything" | Endpoint IP or port wrong on the phone | Double-check `<public-ip>:51820` — `sudo ss -lun \| grep 51820` on the VPS confirms the port |
| "I copied the wrong key" | Pasted phone's Private key instead of Public | Tell them explicitly: "the *Public* key is the one safe to share" |
| "connection works but web browsing is broken" | split-tunnel with `10.0.0.0/24` but user wants full-tunnel | Change `Allowed IPs` on the phone to `0.0.0.0/0` |
| "it worked yesterday, dead today" | VPS's public IP changed | Update **Endpoint** on the phone side to the new IP |
| "playbook fails `Assert peer public key is present`" | Pasted the wrong string or includes whitespace | Re-copy the exact 44-char line ending in `=`, no extra spaces |

---

## Don't do

- Don't paste the phone's **Private key** anywhere off the phone. Only the Public key travels.
- Don't share the server's private key (`/etc/wireguard/server_private.key`). Only the public key does.
- Don't run `slv install wireguard` with an empty or obviously wrong pubkey — the `Assert peer public key is present and well-formed` task will fail, but the server's *existing* key pair survives (so re-running with a valid key is safe).
- Don't whitelist the WireGuard UDP port on nftables to "only your IP" — phones on mobile networks have highly dynamic IPs; the port needs to be reachable from the world. Token-auth + peer-pubkey-auth already gates who can actually use the tunnel.
