#!/bin/bash
set -euo pipefail
PORT=${1:?usage: sdk-message-columns-door.sh <port> <run-dir> [evidence-name]}
RUN=${2:?usage: sdk-message-columns-door.sh <port> <run-dir> [evidence-name]}
NAME=${3:-columns-door}
cd "$(dirname "$0")/../../.."
rpc() {
  env -i HOME="$RUN/home" PATH="$(dirname "$(command -v bun)"):/usr/bin:/bin" \
    NODE_ENV=test VERIFY_PORT="$PORT" bun .claude/skills/verify/rpc.ts "$@"
}
rpc rpc:providers.create '{"params":{"providerId":"anthropic","displayName":"Anthropic (dev proxy)","kind":"built_in","authType":"api_key","isEnabled":true,"isDefault":true,"sortOrder":0},"credentials":{"apiKey":"sk-devproxy-test-key"}}' > "$RUN/evidence/$NAME-provider.json"
CREATE=$(bun -e 'console.log(JSON.stringify({workspacePath:process.argv[1],title:"Derived columns verification"}))' "$RUN")
rpc rpc:session.create "$CREATE" > "$RUN/evidence/$NAME-session.json"
SID=$(bun -e 'console.log(JSON.parse(await Bun.file(process.argv[1]).text()).reply.sessionId)' "$RUN/evidence/$NAME-session.json")
SEND=$(bun -e 'console.log(JSON.stringify({sessionId:process.argv[1],from:`session:${process.argv[1]}`,message:{type:"user",message:{content:"sdk-message-columns-token"},parent_tool_use_id:null}}))' "$SID")
rpc message.send "$SEND" > "$RUN/evidence/$NAME-send.json"
FEED=$(bun -e 'console.log(JSON.stringify({queryName:"messages.bySession",subscriptionId:"columns-proof",params:[process.argv[1],50]}))' "$SID")
rpc rpc:liveQuery.subscribe "$FEED" 2 > "$RUN/evidence/$NAME-feed.json"
env -i HOME="$RUN/home" PATH="$(dirname "$(command -v bun)"):/usr/bin:/bin" NODE_ENV=test \
  bun - "$RUN" "$NAME" <<'TS' > "$RUN/evidence/$NAME-result.json"
import { Database } from './packages/daemon/src/storage/sqlite-compat.ts';
const [run, name] = process.argv.slice(2);
const send = await Bun.file(`${run}/evidence/${name}-send.json`).json();
if (send.reply.kind !== 'accepted') throw new Error('Message rejected');
const feed = await Bun.file(`${run}/evidence/${name}-feed.json`).json();
const rows = feed.events.flatMap((event) => event.data.rows ?? event.data.added ?? []);
const user = rows.find((row) => row.uuid === send.reply.messageId);
if (!user || !JSON.stringify(user.message.content).includes('sdk-message-columns-token'))
  throw new Error('Message not visible in the web transcript subscription');
const db = new Database(`${run}/data/daemon.db`, { readonly: true });
try {
  const stored = db.prepare('SELECT input_kind,is_synthetic,has_tool_result,tool_result_only,sdk_message FROM sdk_messages WHERE id = ?').get(user.id);
  if (stored.input_kind !== 'task' || stored.is_synthetic !== 1 || stored.has_tool_result !== 0 || stored.tool_result_only !== 0)
    throw new Error('Stored metadata disagrees with the public transcript');
  const body = JSON.parse(stored.sdk_message);
  if (body.uuid !== user.uuid || JSON.stringify(body.message) !== JSON.stringify(user.message))
    throw new Error('Stored body differs from the public transcript');
  console.log(JSON.stringify({accepted: true, visibleInTranscript: true, metadataMatches: true, id: user.id, inputKind: body.inputKind}));
} finally {
  db.close();
}
TS
cat "$RUN/evidence/$NAME-result.json"
