#!/usr/bin/env bash
set -euo pipefail
PRESSURE=$(memory_pressure)
printf '%s\n' "$PRESSURE" | tail -3
FREE_PERCENT=$(printf '%s\n' "$PRESSURE" | sed -n 's/.*memory free percentage: \([0-9][0-9]*\)%.*/\1/p')
[[ "$FREE_PERCENT" =~ ^[0-9]+$ ]] || { echo 'MEMORY_GUARD: free memory unavailable'; exit 78; }
[[ "$FREE_PERCENT" -ge 25 ]] || { echo 'MEMORY_GUARD: less than 25% free'; exit 78; }
df -h /System/Volumes/Data
AVAILABLE=$(df -kP /System/Volumes/Data | awk 'NR==2 {print $4}')
[[ "$AVAILABLE" -ge 26214400 ]] || { echo 'DISK_GUARD: less than 25 GiB free'; exit 79; }
