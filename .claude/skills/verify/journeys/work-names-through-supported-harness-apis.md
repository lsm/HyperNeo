## Work names through supported harness APIs

```bash
RUN=$(mktemp -d /private/tmp/hn-rename-proof-XXXXXX)
env -i HOME="$RUN/home" PATH="$PATH" NODE_ENV=test HYPERNEO_DATA_DIR="$RUN/data" \
  LOG_LEVEL=warn bun .claude/skills/verify/work-rename.ts verify 9385 "$RUN"
```

The helper boots a fresh isolated daemon with a synthetic Codex app-server Unix
socket and synthetic thread DB under its temporary HOME. `operations.describe`
must expose `work.rename`. Neo's real MCP adapter and WebSocket RPC rename only
the synthetic thread via `thread/name/set`; the fixture owns its synthetic DB
update and emits `thread/name/updated`. Subsequent `work.status` sees the name
without restarting. Synthetic HyperNeo, Space task and Space agent renames go
through the existing session lifecycle, task.update and agent.update APIs; the
session title is marked user-set to prevent automatic title replacement. A
synthetic Claude Desktop installation returns not_supported. Invalid multiline
titles must not reach Codex. RPC responses and peer calls are retained in
`evidence/observed.json`. On the reproduction commit, use `reproduce` instead:
it must show discovery has no rename operation. All owned servers and daemon
stop in finally. No human threads, real credentials, provider/model, private app
writes or port 8399 are involved. This proves daemon/MCP and protocol behavior;
actual Codex Desktop GUI rendering is not exercised.
