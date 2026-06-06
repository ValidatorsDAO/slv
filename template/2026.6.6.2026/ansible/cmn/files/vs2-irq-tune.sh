#!/bin/bash
# vs2-irq-tune.sh — NIC IRQ pinning + RPS/XPS + NIC ring + THP optimization
# Runs at boot via systemd oneshot. Auto-detects physical core count.
set -euo pipefail

PHYS_CORES=$(nproc)
CORE_MAX=$((PHYS_CORES - 1))

if [ "$PHYS_CORES" -le 32 ]; then
  CPUMASK=$(printf "%08x" $(( (1 << PHYS_CORES) - 1 )))
else
  CPUMASK=$(python3 -c "print(hex((1 << $PHYS_CORES) - 1)[2:].zfill(8))")
fi

echo "vs2-irq-tune: ${PHYS_CORES} cores, mask=${CPUMASK}"

# 1. NIC IRQ 1:1 pinning
BOND_SLAVES=""
if [ -f /sys/class/net/bond0/bonding/slaves ]; then
  BOND_SLAVES=$(cat /sys/class/net/bond0/bonding/slaves)
fi
if [ -z "$BOND_SLAVES" ]; then
  BOND_SLAVES=$(grep -oP '\S+-TxRx-0' /proc/interrupts | sed 's/-TxRx-0//' | sort -u || true)
fi

for NIC in $BOND_SLAVES; do
  for cpu in $(seq 0 $CORE_MAX); do
    IRQ=$(grep "${NIC}-TxRx-${cpu}$" /proc/interrupts | awk -F: '{print $1}' | tr -d ' ' || true)
    if [ -n "$IRQ" ] && [ -d "/proc/irq/${IRQ}" ]; then
      echo "$cpu" > "/proc/irq/${IRQ}/smp_affinity_list" 2>/dev/null || true
    fi
  done
  echo "  NIC IRQ: pinned ${NIC} queues 0-${CORE_MAX}"
done

# 2. RPS for VLAN/bond
for rxq in /sys/class/net/bond0/queues/rx-*/rps_cpus /sys/class/net/bond0.*/queues/rx-*/rps_cpus; do
  [ -f "$rxq" ] && echo "$CPUMASK" > "$rxq" 2>/dev/null || true
done
for NIC in $BOND_SLAVES; do
  for rxq in /sys/class/net/${NIC}/queues/rx-*/rps_cpus; do
    [ -f "$rxq" ] && echo "$CPUMASK" > "$rxq" 2>/dev/null || true
  done
done
echo "  RPS: set to ${CPUMASK}"

# 3. XPS: pin each tx queue to corresponding CPU
for NIC in $BOND_SLAVES; do
  for cpu in $(seq 0 $CORE_MAX); do
    XPS_FILE="/sys/class/net/${NIC}/queues/tx-${cpu}/xps_cpus"
    if [ -f "$XPS_FILE" ]; then
      SINGLE_MASK=$(printf "%08x" $((1 << cpu)))
      echo "$SINGLE_MASK" > "$XPS_FILE" 2>/dev/null || true
    fi
  done
done
echo "  XPS: pinned"

# 4. NIC Ring Buffer → max (8192)
for NIC in $BOND_SLAVES; do
  ethtool -G "$NIC" rx 8192 tx 8192 2>/dev/null || true
done
echo "  NIC Ring: set to 8192"

# 5. Transparent Huge Pages → never
if [ -f /sys/kernel/mm/transparent_hugepage/enabled ]; then
  echo never > /sys/kernel/mm/transparent_hugepage/enabled 2>/dev/null || true
  echo never > /sys/kernel/mm/transparent_hugepage/defrag 2>/dev/null || true
  echo "  THP: disabled"
fi

echo "vs2-irq-tune: completed"
