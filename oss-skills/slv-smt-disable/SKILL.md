---
name: slv-smt-disable
description: Disable SMT (Hyper-Threading) by adding `nosmt=force` to GRUB. Required for stable single-thread performance on Solana validators / RPCs. Reboot required.
---

# SLV SMT (Hyper-Threading) Disable Skill

Solana validator / RPC throughput is dominated by single-thread instruction performance, so disabling SMT consistently produces higher and more stable performance. Applied during `slv v init` / `slv r init` as part of the tuning phase.

## How it works

Adds `nosmt=force` to `GRUB_CMDLINE_LINUX_DEFAULT` in `/etc/default/grub` and runs `update-grub`. After reboot, the kernel only schedules on one logical thread per physical core.

## Related ansible playbook

- `ansible/cmn/smt_disable.yml` — appends `nosmt=force` to GRUB and runs `update-grub`
- Idempotency marker: `/var/lib/slv/.smt_disabled`

## Standalone run

```bash
ansible-playbook -i inventory.yml cmn/smt_disable.yml --limit <host>
```

Sets `need_reboot=true` only when GRUB actually changed; the orchestrator reboots when needed.

## Verification

```bash
# on the host
cat /proc/cmdline                      # should contain nosmt=force
lscpu | grep -E 'Thread|Core|Socket'   # Thread(s) per core: 1
```

## Rollback

```bash
sudo sed -i 's/ nosmt=force//' /etc/default/grub
sudo update-grub
sudo rm /var/lib/slv/.smt_disabled
sudo reboot
```
