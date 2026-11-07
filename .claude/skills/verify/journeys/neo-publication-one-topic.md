# Publications deliver multiple topics without presentation vetoes

Read shared setup in SKILL.md. Use the shared proof wrapper with an unused non-8399 model port:

```bash
TMPDIR=/private/tmp bash .claude/skills/verify/proof-run.sh /absolute/fresh/evidence-directory .claude/skills/verify/publication-topics.ts 9366
```

The helper uses the actual SDK/MCP operation, an isolated synthetic DB, and a loopback scripted model.
No real provider, credential file or live daemon is used.

The model publishes two labelled topics under a short summary, then each topic
separately. All three receipts must be accepted and all three messages must appear
in the publication reader, including the complete bundled message.

The SDK send with requestId `references` supplies a valid project link, an unknown reply id and an
invented artifact; the whole send must be rejected without reserving the requestId.
Earlier work-kind and unknown-project attempts also fail, and a corrected send
reuses that requestId to deliver the valid project link. Discovered tool guidance
must say that only project links are accepted and unknown projects reject the send.

For the link admission regression, use the actual daemon/MCP and human RPC reader
without a model subprocess (no mock-port preflight is needed):

```bash
TMPDIR=/private/tmp bash .claude/skills/verify/proof-run.sh /absolute/fresh/evidence-directory .claude/skills/verify/publication-links.ts
```

This helper rejects work/consultation links at the schema, rejects a mixed list
containing an unknown project with a named error, then confirms the human reader
has no publication. Correcting the same requestId delivers the valid project link;
a retry leaves exactly one publication. The helper closes its ephemeral daemon
and socket in finally. On the test-first commit it records the silently dropped
link and fails. An SDK subprocess startup timeout is inconclusive; this narrower
MCP/RPC proof does not claim model-turn execution or GUI rendering.

Save `observed.json`, `evidence.json` and the proof log outside the run directory,
then delete the synthetic run. A refused bundle is a failure. After rollout, read
`hyperneo build` and confirm its commit contains the merged change; do not restart
the live daemon.
