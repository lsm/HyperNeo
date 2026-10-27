# Record a settled focused discussion and keep tracking execution

Use shared isolation setup and the focused-ask-session journey. Build web first,
preflight port 8000 for the owned loopback model, then run the same helper in
outcome mode with a fresh RUN:

```bash
RUN=$(mktemp -d /private/tmp/hn-focused-outcome-XXXXXX)
mkdir -p "$RUN/home" "$RUN/bin"
env -i HOME="$RUN/home" PATH="$RUN/bin:$(dirname "$(command -v bun)"):/usr/bin:/bin:/usr/sbin" \
  NODE_ENV=test ${VERIFY_MOCK_PORT:+VERIFY_MOCK_PORT=$VERIFY_MOCK_PORT} HYPERNEO_USE_DEV_PROXY=1 HYPERNEO_DATA_DIR="$RUN/data" LOG_LEVEL=warn \
  NODE_PATH=<directory containing playwright> VERIFY_NODE=<node executable> \
  VERIFY_BROWSER=<headless Chromium executable> \
  bun .claude/skills/verify/focused-ask-session.ts "$RUN" outcome
```

All state is synthetic; the provider key is registered through RPC into the test
DB, GitHub PR reads use a stub and app launchers refuse. The existing proof first
shows a normal focused turn relayed as status only without recording an outcome.
In outcome mode, the worker's MCP door must refuse neo.ask.outcome. Its explicit
settled report instead reaches Neo through message.send and the real mailbox.
That report alone must not record or close the ask. The scripted owning Neo then
calls neo.ask.outcome with the decision, document and PR links, and adds an
execution todo with the existing coding PR check. Leave the ask open: recording
the discussion outcome does not settle its execution. Explicit settlement is
covered by ask-bookkeeping-actions.md, where unfinished todos close unverified.
Restart the test daemon and assert the same
outcome, source link, open ask and pending execution remain in neo.snapshot.

Headless 1440px/390px screenshots show the outcome's working Markdown links in
Details and the incomplete execution row. The header retains session context without a duplicate opener. Question and
per-todo navigation remain covered by neo-open-controls.md in both themes. Retain observed.json, web.json,
screenshots, receipts.json and cleanup.json. The helper closes its own daemon,
model, browser and server in finally.

This scripts the explicit settled report and Neo's recording choice; it does not
claim a spontaneous model correctly judges human settlement. Native Desktop is
not driven. Run neo-ask-record, neo-prompt, neo, neo-todo-runner, neo-questions and
neo-ask-entries contracts, NeoAskTodos web tests, and bun run check.
