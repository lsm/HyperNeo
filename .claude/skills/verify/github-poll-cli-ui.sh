#!/usr/bin/env bash
set -euo pipefail
RUN=${1:?fresh absolute run dir}; PORT=${2:-9364}
[[ "$RUN" = /* && ! -e "$RUN" && "$PORT" != 8399 ]]
! lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1
mkdir -p "$RUN/home" "$RUN/data" "$RUN/bin" "$RUN/evidence"
cat > "$RUN/bin/gh" <<'GH'
#!/bin/sh
[ "$1" = api ] || exit 2
printf 'HTTP/2.0 200 OK\r\nContent-Type: application/json\r\nX-RateLimit-Limit: 5000\r\nX-RateLimit-Remaining: 4900\r\n\r\n'
case " $* " in *' /user '*) printf '{"login":"synthetic-human"}' ;; *) printf '[]' ;; esac
GH
chmod 700 "$RUN/bin/gh"
env -i HOME="$RUN/home" PATH="$RUN/bin:$(dirname "$(command -v bun)"):/usr/bin:/bin" NODE_ENV=test HYPERNEO_DATA_DIR="$RUN/data" \
 bun packages/cli/main.ts --port "$PORT" --host 127.0.0.1 --db-path "$RUN/data/daemon.db" > "$RUN/daemon.log" 2>&1 &
PID=$!
trap 'kill "$PID" 2>/dev/null || true; wait "$PID" 2>/dev/null || true' EXIT
for _ in $(seq 1 60); do
 kill -0 "$PID"
 if curl -fs -o /dev/null "http://127.0.0.1:$PORT/"; then break; fi
 sleep 0.5
done
VERIFY_PORT="$PORT" bun .claude/skills/verify/rpc.ts rpc:space.create "{\"name\":\"Synthetic GitHub settings\",\"workspacePath\":\"$RUN/home\"}" > "$RUN/evidence/space.json"
echo "Manual browser check ready: $RUN/evidence/space.json; port $PORT. Create $RUN/stop to stop."
while [[ ! -e "$RUN/stop" ]]; do sleep 1; done
