# Turn embedding reads pending ranges without blocking health

Use SKILL.md's in-process setup, pinned Bun1.4.2, a fresh synthetic HOME/data/DB,
and `PROOF=.claude/skills/verify/turn-vector-reader.ts`. No model/mock/GUI is needed.
Pass `1200` after the run directory for a one-shot executing-thread MIN/MAX wait;
repeat in a fresh run with `1200 bridge` for IPC, and `0` for ordinary data.

The helper runs the real app-wired work.turns.embed job at default concurrency5
with a deterministic embedder. It verifies fresh-before-backfill order, 2000-char
embedding input, excluded short/task rows, stored full body/preexisting vector
hashes and exact new vector values. A separate process sends actual health RPCs.
Retain evidence/observed.json and range-reads.jsonl even on failure. Commit the
failing reproduction before implementation. Require main lag below1s and health
below250ms; the modeled-wait job still exceeds250ms and is not a latency pass or
physical-disk attribution. The ordinary-data control checks job latency separately.
All reads reuse the existing shared reader, with no disk fallback on failure.
The helper closes its probe, app and worker resources in finally.
The Deno smoke also opens a cold shared reader directly on its fresh synthetic DB.
Dispatch waits for the worker's handler-ready acknowledgement, with the existing
request deadline covering startup; no sleep, retry or synchronous fallback is used.

When changing the shared SQL-wait instrumentation, run both modes through the
shared proof wrapper in separate fresh evidence directories:

```bash
TMPDIR=/private/tmp bash .claude/skills/verify/proof-run.sh /absolute/fresh/read-evidence .claude/skills/verify/turn-vector-reader.ts 1200
TMPDIR=/private/tmp bash .claude/skills/verify/proof-run.sh /absolute/fresh/write-evidence .claude/skills/verify/turn-vector-reader.ts 1200 writer
```

Read mode must record MIN/MAX get calls and write mode must record INSERT run
calls. Each must record exactly one modeled 1200 ms wait on the worker; a missing
log, zero applied waits or any main-thread execution fails the proof.
