# Neo todo sessions use the DB gateway

Use the shared metadata-only isolated setup: a fresh run directory and HOME,
NODE_ENV=test, a selected writable TMPDIR and HYPERNEO_DATA_DIR inside the run.
No provider, model turn, GUI, port 8399 or live database is involved.

```sh
RUN=$(mktemp -d "${TMPDIR:-/tmp}/hn-todo-gateway-XXXXXX")
mkdir -p "$RUN/home"
env -i HOME="$RUN/home" PATH="$PATH" NODE_ENV=test TMPDIR="${TMPDIR:-/tmp}" \
  HYPERNEO_DATA_DIR="$RUN/data" LOG_LEVEL=warn \
  bun .claude/skills/verify/todo-session-gateway.ts verify "$RUN"
```

The helper owns an ephemeral daemon, two synthetic manual sessions and one work
card. It makes the real scheduled Neo driver-refresh job due, runs the daemon's
job processor, and reads the card through `neo.snapshot` on the real WebSocket.
Main-connection instrumentation must record zero target recovery/report reads,
PR-window reads or live-status writes. The recorded snapshot must contain the
synthetic work card and its worker link.

It then holds a writer lock on the synthetic WAL database in a separate process
for 1.2 seconds. A gateway live-status write must wait for release while the real
`system.health` RPC responds below 250 ms and main loop lag remains below 1 s.
The writer result must be committed and readable when its promise resolves.
That affected write necessarily fails the 250 ms latency target under the held
lock; report this separately from main-thread responsiveness. This contention
phase drives the writer boundary directly, not a second refresh job.

For baseline reproduction, copy the same helper into a clean baseline checkout,
install its frozen dependencies, and run `before` with another fresh isolated
run. Expect target SQL on the main connection during the same refresh/snapshot
journey. Keep both `evidence/todo-session-gateway.json` files. The helper closes
its WebSocket, job processor, workers and daemon in finally.

Run `neo-todo-gateway.test.ts`, `neo-settle-driver-work.test.ts`,
`neo-todo-runner.test.ts` and `neo-coding-todo-prs.test.ts` from `packages/daemon`.
They preserve recovery results, strict PR windows, links, unchanged-write results
and notification ordering after status persistence. Todo/ask list conversion and
its atomic mutation admission remain in #8711.
