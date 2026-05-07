---
name: slv-performance-boost
description: Update the kernel (Ubuntu HWE 6.14+), set `amd_pstate=active` (AMD), and apply cpufreq governor=performance, EPP=performance, cpuidle disable, and `scaling_max_freq=cpuinfo_max_freq` so the CPU stays at maximum boost. AMD nodes on kernel < 6.14 require HWE install + reboot.
---

# SLV CPU Performance Boost Skill

Keeps Solana validator / RPC nodes running at peak CPU frequency at all times. Runs alongside SMT disable and IRQ tuning as part of the `slv v init` / `slv r init` tuning phase.

## What it applies

| # | Item | Effect | Reboot |
|---|------|--------|--------|
| 1 | `apt-get update && apt-get upgrade -y` | Refresh OS packages and userland | No |
| 2 | Install HWE kernel (`linux-image-generic-hwe-24.04`) | Enables `amd_pstate` 6.14+ on AMD | **Yes** (AMD only when kernel < 6.14) |
| 3 | GRUB `amd_pstate=active processor.max_cstate=0 cpufreq.default_governor=performance` | Initializes amd_pstate driver in active mode at boot | **Yes** (AMD only, first apply) |
| 4 | `modprobe amd_pstate` | Try to load the driver at runtime | No |
| 5 | `governor=performance` | Lock frequency at maximum | No |
| 6 | `EPP=performance` | Push the energy/performance preference toward performance | No |
| 7 | `boost=enabled` / Intel `no_turbo=0` | Enable Turbo Boost | No |
| 8 | `cpuidle state*/disable=1` | Disable C-states to avoid latency spikes | No |
| 9 | `scaling_max_freq=cpuinfo_max_freq` | Align scaling ceiling with the hardware ceiling | No |
| 10 | `slv-cpu-boost.service` (oneshot) | Re-applies items 5-9 on every boot | No |

## Related artifacts

- `ansible/cmn/boost_performance.yml`
- Idempotency marker: `/var/lib/slv/.boost_applied`
- Persistence script: `/usr/local/bin/slv-cpu-boost.sh`
- systemd unit: `/etc/systemd/system/slv-cpu-boost.service`

## Options

| Variable | Default | Description |
|----------|---------|-------------|
| `amd_pstate_mode` | `active` | `active` (best performance) or `passive` |

## Standalone run

```bash
ansible-playbook -i inventory.yml cmn/boost_performance.yml --limit <host>
ansible-playbook -i inventory.yml cmn/boost_performance.yml --limit <host> -e amd_pstate_mode=passive
```

## Kernel update + reboot

When an AMD CPU is detected and `uname -r` is below 6.14, the playbook installs the HWE kernel, writes the `amd_pstate=active` GRUB cmdline, and the orchestrator (`cmn/optimize_node.yml`) detects `need_reboot=true` and reboots automatically.

## Verification

The fastest way is `slv check boost`:

```bash
slv check boost -t validator -n mainnet -p <pubkey>
slv check boost -t rpc -n mainnet -p <pubkey>
```

This command is a Deno port of the master-api `performanceCheckRouter` and evaluates every check by category — `[OS]`, `[BIOS]`, `[CONTROL_PLANE]`, `[RUNTIME]`, `[INFO]` — returning `OK` / `WARN` / `NG`. Exit codes: `OK=0`, `WARN=1`, `NG=2`. When a `BIOS` blocker is detected, the report prints a friendly hint that lists the BIOS knobs needed to lift the firmware-side ceiling.

Manual verification:

```bash
uname -r                                                          # >= 6.14 (mandatory on AMD)
cat /sys/devices/system/cpu/amd_pstate/status                     # active
cat /sys/devices/system/cpu/cpu0/cpufreq/scaling_governor         # performance
cat /sys/devices/system/cpu/cpu0/cpufreq/energy_performance_preference  # performance
cat /sys/devices/system/cpu/cpufreq/boost                         # 1
grep 'cpu MHz' /proc/cpuinfo | sort -u                            # near hardware max
systemctl is-active slv-cpu-boost.service                         # active
```

## When BIOS is the blocker

If `slv check boost` reports a `[BIOS]` blocker, the OS side is already correctly configured but `cpuinfo_max_freq` is below the catalog turbo frequency for the CPU model. That means the motherboard firmware / BIOS is capping the hardware ceiling. Typical fixes:

| BIOS setting | Recommended value |
|--------------|-------------------|
| Determinism Slider | Performance |
| CPPC / Core Performance Boost | Enabled |
| Global C-States Control | Disabled |
| Power Profile | Maximum Performance / Top Performance |
| P-State / Cool'n'Quiet | Disabled (when amd_pstate=active) |

## Rollback

```bash
sudo systemctl disable --now slv-cpu-boost.service
sudo rm /etc/systemd/system/slv-cpu-boost.service /usr/local/bin/slv-cpu-boost.sh
sudo sed -i 's/ amd_pstate=[^ ]*//; s/ processor.max_cstate=[^ ]*//; s/ cpufreq.default_governor=[^ ]*//' /etc/default/grub
sudo update-grub
sudo rm /var/lib/slv/.boost_applied
sudo reboot
```
