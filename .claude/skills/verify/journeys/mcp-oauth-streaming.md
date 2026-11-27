# Remote MCP OAuth streaming responses

Run the transport proof with a fresh evidence directory.

```bash
bash .claude/skills/verify/proof-run.sh /absolute/evidence/mcp-oauth-streaming \
  .claude/skills/verify/mcp-oauth-streaming.ts "$(git rev-parse HEAD)"
```

The isolated daemon holds a synthetic grant obtained through real SDK OAuth
against the loopback fixture. The real SDK client lists a tool while the HTTP
response stays open, over both a POST response and a standalone GET stream.
The fixture then sends an oversized SSE event and an
oversized SSE response made up of small events. The SDK must see
`response_too_large` for both and receive no tool list from either.

On the base, the tool list times out because the fetch waits for the response
to end. Require exit 0 and `pass: true` in `mcp-oauth-streaming.json` with
the fix. This journey exercises the transport before session wiring.
