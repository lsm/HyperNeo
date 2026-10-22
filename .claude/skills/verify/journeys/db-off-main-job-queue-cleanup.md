# Existing job cleanup DELETEs execute off main

Read shared SKILL.md. Run only a fresh synthetic HOME/data/DB. This drives the
actual app-wired `job_queue.cleanup` handler and independent health WebSocket RPC;
no GUI, credentials, real database copy, port8399 or live daemon access.

```bash
RUN=$(mktemp -d /private/tmp/hn-job-cleanup-XXXXXX)
env -i PATH="$PATH" HOME="$RUN/home" HYPERNEO_DATA_DIR="$RUN/data" NODE_ENV=test \
  bun .claude/skills/verify/job-queue-cleanup-worker.ts "$RUN"
```

The test-first commit must fail the strict responsiveness assertion. Two one-shot
synthetic SQL trigger costs slow the original two DELETE families; this is a
controlled SQLite delay, not the physical cause of the historical2.9s stall.
Seed/hash work is excluded. Existing cutoffs delete only completed/dead/failed
jobs older than7days and completed reminder scans older than1hour. Recent jobs,
pending jobs and2hour-old dead/failed reminder scans retain complete payloads.
All unrelated source tool-result bodies and search rows must remain identical.

`evidence/cleanup.json` records before/after retention, completed result=4deleted,
main/worker SQL, main transaction caller stacks, job time, main lag and independent
health. If remaining legacy writers contend with worker cleanup, preserve the
strict FAIL; `movement` as the second helper argument separately checks off-main
ownership/correctness and records `responsivenessPass=false`. Do not turn a
worker SQL or whole-job250ms miss into a pass. Repeat with `VERIFY_WRITER_IPC=1`.

After the change also rerun `claude-feed-purge-worker.ts "$RUN" movement` with a
second fresh directory and default5 concurrency. This checks the preceding feed
slice without pretending the unported dequeue/claim transaction is fixed. Every
probe, daemon and worker closes in finally, including failed runs.
