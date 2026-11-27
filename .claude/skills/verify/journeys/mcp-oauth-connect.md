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
