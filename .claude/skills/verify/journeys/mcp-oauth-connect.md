# Connect a remote MCP OAuth registry row

Run the isolated daemon RPC proof with the loopback fixture:

```bash
bash .claude/skills/verify/proof-run.sh /absolute/evidence/mcp-oauth-connect \
  .claude/skills/verify/mcp-oauth-connect.ts "$(git rev-parse HEAD)"
```

Use a fresh evidence directory and leave loopback port 18347 free for the test
preset. The proof creates a server through the registry RPC, starts consent
as a human using `operation.invoke`, and drives the fake consent URL through
the real callback socket. The agent caller and a row with another endpoint
are refused. The listener rejects a wrong state before exchanging the code
and refuses a replay while the valid exchange is in flight. The status RPC
returns only health and granted scopes, including after daemon restart.

Require exit 0 and `pass: true` in `mcp-oauth-connect.json`. The evidence
holds verdicts and scopes. This journey uses neither a vendor nor the web UI.

To exercise the human reconnect and disconnect operations, run the same helper
with the lifecycle argument and a fresh evidence directory:

```bash
bash .claude/skills/verify/proof-run.sh /absolute/evidence/mcp-oauth-lifecycle \
  .claude/skills/verify/mcp-oauth-connect.ts "$(git rev-parse HEAD)" lifecycle
```

The proof keeps the old grant during consent, cancels a reconnect, and replaces
the grant on a successful reconnect without refreshing. It disconnects while a
code reply is held and checks that the grant is erased and the late reply fails.
SQLite triggers in the disposable DB simulate failed erase and an interruption
between the bundle write and activation. After restarts, status must show
disconnected and reconnect needed respectively. Require exit 0 and
`pass: true` in `mcp-oauth-lifecycle.json`.

To exercise registry URL replacement against the same daemon and
fixture, run:

```bash
bash .claude/skills/verify/proof-run.sh /absolute/evidence/mcp-oauth-row-writes \
  .claude/skills/verify/mcp-oauth-connect.ts "$(git rev-parse HEAD)" row-writes
```

On the base, expect exit 1 when the registry refuses a URL replacement.
On the fixed head, require exit 0 and `pass: true` in `mcp-oauth-row-writes.json`.
A conflicting rename in the same request leaves the URL and grant intact.
The replacement operation refuses an agent caller. A human URL replacement
aborts a held consent callback, erases the grant and stays disconnected after
restart. The new endpoint receives no request.

To exercise daemon-held refresh with the real MCP SDK and the isolated registry:

```bash
bash .claude/skills/verify/proof-run.sh /absolute/evidence/mcp-oauth-refresh \
  .claude/skills/verify/mcp-oauth-connect.ts "$(git rev-parse HEAD)" refresh
```

Require exit 0 and `pass: true` in `mcp-oauth-refresh.json`. The proof uses
the internal refresh entry point for the future session transport and reads
health through the real status RPC. Concurrent callers share one token request.
Transient replies keep the grant and report a bounded reason without retrying
for one minute. Slack's pre-registered client path classifies a revoked grant
without retry or consent. Disconnect fences a held refresh. An erase failure
leaves the rejected bundle unadmitted after restart.
