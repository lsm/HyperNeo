#!/usr/bin/env bash
set -euo pipefail
EVIDENCE=$1
PROOF=$2
shift 2
[[ "$EVIDENCE" = /* ]] || { echo 'Evidence directory must be absolute'; exit 2; }
bash "$(dirname "${BASH_SOURCE[0]}")/resource-check.sh"
mkdir "$EVIDENCE"
PROOF_TMP_ROOT=${TMPDIR:-/private/tmp}
RUN=$(mktemp -d "${PROOF_TMP_ROOT%/}/hyperneo-proof-XXXXXX")
RUN=$(cd "$RUN" && pwd -P)
save_and_clean() {
  STATUS=$?
  trap - EXIT
  if [[ -d "$RUN/evidence" ]]; then cp -R "$RUN/evidence/." "$EVIDENCE/" || exit 1; fi
  cp "$RUN/proof.log" "$EVIDENCE/proof.log" || exit 1
  printf '{"exitCode":%s}\n' "$STATUS" > "$EVIDENCE/run-status.json" || exit 1
  rm -rf "$RUN"
  echo "Evidence saved: $EVIDENCE; temporary daemon data removed"
  exit "$STATUS"
}
trap save_and_clean EXIT
mkdir -p "$RUN/home" "$RUN/tmp" "$RUN/bin"
PROOF_RUNTIME=(bun)
if [[ ${VERIFY_PROOF_RUNTIME:-bun} = node ]]; then
  PROOF_RUNTIME=(node --import tsx)
fi
env -i HOME="$RUN/home" PATH="$RUN/bin:$PATH" TMPDIR="$RUN/tmp" NODE_ENV=test \
  NODE_PATH="${NODE_PATH:-}" VERIFY_BROWSER="${VERIFY_BROWSER:-}" \
  HYPERNEO_DATA_DIR="$RUN/data" VERIFY_CLAUDE="${VERIFY_CLAUDE:-}" LOG_LEVEL=warn "${PROOF_RUNTIME[@]}" "$PROOF" "$@" "$RUN" \
  > "$RUN/proof.log" 2>&1
