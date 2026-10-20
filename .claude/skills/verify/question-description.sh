#!/bin/bash
set -euo pipefail
RUN=${1:?usage: VERIFY_PORT=<isolated-port> bash question-description.sh <run-dir>}
: "${VERIFY_PORT:?set VERIFY_PORT to the isolated daemon port}"
[ "$VERIFY_PORT" != 8399 ] || { echo 'refusing 8399'; exit 1; }
mkdir -p "$RUN/evidence"
bun "$(dirname "$0")/rpc.ts" operations.describe '{"name":"neo.question.ask"}' \
  > "$RUN/evidence/question-description.json"
bun -e '
const { reply } = await Bun.file(process.argv[1]).json();
const guidance = `Every card also has Reply in chat, where the human can answer in their own words, so never add an "other" or "something else" option.`;
if (!reply?.found || !reply.description.includes(`choice: 2-6 options, multiple for pick-any. ${guidance}`)) {
  console.error("FAIL: discovered neo.question.ask does not explain the built-in chat reply after yesno/choice.");
  process.exit(1);
}
console.log(`PASS: discovered neo.question.ask: ${reply.description}`);
' "$RUN/evidence/question-description.json"
