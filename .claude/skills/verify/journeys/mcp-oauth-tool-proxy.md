# In-process MCP OAuth tool proxy

Run with the fixed test preset's loopback port 18347 free.

```bash
bash .claude/skills/verify/proof-run.sh /absolute/evidence/mcp-oauth-tool-proxy \
  .claude/skills/verify/mcp-oauth-tool-proxy.ts "$(git rev-parse HEAD)"
```

An isolated daemon connects to the test OAuth preset. An MCP client then lists
and calls tools through the same in-process SDK server that sessions will use.
It sees credential-free results after rotation on a delayed POST and on a
standalone SSE stream opened under the previous bearer. Catalogs over the limit
or containing credentials are refused. Results above the byte or item limit
carry an explicit truncation marker. An upstream error returns a reason code.
After an oversized response closes the transport, reopening under the same
grant generation still redacts the previous bearer and refresh token.

Require exit 0 and `pass: true` in `mcp-oauth-tool-proxy.json`. Session option
wiring and running-session reconciliation are covered by a separate slice.
