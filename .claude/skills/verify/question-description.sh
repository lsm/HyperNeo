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
if (!reply?.found) throw new Error("neo.question.ask is missing from discovery");
for (const phrase of [
  "one option confirms",
  "multiple enables pick-any",
  "accepts replies by number",
  "Use Reply in chat for free text",
  "omit catch-all and defer options",
]) {
  if (!reply.description.includes(phrase)) throw new Error(`Missing choice guidance: ${phrase}`);
}
console.log("PASS: numbered choices, confirmation and built-in chat reply");
' "$RUN/evidence/question-description.json"
