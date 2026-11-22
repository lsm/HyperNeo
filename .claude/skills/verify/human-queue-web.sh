#!/bin/bash
set -euo pipefail
: "${RUN:?run through with-run.sh}"
PORT=${1:?supply a free verification port}
PHASE=${2:?supply a phase from the human-queue-web journey}
EVIDENCE=${3:?supply an absolute evidence directory}
export HYPERNEO_DATA_DIR="$RUN/data" VERIFY_PORT="$PORT"
trap 'bash .claude/skills/verify/stop.sh "$RUN"; test ! -f "$RUN/daemon.log" || cp "$RUN/daemon.log" "$RUN/evidence/"; cp -R "$RUN/evidence/." "$EVIDENCE/"' EXIT
mkdir -p "$RUN/home" "$RUN/evidence" "$EVIDENCE"
env -i HOME="$RUN/home" PATH="$PATH" NODE_ENV=test bun .claude/skills/verify/human-queue-web-seed.ts "$RUN" "$PHASE"
bash .claude/skills/verify/launch.sh "$PORT" "$RUN"
bash .claude/skills/verify/doctor.sh "$PORT" "$RUN" | tee "$RUN/evidence/doctor.txt"
if [[ "$PHASE" == short-topics ]]; then
  bun .claude/skills/verify/rpc.ts neo.snapshot '{"projectId":"payments"}' > "$RUN/scoped.json"
  node - "$RUN/scoped.json" <<'NODE' > "$RUN/evidence/scoped-topics.json"
const assert = require('node:assert/strict');
const { reply } = require(process.argv[2]);
const listed = reply.todoAsks.map(({ ask }) => ask.id);
const { topics } = reply.humanQueue;
assert.deepEqual(listed, ['pay-primary']);
assert.equal(topics['pay-primary'].topicKey, 'payments');
assert.equal(topics['pay-sender'].topicKey, 'payments');
console.log(JSON.stringify({ listed, queueTopics: topics }, null, 2));
NODE
fi
node .claude/skills/verify/human-queue-web.mjs "$PORT" "$RUN" "$PHASE"
if [[ "$PHASE" == short-topics ]]; then
  sqlite3 -readonly "$RUN/data/daemon.db" "SELECT topic FROM neo_asks WHERE id = 'legacy'; SELECT title FROM neo_concerns WHERE id = 'payments';" |
    tee "$RUN/evidence/stored-topics.txt"
  [[ $(cat "$RUN/evidence/stored-topics.txt") == $'甲乙丙丁戊己A\nPayments' ]]
fi
