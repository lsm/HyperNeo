# Fresh focused discussion: route, prepare, then open one card

Read the shared verify isolation rules. Build web first. Pick a fresh RUN, preflight
8000 for the owned loopback model (never stop another process), and run:

```bash
cd packages/web && bun run build && cd ../..
RUN=$(mktemp -d /private/tmp/hn-focused-discussion-XXXXXX)
mkdir -p "$RUN/home" "$RUN/bin"
env -i HOME="$RUN/home" PATH="$RUN/bin:$(dirname "$(command -v bun)"):/usr/bin:/bin:/usr/sbin" \
  NODE_ENV=test HYPERNEO_USE_DEV_PROXY=1 HYPERNEO_DATA_DIR="$RUN/data" LOG_LEVEL=warn \
  NODE_PATH=<directory containing playwright> VERIFY_NODE=<node executable> \
  VERIFY_BROWSER=<headless Chromium executable> \
  bun .claude/skills/verify/focused-discussion.ts "$RUN"
```

The helper owns a real daemon/web server on ephemeral non-8399 ports, a loopback
model on 8000 and its headless browser. Only synthetic data and a test key stored
through the provider RPC are used. External MCP registry servers are disabled;
GitHub/app-launch commands refuse. All resources close in finally.

The actual root stores the focused-session guidance. The scripted Neo caller
uses its real MCP door to discover a place and track a fresh HyperNeo session
through neo.todo.add target:start, reaching the existing work.start/handoff.
The human explicitly prefers HyperNeo; no routing question is needed. The actual
SDK request must retain the human's words, linked brief and prior decision. A
model-response barrier proves session creation produces no ready card. Only after
the SDK's prepared reply is readable does Neo post one ordinary reply question
with the worker sourceSession. At 1440px/390px its Open session control enters
the correct session pane with the prepared reply; Back preserves Reply in chat.

Retain observed.json, web.json, screenshots, model requests and cleanup.json.
Run neo-prompt and neo-goal-cycle-prompt contracts plus work-todo-reference and
existing handoff/driver contracts, then bun run check. The core root stays under
260 words; focused guidance is composed separately. This is a scripted routing
and loopback-model proof, not a real model-choice evaluation or native Desktop
acceptance test. The prompt always offers the multi-provider HyperNeo session
alongside available Claude Code in Desktop or Codex Desktop, uses the human's
preference and leaves ordinary bounded delegation intact. No new operation,
schema, persistent ask link (#8410) or outcome integration (#8411) is added.
