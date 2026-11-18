#!/usr/bin/env bash
set -euo pipefail
BIN=${1:?compiled daemon binary required}
CLI=${2:?fixture Claude binary required}
RUN=${3:?fresh absolute run directory required}
PORT=${4:-9413}
case "$RUN" in /*) ;; *) exit 2 ;; esac
[[ ! -e "$RUN" && "$PORT" != 8399 ]]
mkdir -p "$RUN/home" "$RUN/data" "$RUN/bin" "$RUN/package"
cp "$CLI" "$RUN/package/claude"
tar -czf "$RUN/fixture.tgz" -C "$RUN" package
cat > "$RUN/bin/npm" <<SCRIPT
#!/bin/sh
printf '%s\n' "\$@" > "$RUN/npm-args"
/bin/cp "$RUN/fixture.tgz" "\$4/fixture.tgz"
printf 'fixture.tgz\n'
SCRIPT
cat > "$RUN/bin/curl" <<'SCRIPT'
#!/bin/sh
exit 7
SCRIPT
chmod +x "$RUN/bin/npm" "$RUN/bin/curl"
env -i HOME="$RUN/home" PATH="$RUN/bin:/usr/bin:/bin:/usr/sbin" TMPDIR="$RUN" NODE_ENV=test \
  HYPERNEO_DATA_DIR="$RUN/data" "$BIN" --port "$PORT" --db-path "$RUN/data/daemon.db" > "$RUN/daemon.log" 2>&1 &
PID=$!
trap 'kill "$PID" 2>/dev/null || true; wait "$PID" 2>/dev/null || true' EXIT
for _ in $(seq 1 120); do
  if grep -qE '\[SDK\] Claude Code binary (ready|unavailable)' "$RUN/daemon.log"; then break; fi
  kill -0 "$PID" || break
  sleep 0.25
done
if [[ -f "$RUN/npm-args" ]]; then count=$(wc -l < "$RUN/npm-args" | tr -d ' '); else count=0; fi
printf 'npm argument count: %s\n' "$count"
if grep -q '\[SDK\] Claude Code binary ready:' "$RUN/daemon.log" && [[ "$count" -eq 4 ]]; then
  echo 'PASS: daemon downloaded the SDK through fake npm'
else
  echo 'FAIL: daemon did not download the SDK through fake npm'
  exit 1
fi
