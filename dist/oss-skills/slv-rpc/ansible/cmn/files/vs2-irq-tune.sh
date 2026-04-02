#!/bin/bash
# vs2-irq-tune.sh — NIC IRQ pinning + RPS/XPS optimization
# Runs at boot via systemd oneshot
set -euo pipefail

PHYS_CORES=$(nproc)
CORE_MAX=$((PHYS_CORES - 1))

# Calculate hex bitmask for all online CPUs
if [ $PHYS_CORES -le 32 ]; then
  CPUMASK=$(printf "%08x" $(( (1 << PHYS_CORES) - 1 )))
else
  CPUMASK=$(python3 -c "print(hex((1 << $PHYS_CORES) - 1)[2:].zfill(8))")
fi

echo "vs2-irq-tune: ${PHYS_CORES} cores, mask=${CPUMASK}"

# --- NIC IRQ 1:1 pinning ---
BOND_SLAVES=""
if [ -f /sys/class/net/bond0/bonding/slaves ]; then
  BOND_SLAVES=$(cat /sys/class/net/bond0/bonding/slaves)
fi

# Fallback for non-bond setups
if [ -z "$BOND_SLAVES" ]; then
  BOND_SLAVES=$(grep -oP '\S+-TxRx-0' /proc/interrupts | sed 's/-TxRx-0//' | sort -u || true)
fi

for NIC in $BOND_SLAVES; do
  for cpu in $(seq 0 $CORE_MAX); do
    IRQ=$(grep "${NIC}-TxRx-${cpu}$" /proc/interrupts | awk -F: '{print $1}' | tr -d ' ' || true)
    if [ -n "$IRQ" ] && [ -d "/proc/irq/${IRQ}" ]; then
      echo $cpu > /proc/irq/${IRQ}/smp_affinity_list 2>/dev/null || true
    fi
  done
  echo "  Pinned ${NIC} queues 0-${CORE_MAX}"
done

# --- RPS: distribute across all CPUs for VLAN/bond interfaces ---
for rxq in /sys/class/net/bond0/queues/rx-*/rps_cpus /sys/class/net/bond0.*/queues/rx-*/rps_cpus; do
  [ -f "$rxq" ] && echo $CPUMASK > "$rxq" 2>/dev/null || true
done

# For non-bond single NIC setups
for NIC in $BOND_SLAVES; do
  for rxq in /sys/class/net/${NIC}/queues/rx-*/rps_cpus; do
    [ -f "$rxq" ] && echo $CPUMASK > "$rxq" 2>/dev/null || true
  done
done

# --- XPS: pin each tx queue to corresponding CPU ---
for NIC in $BOND_SLAVES; do
  for cpu in $(seq 0 $CORE_MAX); do
    XPS_FILE="/sys/class/net/${NIC}/queues/tx-${cpu}/xps_cpus"
    if [ -f "$XPS_FILE" ]; then
      SINGLE_MASK=$(printf "%08x" $((1 << cpu)))
      echo $SINGLE_MASK > "$XPS_FILE" 2>/dev/null || true
    fi
  done
done

echo "vs2-irq-tune: completed"
