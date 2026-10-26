# Long-lived worker names and coordination guidance

From the worktree root, use the metadata-only isolated setup in SKILL.md:

```bash
bash .claude/skills/verify/proof-run.sh /absolute/fresh/evidence-directory .claude/skills/verify/worker-session-guidance.ts verify
```

The helper owns an ephemeral-port daemon, synthetic HOME and DB, with GitHub
stubbed and job processing stopped. It reads work.start, work.rename and
neo.todo.add and message.send through Neo's real MCP discovery, and the human-only handoff
through public RPC. It opens Neo and reads that session's configured system
prompt, then sends a coding todo to a synthetic HyperNeo worker and reads its
queued mailbox input. No model/provider, external API, simulator or GUI is used.

Inspect worker-session-guidance.json: all descriptions and Neo's prompt must
require project-and-number session names, never task titles. The worker's
queued brief must instruct it to wait/retry for one of at most two booted
simulators machine-wide and send coordination questions to Neo without a human
card. The discovered message.send description must make the same distinction.
Only human-decision questions should carry the human-card envelope.
A baseline run records missing guidance and fails; retain it separately from
the passing run. This proves text delivery, not autonomous model compliance or
simulator-slot enforcement. The wrapper retains evidence and removes its owned
synthetic data immediately; the helper stops its daemon in finally.
