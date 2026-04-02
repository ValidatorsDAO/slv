#!/bin/bash
# vs2-cpu-boost.sh — CPU performance settings on boot
# Runs at boot via systemd oneshot (vs2-cpu-boost.service)
# For AMD Ryzen/EPYC with amd_pstate driver
set -e

# Governor + EPP → performance
for gov in /sys/devices/system/cpu/cpu*/cpufreq/scaling_governor; do
  echo performance > "$gov" 2>/dev/null || true
done
for epp in /sys/devices/system/cpu/cpu*/cpufreq/energy_performance_preference; do
  echo performance > "$epp" 2>/dev/null || true
done

# Global + per-CPU boost enable
echo 1 > /sys/devices/system/cpu/cpufreq/boost 2>/dev/null || true
for f in /sys/devices/system/cpu/cpu*/cpufreq/boost; do
  echo 1 > "$f" 2>/dev/null || true
done

# IMPORTANT: set scaling_max FIRST, then scaling_min
# Otherwise scaling_min > scaling_max causes the kernel to clamp both
MAX=$(cat /sys/devices/system/cpu/cpu0/cpufreq/cpuinfo_max_freq 2>/dev/null || echo 0)
if [ "$MAX" -gt 0 ]; then
  for f in /sys/devices/system/cpu/cpu*/cpufreq/scaling_max_freq; do
    echo "$MAX" > "$f" 2>/dev/null || true
  done
fi

# scaling_min = nominal frequency (~75% of max) to prevent idle drop to base clock
# This keeps all cores above base frequency even when idle
if [ "$MAX" -gt 0 ]; then
  NOMINAL_FREQ=$(awk "BEGIN {printf \"%d\", $MAX * 0.75}")
  for f in /sys/devices/system/cpu/cpu*/cpufreq/scaling_min_freq; do
    echo "$NOMINAL_FREQ" > "$f" 2>/dev/null || true
  done
fi

# Disable cpuidle states if available
for state in /sys/devices/system/cpu/cpu*/cpuidle/state*/disable; do
  [ -f "$state" ] && echo 1 > "$state" 2>/dev/null || true
done

exit 0
