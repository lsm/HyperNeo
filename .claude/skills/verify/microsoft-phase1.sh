#!/usr/bin/env bash
set -euo pipefail
EVIDENCE=$1
[[ "$EVIDENCE" = /* ]] || { echo 'Evidence directory must be absolute'; exit 2; }
HERE=$(dirname "${BASH_SOURCE[0]}")
mkdir "$EVIDENCE"
for step in microsoft-sign-in microsoft-refresh outlook-mail outlook-draft outlook-calendar; do
  bash "$HERE/proof-run.sh" "$EVIDENCE/$step" "$HERE/$step.ts"
  grep '^PASS: ' "$EVIDENCE/$step/proof.log"
done
echo 'PASS: Microsoft phase 1: sign-in, refresh, mail, drafts and calendar'
