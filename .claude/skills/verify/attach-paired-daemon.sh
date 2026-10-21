#!/bin/bash
# S5 of docs/design/daemon-security.md: daemon A attaches to daemon B with a pairing code
# made on B, then B lists and revokes it. Usage: attach-paired-daemon.sh <portA> <portB>
# (never 8399). Codes and credentials stay in shell variables and are never printed.
set -euo pipefail
PA=${1:?usage: attach-paired-daemon.sh <portA> <portB>}
PB=${2:?usage: attach-paired-daemon.sh <portA> <portB>}
for P in "$PA" "$PB"; do
  [ "$P" = 8399 ] && { echo "refusing 8399"; exit 1; }
  lsof -nP -iTCP:"$P" -sTCP:LISTEN >/dev/null 2>&1 && { echo "port $P is busy"; exit 1; }
done
ROOT=$(cd "$(dirname "$0")/../../.." && pwd)
RUN=$(mktemp -d "${TMPDIR:-/tmp}/attach-paired.XXXXXX")
cd "$ROOT"
start() {
  mkdir -p "$RUN/$1/home" "$RUN/$1/data"
  env -i HOME="$RUN/$1/home" PATH="$(dirname "$(command -v bun)"):/usr/bin:/bin:/usr/sbin" \
    TMPDIR="${TMPDIR:-/tmp}" NODE_ENV=test HYPERNEO_DATA_DIR="$RUN/$1/data" \
    bun run packages/cli/main.ts --port "$2" --host 127.0.0.1 --db-path "$RUN/$1/data/daemon.db" \
    < /dev/null > "$RUN/$1/daemon.log" 2>&1 &
  echo $!
}
PIDA=$(start a "$PA")
PIDB=$(start b "$PB")
trap 'kill $PIDA $PIDB 2>/dev/null || true' EXIT
for P in "$PA" "$PB"; do for _ in $(seq 1 120); do curl -fs -o /dev/null "http://127.0.0.1:$P/" && break; sleep 1; done; done
for D in a b; do for _ in $(seq 1 30); do [ -S "$RUN/$D/data/session-door.sock" ] && break; sleep 1; done; done
cli_b() {
  env -i HOME="$RUN/b/home" PATH="$(dirname "$(command -v bun)"):/usr/bin:/bin:/usr/sbin" \
    TMPDIR="${TMPDIR:-/tmp}" NODE_ENV=test HYPERNEO_DATA_DIR="$RUN/b/data" \
    HYPERNEO_SESSION_DOOR="$RUN/b/data/session-door.sock" bun run packages/cli/main.ts "$@"
}
field() { python3 -c "import json,sys;print(json.load(sys.stdin)$1)"; }
on_a() { VERIFY_PORT="$PA" bun .claude/skills/verify/rpc.ts "$@"; }
send_to_b() { on_a message.send '{"to":"daemon:b::session:no-such-session","text":"hello from a"}' | field "['reply'].get('reason', 'no reason')" | cut -c1-70; }

CODE=$(cli_b pair --kind daemon --name ignored | field "['code']")
ATTACH_B=$(printf '{"daemonId":"b","url":"ws://127.0.0.1:%s/ws","code":"%s"}' "$PB" "$CODE")
ATTACH_WRONG=$(printf '{"daemonId":"c","url":"ws://127.0.0.1:%s/ws","code":"AAAAAAAAAA"}' "$PB")
echo "attach with B's code: $(on_a daemon.attach "$ATTACH_B" | field "['reply']['kind']")"
echo "attach with a wrong code: $(on_a daemon.attach "$ATTACH_WRONG" | field "['reply']['reason']")"
echo "forward to B: $(send_to_b)"
DEVICES=$(cli_b devices)
DEVICE=$(echo "$DEVICES" | field "['devices'][0]['id']")
echo "B's devices: $(echo "$DEVICES" | python3 -c "import json,sys;print([(d['name'],d['kind'],d['lastSeenHost'] is not None,d['revokedAt']) for d in json.load(sys.stdin)['devices']])")"
CRED=$(sqlite3 -readonly "$RUN/a/data/daemon.db" "SELECT credential FROM remote_daemon_secrets WHERE daemon_id = 'b'")
echo "A stores one secret: $(sqlite3 -readonly "$RUN/a/data/daemon.db" "SELECT COUNT(*) FROM remote_daemon_secrets")"
SETTINGS=$(sqlite3 -readonly "$RUN/a/data/daemon.db" "SELECT settings FROM global_settings")
echo "A's settings list the attachment: $(echo "$SETTINGS" | python3 -c "import json,sys;print([d['daemonId'] for d in json.load(sys.stdin)['attachedDaemons']])")"
echo "credential in A's daemon.list, settings or logs, or B's log: $( (on_a daemon.list; echo "$SETTINGS"; cat "$RUN/a/daemon.log" "$RUN/b/daemon.log") | grep -c "$CRED" || true)"
echo "revoke on B: $(cli_b devices revoke "$DEVICE" | field "['ok']")"
sleep 1
echo "forward after revoke: $(send_to_b)"
echo "A still reaches B after revoke, counted unpaired: $(sqlite3 -readonly "$RUN/b/data/daemon.db" "SELECT client || ' rejected=' || credential_rejected FROM unpaired_connections WHERE credential_rejected = 1")"
echo "B's human code after revoking its only device: $(cli_b pair --kind human | field "['reason']" | cut -c1-16)"
echo "run dir: $RUN"
