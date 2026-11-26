### Remote MCP OAuth provider and vault grant (slice 1)

```bash
bash .claude/skills/verify/proof-run.sh /absolute/evidence/mcp-oauth-provider \
  .claude/skills/verify/mcp-oauth-provider.ts "$(git rev-parse HEAD)"
```

Keep each evidence directory fresh.

The helper boots an isolated test daemon and two loopback fake MCP OAuth servers
(`packages/daemon/tests/helpers/fake-mcp-oauth-server.ts`). It runs the real SDK
`auth()` with the vault-backed provider: discovery, DCR, PKCE and the code
exchange. Then it restarts the daemon and reads the grant from the vault. Pass
means the authorize request carried only the preset scopes, the grant survives
the restart, no table row contains a token, another instance or row reads
nothing, and a 401 naming the second server sends it no request.

This is a construction slice: there is no connect RPC, Settings row or session
proxy yet. Unit contracts in `tests/unit/1-core/credentials/mcp-oauth-provider.test.ts`
cover the over-broad grant, Slack reply shapes, unpinned origins, exact credential
URLs across redirects, issuer, resource and endpoint binding, deadlines, upstream
error text, refresh without `scope` and body caps. The evidence holds
outcomes only, never tokens.
