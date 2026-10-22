# Retrying a large session preserves its badge without a slow visible count

Use the shared in-process RPC proof setup in SKILL.md with
`PROOF=.claude/skills/verify/sdk-visible-count.ts`. This helper runs no provider
turn and needs no HTTP mock or port 8000/8001 preflight. It owns an ephemeral
(non-8399) daemon listener, fresh test HOME/data/DB and GitHub stub. It requires
about 3 GiB free for its synthetic fixture; no real DB or keys are used.

The helper creates a session over real WebSocket RPC, seeds 360,000 retained
large assistant rows and one failed user input, then invokes the real
`session.messages.retry` RPC. A synthetic processing job holds that session's
FIFO lane so model delivery cannot race the observed failed-to-enqueued state.
This controls the lifecycle without changing the retry/count implementation.
The helper times real production count calls and an independent 10 ms heartbeat.
Seeding and the final retained-body audit are outside the measured interval.

End state: retry is accepted/enqueued; visible count changes from 360,001 to
360,000; all 360,001 rows and 1,855,800,141 body bytes remain. Each count must be
below 250 ms and heartbeat delay below 1 s. Evidence is
`evidence/visible-count.json`. The regression returned correct values but spent
556 ms in the count, 566 ms in the RPC and delayed the heartbeat by 555 ms.
The earlier 120,000-row probe took 133 ms and did not reproduce the breach.

All resources close in finally. This verifies the retry door and stored badge,
not a model response or browser rendering. Keep the third unsymbolicated native
capture separate from this query fix. After deployment, use journey 19 to record
at least two hours on the deployed build and compare >=1 s blocks and worst lag
with the before window, disclosing build/window/workload differences.

The fixed path maintains the existing persisted badge from only the changed
row metadata, in the same transaction as the status mutation. It does not cache
or suppress a required count. The real retry receipt took 7 ms with 1.1 ms
heartbeat lag and no full recount; stored badge, row count and body bytes match.
The RPC itself is also required to finish below 250 ms. The explicit repair and
rewind/delete recounts remain available; this journey does not claim those are
bounded on every data size.

Read-only deployed follow-up (run from a checkout containing the merge):

```bash
bun .claude/skills/verify/deployed-lag-window.ts <squash-commit> <evidence-dir> <before-two-hours.jsonl>
```

It uses `hyperneo build` through the owner-only socket and never calls port
8399 or opens a DB. A pending result means the build does not contain the merge
or its current PID has not run for two hours; it is not a pass. Once ready, it
reads all retained structured log rotations, filters the current PID and last
two hours, delegates to `scripts/daemon-lag-tally.ts`, and saves the comparison
and raw lag records. It fails if retained timestamps cannot cover the window.
Compare counts and worst blocks, and disclose that the before period includes
other builds and a different workload. A restart resets the uninterrupted
observation window.
