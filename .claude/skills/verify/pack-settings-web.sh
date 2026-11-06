#!/usr/bin/env bash
set -euo pipefail
PROOF_EVIDENCE=${1:?usage: pack-settings-web.sh <fresh-absolute-evidence-directory>}
[[ "$PROOF_EVIDENCE" = /* ]] || exit 2
export PROOF_EVIDENCE
if [[ "$(uname)" == Darwin ]]; then
  bash .claude/skills/verify/resource-check.sh
fi
mkdir "$PROOF_EVIDENCE"
bash .claude/skills/verify/with-run.sh bash -c '
  port=$(python3 -c '\''import socket;s=socket.socket();s.bind(("127.0.0.1",0));print(s.getsockname()[1]);s.close()'\'')
  result=0
  bash .claude/skills/verify/coding-pack-settings.sh "$RUN/settings" "$port" > "$PROOF_EVIDENCE/proof.log" 2>&1 || result=$?
  touch "$RUN/.preserve-run"
  cp -R "$RUN/settings/evidence/." "$PROOF_EVIDENCE/" && cp "$RUN/settings/daemon.log" "$PROOF_EVIDENCE/daemon.log" || exit 1
  printf '\''{"exitCode":%s}\n'\'' "$result" > "$PROOF_EVIDENCE/run-status.json"
  [[ ! -f "$RUN/settings/daemon.pid" ]] || exit 1
  python3 -c '\''import os,pathlib;pathlib.Path(os.environ["RUN"],".preserve-run").unlink()'\''
  exit "$result"
'
