#!/bin/bash
# Removes Locked Use and restores the stock screen-unlock rule from install.sh's backup.
# Run as root. Changes nothing unless the root-owned stock backup is valid and the live
# rule equals it, with or without the Locked Use entry install.sh added. The plugin is
# deleted only after its right is proven absent.
set -euo pipefail
[[ $EUID == 0 ]] || { echo "run with sudo" >&2; exit 1; }
. "$(dirname "$0")/policy.sh"
uninstall_locked_use
echo "removed"
