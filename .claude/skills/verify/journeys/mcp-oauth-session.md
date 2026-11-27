# MCP OAuth tools in a running session

Use the isolated proof setup in the Verify skill. Keep test preset port 18347
free. The model API is an ephemeral loopback fixture.

```bash
VERIFY_CLAUDE=/absolute/path/to/pinned/claude \
bash .claude/skills/verify/proof-run.sh /absolute/fresh/evidence-directory \
  .claude/skills/verify/mcp-oauth-session.ts "$(git rev-parse HEAD)"
```

A real daemon opens a real Agent SDK session through RPC. Browser consent is
simulated against the test provider. On the same running query, observe a tool
appear on connect, call it, reconnect while a call is in flight, reject that
result, and call under the new grant. Disconnect and an invalid refresh grant
both remove tools from observed inventory. The SDK config carries no OAuth
headers. The proof disables SDK sandboxing for the synthetic SDK/MCP transport
and does not verify sandbox enforcement, browser UI or a real provider.

Require exit 0 and `pass: true` in `mcp-oauth-session.json`.
