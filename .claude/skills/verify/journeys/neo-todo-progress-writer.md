# A worker progress observation commits as one writer command

Use the shared metadata-only setup in SKILL.md. This helper owns an ephemeral
daemon, two manual synthetic sessions, its GitHub stub and a fresh database.
No model, provider, real HOME/data, credentials, GUI or port 8399 is involved.

```sh
RUN=$(mktemp -d "${TMPDIR:-/tmp}/hn-todo-progress-XXXXXX")
mkdir -p "$RUN/home" "$RUN/tmp" "$RUN/bin"
env -i HOME="$RUN/home" PATH="$RUN/bin:$PATH" TMPDIR="$RUN/tmp" NODE_ENV=test \
  HYPERNEO_DATA_DIR="$RUN/data" LOG_LEVEL=warn \
  bun .claude/skills/verify/todo-progress-writer.ts verify "$RUN"
```

The real scheduled Neo refresh observes a running manual worker. A synthetic
SQLite trigger refuses its check stamp: the previous needs-you status and
incident timestamp must both survive. The worker then reports the same needs-you
incident: no second ask-the-human note may be queued for Neo. Returning the worker
to running and refreshing must commit status, incident reset and the successful check
together; the real WebSocket `neo.snapshot` must show the card doing.

During that successful refresh, main instrumentation must see zero check/start
stamp writes, needs-you resets or their incident lookups. Run `before` on the
test-first pre-fix commit in another fresh checkout/run to record the partial
running status and lost incident after the same refused scheduled update.
Keep both `evidence/todo-progress-writer.json` files. They include job/health
latency, writer round trips and maximum loop lag. Cold failed-job latency over
250 ms is a failed target; it is not hidden by the warm successful job result.
These timings do not separately attribute queue, SQL and clone time.
The helper then holds a synthetic WAL writer lock for 1.2 seconds in a separate
process. On the baseline the legacy progress writes block the real health RPC;
on fixed code the writer command waits while health stays below 250 ms and main
loop lag below 1 s. The affected write itself still exceeds 250 ms: record that
failure explicitly. This contention phase drives the persistence command
directly; the earlier correctness phases use the scheduled job and snapshot.

Run the runner, settlement, input-attribution and todo-gateway tests. They keep
start anchoring, unchecked status-read results and notification-after-commit
behavior. The Deno smoke checks commit and trigger-induced rollback of every
progress field; the shell-argument regression checks its embedded programs.
Run the existing todo-session-gateway journey too for recovery races and its
1.2-second held writer lock: the affected write still misses 250 ms even when
health and main loop responsiveness pass.
