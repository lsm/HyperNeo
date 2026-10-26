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

A fourth SDK call supplies a valid project link together with missing/legacy links,
an unknown reply id and an invented artifact. Its text must be delivered with only
the valid project link; omitted ids must not claim a human answer.

A fifth SDK call uses `operations.describe` for `neo.publication.publish`. Its
description must explicitly say that non-project and unavailable links are omitted.
The fourth call includes both legacy `work` and `consultation` links, so the
discovered guidance and the stored message must agree. The helper records the
description in `observed.json` before asserting it, including on failure.

Save `observed.json`, `evidence.json` and the proof log outside the run directory,
then delete the synthetic run. A refused bundle is a failure. After rollout, read
`hyperneo build` and confirm its commit contains the merged change; do not restart
the live daemon.
