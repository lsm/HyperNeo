#!/usr/bin/env bash
set -euo pipefail
[[ $# = 1 && "$1" = /* ]] || { echo 'Expected one fresh absolute evidence directory' >&2; exit 2; }
EVIDENCE=$1
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PROOFS="$REPO_ROOT/.claude/skills/verify"
mkdir "$EVIDENCE"
cd "$REPO_ROOT"
export VERIFY_PROOF_RUNTIME=bun
bash "$PROOFS/proof-run.sh" "$EVIDENCE/neo-settings-writer" "$PROOFS/neo-settings-writer.ts" verify
bash "$PROOFS/proof-run.sh" "$EVIDENCE/lane-c-provider-rpc-writes" "$PROOFS/lane-c-provider-rpc-writes.ts"
bash "$PROOFS/proof-run.sh" "$EVIDENCE/lane-c-credential-store-writes" "$PROOFS/lane-c-credential-store-writes.ts"
echo 'Bun native smoke: settings/provider batch passed (3 legacy helpers)'
