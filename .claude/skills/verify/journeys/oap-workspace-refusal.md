# OAP workspace capability refusal

Use the shared isolation and pinned Bun in `../SKILL.md`:

```sh
TMPDIR=/private/tmp bash .claude/skills/verify/proof-run.sh /absolute/fresh/evidence-directory .claude/skills/verify/oap-workspace-refusal.ts
```

The helper starts an isolated daemon on an ephemeral port and uses authenticated
RPC to create a synthetic Codex session. It verifies the harness persists, an
attempted harness switch is refused, and a message produces a visible refusal
about the incomplete OAP configuration without entering the SDK startup gate
or tracking an SDK child. A second session injects a synthetic OAP hub into its
runtime and sends two turns through the daemon; each must persist a text result
and release the query and queue without cancelling its completed run. It then
delays an old run's failure until after a new generation has queued a synthetic
prompt, and verifies that the replacement prompt and attempt remain live. The
provider key is synthetic and stored only in the temporary database. No real
Codex or OAP process runs, so real workspace routing remains unverified. Cleanup
closes the socket and daemon before the wrapper removes synthetic data.
