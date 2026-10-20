#!/bin/bash
set -euo pipefail
PORT=${1:?usage: sdk-runtime-filters-door.sh <port> <run-dir>}
RUN=${2:?usage: sdk-runtime-filters-door.sh <port> <run-dir>}
[ "$PORT" != 8399 ] || { echo 'refusing live daemon port'; exit 1; }
cd "$(dirname "$0")/../../.."
env -i HOME="$RUN/home" PATH="$(dirname "$(command -v bun)"):/usr/bin:/bin" NODE_ENV=test VERIFY_PORT="$PORT" \
  bun .claude/skills/verify/rpc.ts work.status \
  '{"ref":{"adapter":"hyperneo","id":"synthetic-runtime"},"since":59999000,"receipt":{"executionId":"synthetic-runtime","inputId":"last-human"}}' > "$RUN/evidence/rpc-status.json"
bun - "$RUN" <<'TS' > "$RUN/evidence/rpc-status-comparison.json"
import { deepStrictEqual, strictEqual } from 'node:assert';
const run = process.argv[2];
const baseline = (await Bun.file(`${run}/evidence/before.json`).json()).receipts;
const result = (await Bun.file(`${run}/evidence/rpc-status.json`).json()).reply;
strictEqual(result.ok, true);
strictEqual(result.value.lastReply, baseline.lastResult.reply);
deepStrictEqual(result.value.recentInputs, baseline.inputsSince);
deepStrictEqual(result.value.exchange, baseline.exchange.entries);
strictEqual(result.value.exchangeCut ?? false, baseline.exchange.exchangeCut ?? false);
deepStrictEqual(result.value.inputEvidence, baseline.evidence);
console.log(JSON.stringify({ matchesBaseline: true, lastReply: result.value.lastReply, inputEvidence: result.value.inputEvidence }));
TS
cat "$RUN/evidence/rpc-status-comparison.json"
