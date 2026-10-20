#!/bin/bash
# Usage: daemon-embed-lag.sh <checkout | compiled hyperneod binary> <port>
# Starts an isolated test daemon from <checkout> (or the binary) on a fresh data dir, seeds synthetic turns,
# queues one work.turns.embed run, and reports the slowest HTTP reply while the job runs.
set -euo pipefail
CHECKOUT=${1:?checkout}
PORT=${2:?port}
[ "$PORT" = 8399 ] && { echo "refusing 8399"; exit 1; }
lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1 && { echo "port $PORT is busy"; exit 1; }
RUN=$(mktemp -d "${TMPDIR:-/tmp}/embed-lag.XXXXXX")
mkdir -p "$RUN/home" "$RUN/data"
if [ -f "$CHECKOUT" ] && [ -x "$CHECKOUT" ]; then DAEMON=("$CHECKOUT"); else cd "$CHECKOUT"; DAEMON=(bun run packages/cli/main.ts); fi
env -i HOME="$RUN/home" PATH="$(dirname "$(command -v bun)"):/usr/bin:/bin:/usr/sbin" TMPDIR="${TMPDIR:-/tmp}" \
  NODE_ENV=test HYPERNEO_DATA_DIR="$RUN/data" \
  "${DAEMON[@]}" --port "$PORT" --host 127.0.0.1 --db-path "$RUN/data/daemon.db" \
  < /dev/null > "$RUN/daemon.log" 2>&1 &
PID=$!
trap 'kill $PID 2>/dev/null || true' EXIT
for _ in $(seq 1 120); do curl -fs -o /dev/null "http://127.0.0.1:$PORT/" && break; sleep 1; done
python3 - "$RUN/data/daemon.db" "$PORT" <<'PY'
import sqlite3, sys, time, urllib.request
db_path, port = sys.argv[1], sys.argv[2]
db = sqlite3.connect(db_path)
words = 'the build failed because the migration renamed a column that the task feed still reads so the worker reverted it and reran the shard '.split()
for i in range(64):
    body, j = '', 0
    while len(body) < 3000:
        body += words[j % len(words)] + ' '; j += 1
    db.execute("INSERT INTO message_search_content (kind, source_id, session_id, message_type, title, body, timestamp) VALUES ('message', ?, 'synthetic', 'assistant', '', ?, ?)", (f'm{i}', body, 1792000000000 + i))
now = int(time.time() * 1000)
db.execute("INSERT INTO job_queue (id, queue, status, payload, priority, max_retries, retry_count, run_at, created_at) VALUES ('embed-lag', 'work.turns.embed', 'pending', '{\"scope\":\"turns\"}', 0, 0, 0, ?, ?)", (now, now))
db.commit()
worst, started = 0.0, time.time()
while time.time() - started < 300:
    t = time.time()
    urllib.request.urlopen(f'http://127.0.0.1:{port}/', timeout=60).read()
    worst = max(worst, time.time() - t)
    status = db.execute("SELECT status FROM job_queue WHERE id = 'embed-lag'").fetchone()[0]
    if status in ('completed', 'failed', 'dead'): break
    time.sleep(0.05)
vectors = db.execute('SELECT count(*) FROM message_search_vectors').fetchone()[0]
print(f'job {status} in {time.time() - started:.1f} s, {vectors} vectors, slowest HTTP reply {worst * 1000:.0f} ms')
PY
