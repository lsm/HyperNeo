# GLM Coding Plan model catalog

Run the isolated daemon proof from the repository root with the pinned Bun
version and the shared setup in [Verify](../SKILL.md).

```sh
bash .claude/skills/verify/proof-run.sh "$EVIDENCE" \
  .claude/skills/verify/glm-coding-plan-catalog.ts
```

The helper intercepts both upstream fetches in the real GLM provider and
supplies an in-memory fixture credential. The real `models.list` WebSocket
reply should offer one GLM-5.4 entry with `glm-5.4[1m]`, the `glm-5.4` alias,
and a 1M-token context window. Both selections should configure the same SDK
route. Retain `proof.log` and `run-status.json`. Account access requires a
separately authorized post-deploy session on the live daemon.
