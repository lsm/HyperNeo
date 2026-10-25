# Neo cards and done pages use a reader snapshot

Use the shared isolated metadata-only setup with a fresh HOME/data directory,
NODE_ENV=test and writable TMPDIR. No model, provider, GUI or port 8399 is used.

```sh
RUN=$(mktemp -d "${TMPDIR:-/tmp}/hn-todo-read-XXXXXX")
mkdir -p "$RUN/home"
env -i HOME="$RUN/home" PATH="$PATH" NODE_ENV=test TMPDIR="${TMPDIR:-/tmp}" \
  HYPERNEO_DATA_DIR="$RUN/data" LOG_LEVEL=warn \
  bun .claude/skills/verify/todo-read-gateway.ts verify "$RUN"
```

The helper owns an ephemeral daemon and seeds 376 asks, 1,213 todos and 989
session links, matching observed row counts without copying live data. Through
the real WebSocket it reads `neo.snapshot` and `neo.ask.doneTodos`, checks done
IDs/count/order, and verifies the full multilingual evidence body by SHA-256.
Main-connection instrumentation must observe zero reads of the four todo/ask
tables during these RPCs. Snapshot, done-page and health latency must each stay
below 250 ms and main loop lag below 1 s. The report includes the snapshot's
serialized byte count; it does not separately attribute clone/queue time or
claim cold-disk or writer-contention coverage.

Copy the helper into a clean baseline checkout with frozen dependencies and run
`before` in a separate fresh run to retain main-thread SQL evidence on the same
RPC surface. Keep both `evidence/todo-read-gateway.json` files. Helpers close all
resources in finally.

Run the read command contract, ask-entry, session-track, goal-schedule and todo
completion tests. Unit command tests use the gateway's inline test seam under
Vitest; the helper proves real worker execution under Bun. Confirm the existing
concurrent duplicate-PR admission test still has one winner. Reads embedded in
settlement/question pruning/start-question and PR-URL write admission stay with
their whole write commands in #8712, per the documented handoff there.
