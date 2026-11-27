# Retarget a remote MCP OAuth registry row

Run with the fixed test preset's loopback port 18347 free.

```bash
bash .claude/skills/verify/proof-run.sh /absolute/evidence/mcp-oauth-retarget \
  .claude/skills/verify/mcp-oauth-retarget.ts "$(git rev-parse HEAD)"
```

An isolated daemon connects rows through real consent and holds a session
proxy for each, as a running session does. Through `mcp.registry.update` it
replaces one row's URL while that proxy's refresh reply is held, changes
another row to `stdio`, and clears `auth` on a third. Each change erases the
grant first; the non-HTTP row and the cleared row keep no `auth`. Afterwards
each retained proxy answers `reconnect_needed` and neither fixture receives a
request. A non-null `auth`, an unknown source type and a conflicting name are
refused, and that row's grant and proxy keep working. A restart shows all
three rows disconnected.

On the base before source-type and auth retargeting, expect exit 1 at the
source type step. Require exit 0 and `pass: true` in `mcp-oauth-retarget.json`.
