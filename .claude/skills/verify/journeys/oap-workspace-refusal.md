# OAP workspace capability refusal

Use the shared isolation and pinned Bun in `../SKILL.md`:

```sh
TMPDIR=/private/tmp bash .claude/skills/verify/proof-run.sh /absolute/fresh/evidence-directory .claude/skills/verify/oap-workspace-refusal.ts
```

The helper starts an isolated daemon on an ephemeral port and uses authenticated
RPC to create a synthetic Codex session. It verifies the harness persists, an
attempted harness switch is refused, and a message produces a visible refusal
about the missing open-directory capability without entering the SDK startup gate
or tracking an SDK child. The provider key is synthetic and stored only in the
temporary database. No real Codex or OAP process runs. This proves the refusal,
not the eventual Codex text turn or workspace routing. Cleanup closes the socket
and daemon before the wrapper removes synthetic data.
