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

Repeat `verify` with `VERIFY_WRITER_IPC=1` for the real Bun worker reached through
the Node-harness JSON IPC bridge; this is not a synchronous fake. Repeat with
`VERIFY_WRITER_MEMORY=1` for the public poll RPC on the supported no-disk database;
that run uses 64 history rows and no cross-process lock.

For native failure boundaries, use a second fresh directory and the same isolated
environment to run `bun .claude/skills/verify/session-event-writer-fault.ts "$RUN"`.
It wraps the production native worker only in synthetic fixture modules: failure
before the INSERT, rollback after the INSERT, failure after commit before reply,
and a swallowed committed reply reaching its deadline. The fixture waits for its
own ready handshake before dispatch. It verifies complete 2.43 MB result bytes,
no publication without a commit acknowledgement, no client replay, canonical
terminal duplicates on explicit re-observation, fresh-worker recovery and closure.
A committed event with a lost reply remains stored but is not automatically
broadcast; this unit does not promise exactly-once notification. The no-disk
service path is checked independently. Evidence is `evidence/fault.json`.

Transaction call stacks in the RPC helper are proof-only instrumentation of the
main connection, including transactions prepared during startup. They attribute
other writer stalls without moving or optimizing those writer families here.
