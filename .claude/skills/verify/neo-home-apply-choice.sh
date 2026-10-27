#!/usr/bin/env bash
set -euo pipefail
RUN=${1:?fresh owned run path}
PHASE=${2:-after}
PORT=${3:-9417}
[[ "$PORT" != 8399 && "$PORT" =~ ^[0-9]+$ && "$PHASE" =~ ^(before|after)$ ]]
[[ "$RUN" = /* && ! -e "$RUN" ]]
REPO=$(cd "$(dirname "$0")/../../.." && pwd)
cd "$REPO"
if lsof -nP -iTCP:$PORT -sTCP:LISTEN >/dev/null 2>&1; then exit 2; fi
mkdir -p "$RUN/home" "$RUN/data" "$RUN/bin" "$RUN/evidence"
cp .claude/skills/verify/gh-stub.sh "$RUN/bin/gh"
clean=(env -i HOME="$RUN/home" PATH="$RUN/bin:$(dirname "$(command -v bun)"):/usr/bin:/bin:/usr/sbin" TMPDIR="$RUN" NODE_ENV=test HYPERNEO_DATA_DIR="$RUN/data" HYPERNEO_WORKSPACE_PATH="$RUN" GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL="$RUN/gitconfig")
"${clean[@]}" bun packages/cli/main.ts --port "$PORT" --host 127.0.0.1 --db-path "$RUN/data/daemon.db" > "$RUN/daemon.log" 2>&1 &
pid=$!
echo "$pid" > "$RUN/daemon.pid"
trap 'bash .claude/skills/verify/stop.sh "$RUN"' EXIT
for _ in $(seq 1 80); do
 if lsof -nP -a -p "$pid" -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then break; fi
 kill -0 "$pid"
 sleep 0.25
done
lsof -nP -a -p "$pid" -iTCP:"$PORT" -sTCP:LISTEN >/dev/null
"${clean[@]}" bun .claude/skills/verify/neo-home-apply-choice.ts "$PORT" "$RUN" "$PHASE" "${4:-normal}"
