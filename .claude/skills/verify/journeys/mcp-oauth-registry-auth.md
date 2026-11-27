# MCP OAuth registry row protection

Run the shared isolated daemon proof with no model or browser:

```bash
bash .claude/skills/verify/proof-run.sh /absolute/evidence/mcp-oauth-registry-auth \
  .claude/skills/verify/mcp-oauth-registry-auth.ts --verify "$(git rev-parse HEAD)"
```

Before the fix, copy the helper into the base source and run with `--baseline`.
Require exit 1 at the delete reply assertion. The base accepts deletion and
lets workspace import retarget and prune rows with synthetic OAuth metadata.

The proof checks the todo plan columns on first boot and creates a plain row
through the registry RPC. It then recreates a database affected by the collision
by removing the plan columns and recovery marker 540 while leaving markers 537
and 539 and the registry intact. Restarting records 540, restores the plan columns
and preserves the registry row. The proof also starts from a database without
the `auth` column or marker 539 and checks that the OAuth migration applies.
The helper imports an HTTP server with `workspace.add` and
seeds synthetic OAuth metadata directly because this slice has no connect RPC.
Adding the workspace again with a changed URL or a missing file leaves that
row unchanged. Deleting the plain row succeeds. A final restart preserves the
OAuth metadata and the migration marker, and a registry delete then removes the
OAuth row through the fenced remove operation (see the `remove` proof in
[mcp-oauth-connect](mcp-oauth-connect.md)).

Require exit 0 and `pass: true` in `mcp-oauth-registry-auth.json`. The evidence
covers daemon startup, workspace import and the registry RPC. It uses no
provider, grant, SDK session or web UI.
