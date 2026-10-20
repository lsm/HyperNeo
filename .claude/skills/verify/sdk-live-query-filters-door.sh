#!/bin/bash
set -euo pipefail
PORT=${1:?usage: sdk-live-query-filters-door.sh <port> <run-dir>}
RUN=${2:?usage: sdk-live-query-filters-door.sh <port> <run-dir>}
[ "$PORT" != 8399 ] || { echo 'refusing live daemon port'; exit 1; }
cd "$(dirname "$0")/../../.."
for query in messages.bySession messages.bySession.compact spaceTaskMessages.byTask spaceTaskActiveTurn.byTask; do
  if [[ "$query" == messages.* ]]; then params='["synthetic-live",200]'; else params='["proof-task"]'; fi
  env -i HOME="$RUN/home" PATH="$(dirname "$(command -v bun)"):/usr/bin:/bin" NODE_ENV=test VERIFY_PORT="$PORT" \
    bun .claude/skills/verify/rpc.ts rpc:liveQuery.subscribe \
    "{\"queryName\":\"$query\",\"subscriptionId\":\"live-filter-proof\",\"params\":$params}" > "$RUN/evidence/rpc-$query.json"
done
bun - "$RUN" <<'TS' > "$RUN/evidence/rpc-feed-comparison.json"
import { deepStrictEqual, ok } from 'node:assert';
import { mapMessageRow, mapThinMessageRow } from './packages/daemon/src/lib/live-query/queries/messages.ts';
const run = process.argv[2];
const before = (await Bun.file(`${run}/evidence/before.json`).json()).receipts;
const result = {};
for (const [name, key] of [['messages.bySession','full'],['messages.bySession.compact','compact'],['spaceTaskMessages.byTask','task'],['spaceTaskActiveTurn.byTask','activeTurn']]) {
  const reply = await Bun.file(`${run}/evidence/rpc-${name}.json`).json();
  ok(reply.reply.ok, `Subscription rejected: ${name}`);
  const snapshot = reply.events?.find((event) => event.method === 'liveQuery.snapshot')?.data;
  ok(snapshot, `Missing snapshot: ${name}`);
  deepStrictEqual(snapshot.rows, before[key]);
  if (name.startsWith('messages.'))
    deepStrictEqual(snapshot.metadata.backgroundTaskMessages, JSON.parse(JSON.stringify(before.sidecar.map(name.endsWith('.compact') ? mapThinMessageRow : mapMessageRow).reverse())));
  result[name] = { matchesBaseline: true, rows: snapshot.rows.length, ids: snapshot.rows.map((row) => row.id) };
}
console.log(JSON.stringify(result));
TS
cat "$RUN/evidence/rpc-feed-comparison.json"
