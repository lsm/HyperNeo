### Work-feed search cleanup latency (journey 28)

Run the real Claude-feed maintenance job in an isolated daemon while reading a
session through WebSocket RPC:

```bash
RUN=$(mktemp -d /private/tmp/hn-search-delete-XXXXXX)
env -i PATH="$PATH" HOME="$RUN/home" HYPERNEO_DATA_DIR="$RUN/data" NODE_ENV=test \
  bun .claude/skills/verify/search-delete-lag.ts 9348 "$RUN"
```

Use a free non-8399 port and a new directory. The helper creates 30,000 synthetic
stored tool results and duplicate Claude search rows, each with an 8-KiB body,
plus 3,000 Codex search rows and the actual FTS5/vector cleanup triggers. It queues
`work.feed.claude` through the real job queue, samples the event loop every 10 ms
and reads `session.get` during cleanup. No provider, transcript discovery outside
the temporary HOME, real database, credentials or browser is used.

End state: `observed.json` records a completed job, zero duplicate Claude rows,
all 3,000 Codex rows, identical SHA-256 of every stored message/tool-result body,
maximum event-loop lag below 1,000 ms and every observed search-content statement
below 250 ms. The old unbounded delete fails those budgets; save that failing
`observed.json` before applying the fix. Sampling and SQL timing start after corpus
creation, so seed work is excluded. RPC measurements share the daemon's process
and can miss a stall between requests; the interval delay is the block metric.
The helper stops its daemon and interval even on assertion failure.

Repeat in another fresh directory with `16000` as the third helper argument to
exercise the maximum feed body size. CI also checks that another callback runs
while derived cleanup is still underway, FTS/vector cleanup remains correct,
other feed kinds remain searchable and vanished-feed callers await cleanup.
Measurements establish the tested synthetic workloads, not a physical upper
bound on disk I/O or deployed performance. Keep both JSON reports and the exact
command as PR evidence; stored source data is never deleted.
