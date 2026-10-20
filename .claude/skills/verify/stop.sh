#!/bin/bash
RUN=${1:?usage: stop.sh <run-dir>}
for name in daemon mock-api; do
  pid=$(cat "$RUN/$name.pid" 2>/dev/null) || continue
  pkill -TERM -P "$pid" 2>/dev/null
  kill -TERM "$pid" 2>/dev/null || true
  for _ in $(seq 1 150); do
    kill -0 "$pid" 2>/dev/null || break
    sleep 0.1
  done
  if kill -0 "$pid" 2>/dev/null; then
    echo "$name ($pid) is still shutting down; do not reuse its run dir yet" >&2
    exit 1
  fi
  rm -f "$RUN/$name.pid"
  echo "stopped $name ($pid)"
done
