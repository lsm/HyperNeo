#!/bin/bash
set -euo pipefail
EVIDENCE=${1:?usage: mock-port-launch.sh <absolute-fresh-evidence-directory>}
[[ "$EVIDENCE" = /* ]] || exit 2
: "${RUN:?use with-run.sh to own a fresh run directory}"
bash .claude/skills/verify/resource-check.sh
mkdir "$EVIDENCE"
finish() {
  RESULT=$?
  trap - EXIT
  bash .claude/skills/verify/stop.sh "$RUN" > "$EVIDENCE/stop.log" 2>&1 || RESULT=1
  for log in launch.log doctor.log daemon.log mock-api.log; do
    [ ! -f "$RUN/$log" ] || cp "$RUN/$log" "$EVIDENCE/$log"
  done
  printf '{"exitCode":%s}\n' "$RESULT" > "$EVIDENCE/run-status.json"
  exit "$RESULT"
}
trap finish EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
PORTS=$(bun -e 'const servers=[Bun.serve({hostname:"127.0.0.1",port:0,fetch:()=>new Response()}),Bun.serve({hostname:"127.0.0.1",port:0,fetch:()=>new Response()})]; console.log(servers.map(s=>s.port).join(" ")); for(const server of servers) server.stop(true);')
read -r DAEMON_PORT MOCK_PORT <<< "$PORTS"
export VERIFY_MOCK_PORT=$MOCK_PORT
VERIFY_NORMAL_PRIORITY=1 bash .claude/skills/verify/launch.sh "$DAEMON_PORT" "$RUN" > "$RUN/launch.log" 2>&1
printf '{"daemonPort":%s,"mockPort":%s}\n' "$DAEMON_PORT" "$MOCK_PORT" > "$EVIDENCE/ports.json"
env -i HOME="$RUN/home" PATH="$PATH" NODE_ENV=test VERIFY_MOCK_PORT="$MOCK_PORT" \
  bash .claude/skills/verify/doctor.sh "$DAEMON_PORT" "$RUN" > "$RUN/doctor.log" 2>&1
cat "$RUN/doctor.log"
