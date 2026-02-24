#!/bin/bash

find_unmounted_nvme_disks() {
    lsblk -nr -o NAME,TYPE,SIZE,MOUNTPOINT | awk '
    $2 == "disk" && 
    $1 ~ /^nvme/ && 
    (($3 ~ /G$/ && substr($3, 1, length($3)-1) + 0 >= 800) || 
     ($3 ~ /T$/ && substr($3, 1, length($3)-1) + 0 >= 0.8)) && 
    ($4 == "" || $4 ~ /^[[:space:]]*$/) && 
    system("lsblk -nr -o TYPE /dev/" $1 " | grep -q part") != 0 {print $1}'
}

find_unmounted_nvme_disks
