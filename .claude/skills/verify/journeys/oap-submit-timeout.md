# OAP submit timeout reconciliation

Use shared isolation, the resource guard and pinned Bun from `../SKILL.md`.

```sh
TMPDIR=/private/tmp bash .claude/skills/verify/proof-run.sh /absolute/fresh/evidence-directory .claude/skills/verify/oap-submit-timeout.ts
```

The helper starts an isolated daemon on an ephemeral port and an owned synthetic
stdio hub. A real RPC message reaches submit, which runs without replying. The
user sees a timeout and the original prompt is recorded as submitted. A second message
must query work.status, observe the unfinished run and show that result without
sending a second submit. Existing session recovery marks the original failed
with a visible unknown-outcome warning, while the unsent follow-up is refused. The proof uses the production query adapter and client.
The child, socket and daemon close before temporary data is removed. Real OAP
provider behavior remains outside this synthetic journey.
