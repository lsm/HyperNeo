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
if (!reply?.found || !reply.description.includes(`choice: 1-6 options, multiple for pick-any. Each option is an action the human can take; one option confirms that action. A card left open is undecided, so no option may mean later or not now. The card labels them A, B, C… in order and the human may answer by letter, so keep letters out of the option text by default. When the text names approaches by letter, pass labels with one distinct uppercase letter A–F per option, matching those names. ${guidance}`)) {
  console.error("FAIL: discovered neo.question.ask does not explain option letters and the built-in chat reply after choice.");
  process.exit(1);
}
console.log(`PASS: discovered neo.question.ask: ${reply.description}`);
' "$RUN/evidence/question-description.json"
