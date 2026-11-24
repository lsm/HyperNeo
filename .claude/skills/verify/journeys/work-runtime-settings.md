# Change an existing worker's model and thinking level

Read the isolation setup in [Verify HyperNeo](../SKILL.md). Run on the proof host
from the repository root with the pinned Bun on PATH:

```sh
bash .claude/skills/verify/proof-run.sh /absolute/fresh/evidence-directory \
  .claude/skills/verify/work-runtime-settings.ts
```

The script opens a worker on a disposable daemon, waits for its first reply,
and invokes `work.reconfigure` through the Neo MCP entry point. It submits a
second turn to the same ref and inspects the actual model request. The model and
effort must change, both turns must finish, and the second request must include
the first turn's input. It also checks an effort-only receipt and refusals for
a human-owned or human-named session, an unsupported driver, an invalid effort
and a missing model. The loopback model is synthetic. Its request fields prove
routing and settings delivery. Find the receipts and turn evidence in
`observed.json` and the exit code in `run-status.json`.
