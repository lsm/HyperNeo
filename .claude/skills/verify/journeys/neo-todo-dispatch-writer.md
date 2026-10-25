# Dispatch assignment and acknowledgement commit together on the writer

Use the shared metadata-only isolated setup and synthetic Desktop IPC setup in
SKILL.md. No provider, real app, real HOME/database, credentials, GUI or port
8399 is used. The helper owns its ephemeral daemon and synthetic socket peers.

```sh
RUN=$(mktemp -d "${TMPDIR:-/tmp}/hn-todo-dispatch-XXXXXX")
mkdir -p "$RUN/home" "$RUN/tmp" "$RUN/bin"
env -i HOME="$RUN/home" PATH="$RUN/bin:$PATH" TMPDIR="$RUN/tmp" NODE_ENV=test \
  HYPERNEO_DATA_DIR="$RUN/data" LOG_LEVEL=warn \
  bun .claude/skills/verify/todo-dispatch-writer.ts verify "$RUN"
```

Through the real MCP operation door, add and start a todo targeting the synthetic
Codex Desktop worker. The returned card must be doing and its exact turn receipt
must be readable after the reply. Instrumentation between external acceptance
and the operation reply must observe zero main-connection assignment/receipt
writes or current-model lookups.

A synthetic SQLite trigger then refuses receipt persistence on a second todo.
The operation must report that refusal, with neither a new worker assignment nor
a partial send receipt committed. The durable input outcome is retained and the
external turn runs exactly once; persistence failure must not replay it.

Run `before` on the pre-fix checkout with a separate fresh run to observe target
SQL on main and the partial worker assignment after the same refused operation.
Keep both `evidence/todo-dispatch-writer.json` files. The report measures the full
affected operation; a result over 250 ms is a latency failure even when worker
routing and atomicity pass. This journey does not prove contention elimination.
The separate 1.2-second held-lock journey still misses the 250 ms write target.
The report also retains warm operation samples, health latency during writer
calls, writer round-trip time and serialized argument/result sizes, maximum
loop lag, RSS and WAL size. Round-trip timing does not separately attribute
queue wait, SQL/lock time or clone time; those stages remain unverified here.

Run the runner, settlement, gateway, duplicate-PR and Track regressions. Also run
the repaired dispatch-evidence journey for start/unconfirmed/steer retention
across daemon restart. The Deno smoke exercises this command and receipt-refusal
rollback through real Deno workers in CI.
