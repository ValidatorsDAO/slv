# SLV Firewall Skill

Use this skill when the user asks to inspect or change firewall/SSH access. Start
with the requested task; do not turn ordinary chat into unsolicited hardening.

## Identify the machine and preserve access

`slv install firewall` changes **the machine running SLV**, through a local
playbook. It has no inventory or remote-host option. A command on the management
laptop does not configure a remote validator.

Before proposing changes, establish:

1. The target machine, its role (management host, VPN endpoint, validator, RPC or
   application server), and whether SLV is running there.
2. Its existing firewall, listening services and required ports, including the
   actual SSH port, validator gossip/TPU/dynamic ports, RPC/gRPC, monitoring,
   container networking and any VPN forwarding.
3. A verified SSH session and a recovery route such as the provider console.
   Keep a second working session open during approved changes.

Read-only probes such as `ss -lntup`, `sudo nft list ruleset`, and
`systemctl is-active fail2ban` must run on that confirmed target. Do not dump
secret-bearing configuration files. Inspect account inventory only when needed
to resolve the requested target; do not automatically whitelist every server the
account owns.

## Understand the baseline before installing

The current baseline is for a simple management/development host. It writes
`/etc/nftables.conf` and uses `flush ruleset`, replacing existing firewall rules.
Rerunning with different allowed IPs replaces that list; manual rules are not
preserved. Defaults are:

- Loopback, established/related traffic, ICMP and ICMPv6 accepted.
- TCP 22, 80 and 443 open to all sources.
- UDP 51820 open for WireGuard.
- Sources in `10.0.0.0/24` and explicitly allowed IPv4 addresses accepted on all
  ports. These source rules do not authenticate a WireGuard handshake themselves.
- Other inbound traffic dropped; forwarding and outgoing traffic accepted.
- fail2ban monitors SSH: five failures in ten minutes can cause a one-hour ban.

This does **not** make SSH or the web ports private. A source whitelist grants
broad access; it is not a substitute for service authentication or a full
role-specific network policy.

Do not blindly install this baseline on an active validator/RPC, custom SSH port,
container network, existing VPN or host with custom rules. It can interrupt node
traffic and erase NAT rules. The CLI exposes no arbitrary port policy option;
if the role needs more rules, stop and prepare a separate reviewed policy instead
of promising this command will preserve them. Do not disable other firewalls or
change a live node's rules merely to make the generic baseline fit.

## Apply only the reviewed local plan

After the operator approves the exact target and policy, the supported command is:

```bash
slv install firewall --allow <trusted-ip> -y
```

`--allow` accepts repeatable or comma-separated IPv4 addresses. CIDRs are not
accepted. Omit it only if the baseline's always-open ports and peer-subnet rule
are the intended policy. `-y` skips the CLI prompt; it is not permission to skip
user approval. Do not automatically add a dynamic home address or label it static.
Explain how the user's access survives address changes.

A VPN is optional. Discuss whether it belongs on this host or a separate endpoint
without making a purchase a prerequisite. A VPN on another server requires
explicit routing/proxying to reach this one. See **slv-wireguard** when requested.

## SSH hardening: add, verify, then disable

Public SSH keys may be shared; private keys and passphrases stay outside chat.
Have the operator generate and protect any needed private key on their own
machine. `slv add:ssh '<public-key>'` updates the **current user's**
`~/.ssh/authorized_keys`, so verify both the execution host and intended login
user. It does not distribute the key to an arbitrary remote server.

Before disabling passwords, have the operator confirm a fresh key-authenticated
login in a second terminal to the correct user, host and SSH port. Keep that
session and recovery access open. Then, with approval:

```bash
slv disable pwd-login
```

Without `--target`, this changes the host running SLV. For an inventory-managed
remote host, the registered options are `-t <inventory-group> -p <host>`; never
omit the host limit for a single-host task. Inspect effective SSH settings and
verify another fresh login afterward. Do not claim password authentication is
disabled until the effective configuration and login behavior confirm it.

## Verify results

Read back the effective rules, listening services and fail2ban status. Verify SSH
from the user's real access path and confirm that required application/node
traffic still works. Report observed results and remaining uncertainty, not a
generic “locked down” success message. If access fails, use the prearranged rescue
path; do not blindly rerun the installer or flush rules again.
