#!/bin/bash
set -euo pipefail
OLD=${1:?usage: upgrade-check.sh <old-checkout> <port> [run-dir]}
PORT=${2:?usage: upgrade-check.sh <old-checkout> <port> [run-dir]}
RUN=${3:-$(mktemp -d "${TMPDIR:-/tmp}/hyperneo-upgrade.XXXXXX")}
NEW=$(cd "$(dirname "$0")/../../.." && pwd)
DB="$RUN/data/daemon.db"
report() {
  local legacy marker
  legacy=$(sqlite3 -readonly "$DB" "SELECT count(*) FROM sqlite_master WHERE type = 'table' AND (
    name IN ('neo_work', 'legacy_neo_asks', 'neo_ask_items', 'neo_ask_work', 'neo_ask_checks',
      'neo_agent_work_targets') OR name LIKE 'neo\_work\_%' ESCAPE '\')")
  marker=$(sqlite3 -readonly "$DB" "SELECT key FROM migration_markers
    WHERE key GLOB 'migration_[0-9][0-9][0-9]' ORDER BY key DESC LIMIT 1")
  echo "$1: $legacy legacy tables, newest marker $marker"
}
stop_and_wait() {
  local pid
  pid=$(cat "$RUN/daemon.pid")
  "$NEW/.claude/skills/verify/stop.sh" "$RUN" >/dev/null
  while kill -0 "$pid" 2>/dev/null; do sleep 1; done
  while lsof -nP -iTCP:8000 -sTCP:LISTEN >/dev/null 2>&1; do sleep 1; done
}
[ -e "$OLD/packages/web/dist" ] || ln -s "$NEW/packages/web/dist" "$OLD/packages/web/dist"
VERIFY_REPO="$OLD" "$NEW/.claude/skills/verify/launch.sh" "$PORT" "$RUN"
stop_and_wait
report "old ($(git -C "$OLD" rev-parse --short HEAD))"
"$NEW/.claude/skills/verify/launch.sh" "$PORT" "$RUN"
stop_and_wait
report "upgraded ($(git -C "$NEW" rev-parse --short HEAD))"
"$NEW/.claude/skills/verify/launch.sh" "$PORT" "$RUN"
stop_and_wait
report "restarted"
echo "run dir: $RUN"
