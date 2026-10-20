#!/bin/bash
set -euo pipefail
PORT=${1:?usage: sdk-message-filters-door.sh <port> <run-dir>}
RUN=${2:?usage: sdk-message-filters-door.sh <port> <run-dir>}
[ "$PORT" != 8399 ] || { echo 'refusing live daemon port'; exit 1; }
cd "$(dirname "$0")/../../.."
env -i HOME="$RUN/home" PATH="$(dirname "$(command -v bun)"):/usr/bin:/bin" NODE_ENV=test VERIFY_PORT="$PORT" \
  bun .claude/skills/verify/rpc.ts rpc:session.messages.byStatus \
  '{"sessionId":"synthetic-filters","status":"consumed","limit":20}' > "$RUN/evidence/rpc-consumed.json"
bun - "$RUN" <<'TS' > "$RUN/evidence/rpc-comparison.json"
const run = process.argv[2];
const reference = await Bun.file(`${run}/evidence/after.json`).json();
const consumed = (await Bun.file(`${run}/evidence/rpc-consumed.json`).json()).reply;
const expected = reference.receipts.status;
if (consumed.total !== expected.total || consumed.messages.length !== 20)
  throw new Error('Public status count/window differs from the repository receipt');
for (const [index, row] of consumed.messages.entries()) {
  const before = expected.messages[index];
  if (row.dbId !== before.dbId || row.uuid !== before.uuid || row.timestamp !== before.timestamp || row.text !== before.message.content)
    throw new Error('Public message ordering/content differs from the repository receipt');
}
console.log(JSON.stringify({total: consumed.total, window: consumed.messages.length, first: consumed.messages[0].dbId, consumedMatchesBaselineReceipt: true}));
TS
cat "$RUN/evidence/rpc-comparison.json"
