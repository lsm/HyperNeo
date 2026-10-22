# A revoked Claude login recovers once or visibly needs the human

Use **In-process RPC proofs** in ../SKILL.md. Preflight ports 8000/8001.
Build packages/web first. Run each case with a different fresh RUN/home:

```sh
env -i HOME="$RUN/home" PATH="$PATH" NODE_ENV=test HYPERNEO_USE_DEV_PROXY=1 \
  HYPERNEO_DATA_DIR="$RUN/data" LOG_LEVEL=warn \
  bun .claude/skills/verify/claude-login-retry.ts "$RUN" recover
```

The helper owns its daemon, local HTTP proxy and mock model. It disables external
MCP entries and stores only the synthetic dev-proxy provider key in its fresh DB.
No auth file, real credential, live daemon/DB or port 8399 is accessed. SDK spawn
instrumentation records PIDs only; no environment values or headers are recorded.
All resources close in finally, including the optional web server.

The fake endpoint rejects the first SDK process with 401 authentication_error /
OAuth token revoked. It accepts the replacement process with the ordinary mock
200 response. This models credentials cached inside the stale SDK; Claude's own
probe/retry requests can make multiple HTTP calls per process. Assert exactly
two subprocesses, replayed original prompt, successful result and no terminal
notice. Before the fix, one SDK process repeatedly receives 401 and the proof
fails. `observed.json` records requests, response statuses/process number, PIDs
and synthetic SDK messages. Credentials and file contents are never inspected.

For persistent failure run with `fail --serve`. Both SDK processes get 401; after
the second rejection the exact user notice must be emitted and no third process
starts. The helper writes its ephemeral UI port and sessionId to observed.json,
then waits up to five minutes for browser-done. The web listener serves the actual
production build, using resolveNeoEntry for /neo and real daemon WebSocket handlers.
It does not substitute frontend responses or inject an error event.

In persistent headless Playwright import `claude-login-web.mjs` and call
`verifyClaudeLogin(page, run)`. The browser checks the actual /neo and /session
at 1280 and 390, including reload, the login notice, Neo's needs you status and
no horizontal overflow. Inspect all four screenshots independently. The helper
writes browser.json and browser-done, allowing daemon/mock/server cleanup.

Use the existing SDK result/handler contracts for subtype success + is_error:
error styling, no success turn trigger and no errorClear. Retry routing contracts
also protect interruption and other-provider isolation. No actual OAuth rotation,
credential refresh, external login or deployed-daemon mutation is claimed; the
SDK owns authentication discovery in its newly started process.
