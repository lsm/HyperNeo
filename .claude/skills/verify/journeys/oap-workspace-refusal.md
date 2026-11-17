# OAP workspace capability refusal

Use the shared isolation and pinned Bun in `../SKILL.md`:

```sh
TMPDIR=/private/tmp bash .claude/skills/verify/proof-run.sh /absolute/fresh/evidence-directory .claude/skills/verify/oap-workspace-refusal.ts
```

The helper starts an isolated daemon on an ephemeral port and uses authenticated
RPC to create a synthetic Codex session. The OXAP scripts choose the provider:
`oxap-codex-provider.ts` adds an `anthropic-codex` provider record whose
`configJson` names `oxap-codex`, and session create derives the chat's harness
from it. The Codex bridge probes OpenAI once when it lists models; the helper
answers that one URL in-process and refuses any other non-loopback request, so
nothing leaves the machine. It verifies the derived harness persists, a
client-sent harness is refused at create and update, and these doors refuse
before they save, leaving the stored config byte-identical: an SDK chat moving
to the OXAP provider, the OXAP chat moving to `anthropic`, `permissionMode:
plan`, a thinking level through `session.update` and `session.thinking.set`,
`session.sandbox.switch` on, and `session.coordinator.switch` on. A message produces a visible refusal
about the incomplete OAP configuration without entering the SDK startup gate
or tracking an SDK child. A second session injects a synthetic OAP hub into its
runtime and sends two turns through the daemon; each must persist a text result
and release the query and queue without cancelling its completed run. It then
delays an old run's failure until after a new generation has queued a synthetic
prompt, and verifies that the replacement prompt and attempt remain live. The
helper also sends an old run's event after a successor starts and verifies the
event is dropped while the successor stays live. The provider key is synthetic
and stored only in the temporary database. No real
Codex or OAP process runs, so real workspace routing remains unverified. Cleanup
closes the socket and daemon before the wrapper removes synthetic data.
