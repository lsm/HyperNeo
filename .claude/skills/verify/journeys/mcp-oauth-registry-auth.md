# MCP OAuth registry row protection

Run the shared isolated daemon proof with no model or browser:

```bash
bash .claude/skills/verify/proof-run.sh /absolute/evidence/mcp-oauth-registry-auth \
  .claude/skills/verify/mcp-oauth-registry-auth.ts --verify "$(git rev-parse HEAD)"
```

Before the fix, copy the helper into the base source and run with `--baseline`.
Require exit 1 at the delete reply assertion. The base accepts deletion and
lets workspace import retarget and prune rows with synthetic OAuth metadata.

The proof creates a plain row through the registry RPC. It removes the new
column and its migration marker from the stopped, synthetic database to model
the pre-upgrade shape. The upgraded daemon preserves the plain row and applies
the migration once. The helper imports an HTTP server with `workspace.add` and
seeds synthetic OAuth metadata directly because this slice has no connect RPC.
Adding the workspace again with a changed URL or a missing file leaves that
row unchanged. A plain registry update and delete both ask the caller to
disconnect first. Deleting the plain row succeeds. A final restart preserves
the OAuth metadata and the migration marker.

Require exit 0 and `pass: true` in `mcp-oauth-registry-auth.json`. The evidence
covers daemon startup, workspace import and the registry RPC. It uses no
provider, grant, SDK session or web UI.
