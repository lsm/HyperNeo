# Remote MCP OAuth row client

Run with the fixed test preset's loopback port 18347 free.

```bash
bash .claude/skills/verify/proof-run.sh /absolute/evidence/mcp-oauth-row-client \
  .claude/skills/verify/mcp-oauth-row-client.ts "$(git rev-parse HEAD)"
```

An isolated daemon connects to the loopback MCP fixture through real OAuth
and exercises the daemon's SDK client before session wiring. Concurrent lists
share one initialization. Three expired calls share one token exchange and
succeed. A write-scope challenge is refused without opening consent. Reconnect
rejects a delayed result from the old generation and starts a new client on
the same row. After disconnect the retained caller makes no upstream request.

Require exit 0 and `pass: true` in `mcp-oauth-row-client.json`.
