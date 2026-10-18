# SLV WireGuard Skill

Use for a requested VPN connection to a phone, laptop or other peer. Exchange
public keys only. Private keys and the contents of `wg0.conf` stay outside chat
and AI file tools.

## Choose the target and routing

Identify the VPN endpoint and the host serving the application. They may be
different. A separate VPN server is an option for isolation, not a mandatory
purchase. Connecting to a VPN endpoint does not automatically route to another
server's private services.

Check existing peers, the intended access route, UDP 51820 reachability, subnet
conflicts and existing firewall/NAT rules on the chosen host. Do not blindly
install the generic **slv-firewall** baseline on an active validator/RPC or an
existing VPN: it replaces rules and may erase required ports or NAT.

Non-secret checks on the actual target include `systemctl is-active wg-quick@wg0`,
`ss -lun`, and selected public interface/handshake status. Do not use a WireGuard
configuration dump, `wg showconf`, or a private-key query. If a tunnel exists,
explain that this installer replaces its peer list before proceeding.

## Prepare the peer locally

Have the operator use their WireGuard client to create a tunnel and key pair on
their own device. Only the **public key** is shared. It is 32 bytes encoded as
44 base64 characters ending in `=`. Never request or generate the client's
private key through chat. The official installation guide is available at
https://www.wireguard.com/install/.

Collect the peer public key and the exact endpoint inventory target. Do not ask
for credentials or private configuration files.

## Run the supported installer in a terminal

```bash
slv install wireguard -i <inventory.yml> -l <vpn-host> --iphone-pubkey '<peer-public-key>'
```

`-i` is required. `-l` limits an inventory file to the intended host. For a single
literal IP, use Ansible inline inventory with a trailing comma, e.g.
`-i '<vpn-ip>,'`. Without the comma, Ansible may interpret the value as a file.
The CLI uses the `solv` SSH user; verify the inventory and access first.

Even with all options supplied, the command asks “Proceed with WireGuard
install?” It has **no `-y` option**. Have the operator run it in their terminal;
do not call it from a noninteractive AI shell, pipe confirmation answers or
invoke the playbook directly to bypass the prompt.

The supported playbook installs WireGuard, enables IPv4 forwarding, creates or
reuses the server's private key, writes one peer to `wg0.conf`, configures IPv4
NAT, and restarts `wg-quick@wg0`. Defaults:

- Server: `10.0.0.1/24`, UDP 51820.
- One peer: `10.0.0.2/32`.
- Peer list: replaced on each install. A second run is **not** an add-peer
  operation and can disconnect the previous device.

The server key remains on the server. The AI must not read, copy, create or edit
private keys or `wg0.conf`. If multiple peers or a different subnet are needed,
stop and plan an operator-managed configuration; do not overwrite a working VPN
under the claim of adding a peer.

## Finish and verify the connection

Use the server public key verified on the intended host. The playbook exports a
public-key-only file on its target, while the CLI reads the export locally, so a
remote installation may not display the public key correctly. In that case have
the operator verify the target's public key from its install output. Do not read
private configuration to recover it or claim installation failed solely because
the local export was absent.

On the peer, configure its address, the verified server public key, the actual
endpoint address/UDP port, and the required routes. `10.0.0.0/24` routes that VPN
subnet; it does not by itself reach a separate validator or RPC server.
`0.0.0.0/0` requests a full IPv4 tunnel and needs working forwarding/NAT; it is not
a claim that IPv6 or every service is covered.

Verify a recent handshake, packet flow and the intended service. A chat gateway
bound to `127.0.0.1` does **not** listen on `10.0.0.1`. Changing
`slv gateway config set-mode local` does not make it VPN-accessible. Select an
explicit proxy, SSH tunnel or reviewed bind/firewall arrangement. LAN mode binds
all interfaces, so it requires an appropriate firewall; do not open it globally
as an automatic workaround.

If the VPN endpoint and application host differ, configure and verify the
required route, tunnel or proxy between them with separate approval. Report
which access path was actually tested and preserve the operator's existing
recovery route throughout the change.
