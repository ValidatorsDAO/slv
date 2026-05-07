---
name: slv-irq-tuning
description: NIC IRQ 1:1 pinning, NVMe queue limits, RPS/XPS, NIC ring buffer, sysctl (UDP/TCP buffers, swappiness, netdev_max_backlog), THP off, and ulimit nofile=1M for Solana / Shredstream nodes. Reboot is required when NVMe queue parameters change.
---

# SLV IRQ & Network Tuning Skill

Removes NIC IRQ imbalance and applies Solana-friendly kernel parameters. Runs as part of `slv v init` / `slv r init` after the SSH connection check, alongside SMT disable and performance boost.

## What it applies

| # | Item | Effect | Reboot |
|---|------|--------|--------|
| 1 | NIC IRQ 1:1 pinning | Distributes NET_RX softirq evenly across all CPUs | No |
| 2 | RPS/XPS enable | Software-level packet distribution | No |
| 3 | NIC ring buffer → 8192 (max) | Prevents packet drops during bursts | No |
| 4 | NVMe queues = ncores | Stops queues from being assigned to offline CPUs | **Yes** |
| 5 | sysctl: UDP/TCP buffers 128MB | Prevents drops on Shredstream / gRPC | No |
| 6 | sysctl: vm.swappiness → 1 | Avoids swapping under memory pressure | No |
| 7 | sysctl: netdev_max_backlog → 50000 | Prevents NIC → kernel queue overflow | No |
| 8 | THP (Transparent Huge Pages) → never | Avoids latency spikes | No |
| 9 | ulimit nofile → 1000000 | Prevents fd exhaustion | No (new sessions only) |

## Related ansible playbooks

- `ansible/cmn/irq_tune.yml` — applies items 1-9 above
- `ansible/cmn/files/vs2-irq-tune.sh` — re-applies NIC IRQ pin + RPS/XPS + ring + THP at boot (systemd oneshot)
- `ansible/cmn/files/vs2-irq-tune.service` — systemd unit for the above
- `ansible/cmn/files/99-vs2-solana.conf` — sysctl parameters
- `ansible/cmn/files/99-vs2-solana-limits.conf` — `/etc/security/limits.d/`
- `ansible/cmn/files/vs2-limits.conf` — systemd `DefaultLimitNOFILE` drop-in

## Run it

Normally invoked through `cmn/optimize_node.yml` together with SMT disable and CPU boost. Standalone:

```bash
ansible-playbook -i inventory.yml cmn/irq_tune.yml --limit <host>
```

Only sets `need_reboot=true` when NVMe queue parameters in GRUB had to change. The orchestrator reboots the host when needed.

## Verification

| Check | Expected |
|-------|----------|
| NIC IRQ queue N → CPU N | 1:1 mapping |
| RPS (bond0/vlan) | `ffff` etc. |
| NIC ring buffer | RX: 8192, TX: 8192 |
| NVMe IRQ on offline CPU | none |
| net.core.rmem_max / wmem_max | 134217728 |
| net.core.netdev_max_backlog | 50000 |
| vm.swappiness | 1 |
| THP | `[never]` |
| GRUB has `nvme.io_queues=N` | physical core count |
| `vs2-irq-tune.service` | active (exited) |
| irqbalance | inactive (disabled) |

## Rollback

```bash
sudo systemctl disable vs2-irq-tune.service
sudo rm /etc/systemd/system/vs2-irq-tune.service /usr/local/bin/vs2-irq-tune.sh
sudo systemctl enable irqbalance && sudo systemctl start irqbalance
sudo rm /etc/sysctl.d/99-vs2-solana.conf /etc/security/limits.d/99-vs2-solana.conf
sudo rm /etc/systemd/system.conf.d/vs2-limits.conf
sudo systemctl daemon-reexec
sudo sysctl --system
sudo sed -i 's/ nvme.io_queues=[0-9]* nvme.write_queues=[0-9]* nvme.poll_queues=[0-9]*//' /etc/default/grub
sudo update-grub
sudo rm /var/lib/slv/.irq_tuned
# reboot to drop NVMe GRUB params
```
