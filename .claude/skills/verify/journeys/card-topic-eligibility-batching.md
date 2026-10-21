# Card-topic eligibility stays responsive with many followed todos

Use the shared isolation rules in ../SKILL.md. This journey needs no model,
keys, GUI, or real database. The helper creates a real isolated daemon and uses
its WebSocket RPC door to invoke the actual synchronous sweep while a second
health RPC waits. It preserves 231 followed todos' two topics each and ends a
removed todo's topics in their original order.

```sh
RUN=$(mktemp -d)
env -i PATH="$PATH" NODE_ENV=test HOME="$RUN/home" \
  HYPERNEO_DATA_DIR="$RUN/data" \
  bun .claude/skills/verify/card-topic-eligibility.ts verify 9433 "$RUN"
```

The helper injects 8 ms of controlled latency per native SQLite todo/ask/PR
eligibility read, retaining the real SQLite execution and result. It records
`observed.json`: max heartbeat lag, health/sweep latency, eligibility query count,
subscription decisions/order, phases and the effect of a pack-setting change on
the next sweep. Require <=3 eligibility reads, max lag <1s and health <250ms.
Run again with `disabled` appended to verify pack delivery false is reused too.
The helper stops all owned resources in finally. Keep each run directory as
review evidence; never reuse it or point it at a real HOME/DB.

On the pre-fix regression commit, `reproduce` instead of `verify` records the
fan-out and requires >=1s lag. Unit regressions additionally cover done asks,
merged/unmerged PRs, dropped asks, failed/removed/blocked todos, next-sweep PR and
ask edits, empty sweeps and a 180-todo slow-read budget. This synthetic proof
addresses this fan-out only, not every historical off-CPU stall.
