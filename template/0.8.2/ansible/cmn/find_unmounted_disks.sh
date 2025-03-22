#!/bin/bash

# This script discovers unmounted, unpartitioned disks >=400GB,
# prioritizes NVMe over others, and sorts by size descending.

find_unmounted_disks() {
  lsblk -nr -o NAME,TYPE,SIZE,MOUNTPOINT | awk '
    $2 == "disk" &&
    ($4 == "" || $4 ~ /^[[:space:]]*$/) &&
    system("lsblk -nr -o TYPE /dev/" $1 " | grep -q part") != 0 {
      size = $3
      suffix = substr(size, length(size), 1)
      base = substr(size, 1, length(size)-1) + 0
      if (suffix == "T") base *= 1000
      if (base >= 400) {
        nvme = ($1 ~ /^nvme/) ? 1 : 0
        print nvme, base, $1
      }
    }' | sort -k1,1nr -k2,2nr | awk '{print $3}'
}

find_unmounted_disks
