# Reopen a focused discussion after its preparation card is retired

Read shared isolation rules. Build web, pick a fresh RUN, and run this proof. Preflight port 8000 for its owned loopback model; never stop another
process. The daemon and web server use ephemeral ports:

```bash
cd packages/web && bun run build && cd ../..
RUN=$(mktemp -d /private/tmp/hn-focused-ask-XXXXXX)
mkdir -p "$RUN/home" "$RUN/bin"
env -i HOME="$RUN/home" PATH="$RUN/bin:$(dirname "$(command -v bun)"):/usr/bin:/bin:/usr/sbin" \
  NODE_ENV=test ${VERIFY_MOCK_PORT:+VERIFY_MOCK_PORT=$VERIFY_MOCK_PORT} HYPERNEO_USE_DEV_PROXY=1 HYPERNEO_DATA_DIR="$RUN/data" LOG_LEVEL=warn \
  NODE_PATH=<directory containing playwright> VERIFY_NODE=<node executable> \
  VERIFY_BROWSER=<headless Chromium executable> \
  bun .claude/skills/verify/focused-ask-session.ts "$RUN"
```

Only a synthetic dev-proxy key is registered through the provider RPC into the
test DB. External MCP servers and app launchers are disabled.

The real daemon MCP door records a synthetic ask and a readable HyperNeo source.
An ordinary source card must not bind the ask. A prepared card with focused:true
must save ask.focusedSession; a missing source is refused. After retiring all
questions and restarting only this test daemon, neo.snapshot retains the captured
session identity, provider and safe opener on the ask, with no question present.
Headless 1440px/390px checks reopen the correct session through the existing opener
and return to the ask. Retain screenshots, observed.json, web.json and receipts.

A synthetic tracked dispatch and work.status turn end exercise the actual daemon
refresh job and relay delivery into Neo's stored input. Its report names ask, todo
and dispatch, keeps the final message verbatim and explicitly says status only:
do not act, reply, forward or treat it as approval. Ask and todo results stay open
and unchanged. This proves the relay envelope, not spontaneous model compliance.
It does not drive native Desktop or add outcome integration (#8411).

Run neo-questions, neo-todo-runner, neo-ask-record, neo-ask-entries, neo-reply-to and
neo-prompt unit contracts, NeoAskTodos web contracts, and bun run check. The helper
owns and closes its daemons, server and browser in finally; keep cleanup.json.
