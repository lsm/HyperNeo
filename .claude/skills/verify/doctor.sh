#!/bin/bash
PORT=${1:?usage: doctor.sh <port> <run-dir>}
RUN=${2:?usage: doctor.sh <port> <run-dir>}
ok=1
check() { if eval "$2" >/dev/null 2>&1; then echo "ok    $1"; else echo "FAIL  $1"; ok=0; fi; }
check "test mode" "grep -q 'HyperNeo Test Server' '$RUN/daemon.log'"
check "database inside the run dir" "grep -q 'Database: $RUN/' '$RUN/daemon.log'"
check "web UI served" "curl -fs -o /dev/null http://127.0.0.1:$PORT/"
check "RPC answers" "VERIFY_PORT=$PORT bun '$(dirname "$0")/rpc.ts' rpc:auth.providers"
check "mock model API on ${VERIFY_MOCK_PORT:-8000}" "curl -fs -o /dev/null -X POST http://127.0.0.1:${VERIFY_MOCK_PORT:-8000}/v1/messages -d '{}'"
[ "$ok" = 1 ] && echo "usable" || { echo "not usable"; exit 1; }
