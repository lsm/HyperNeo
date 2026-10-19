#!/bin/bash
RUN=${1:?usage: stop.sh <run-dir>}
for name in daemon mock-api; do
  pid=$(cat "$RUN/$name.pid" 2>/dev/null) || continue
  pkill -TERM -P "$pid" 2>/dev/null
  kill -TERM "$pid" 2>/dev/null && echo "stopped $name ($pid)"
done
