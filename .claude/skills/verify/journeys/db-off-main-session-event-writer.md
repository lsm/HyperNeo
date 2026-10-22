# Session event persistence uses one writer

Read shared SKILL.md. This journey drives the real public space.github.pollOnce
RPC through a synthetic gh executable and the actual app-wired session publisher.
No GitHub, provider/model, credentials, GUI, real DB copy or port8399. Suites stay
CI-only. It creates a fresh synthetic HOME/data/DB and owns all child processes.

```bash
RUN=$(mktemp -d /private/tmp/hn-session-writer-XXXXXX)
mkdir -p "$RUN/home"
env -i HOME="$RUN/home" PATH="$RUN/bin:$PATH" NODE_ENV=test HYPERNEO_DATA_DIR="$RUN/data" LOG_LEVEL=warn \
  bun .claude/skills/verify/session-event-writer.ts verify "$RUN"
```

Use `baseline` on the test-first source before the writer implementation. The
publisher injection acquires a real synthetic WAL write lock in an independent
Bun process immediately before forwarding one session event through the original
publisher. The holder releases it after1200ms. This isolates the specific store
wait; it does not establish the cause of production off-CPU stalls.

100000 complete production-store-written historical events are seeded before
measurement. One full synthetic review is ingested, published only after it is
readable, and deduplicated without a second publication. History SHA/count and
full review payload bytes must remain intact. `evidence/writer.json` records the
actual poll reply/latency, max main lag, independent health latency, main SQL,
worker SQL/request timings, sampled RSS and the retention hashes. Report every
250ms SQL/RPC miss: moving a lock wait off main does not shorten it. Seed/hash
work is excluded. Failed or inconclusive runs stay alongside the final evidence.

The helper restores its publisher injection and closes its probe, lock holder,
socket and daemon in finally. Never poll the live daemon to manufacture evidence.
After deployment, read build/PID and existing performance logs only. No migration,
index, data cleanup or other writer family belongs to this unit.
