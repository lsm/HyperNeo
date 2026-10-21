## Card-topic sweep responsiveness

Run a fresh isolated daemon with synthetic HOME/data/DB and a free non-8399
port. The helper creates 180 followed todos with two topic subscriptions each,
plus one removed todo. Each pack-eligibility settings read gets an explicit
8 ms synthetic blocking wait before its real SQLite read. No real session,
provider, key, transcript or live DB is involved.

```bash
RUN=$(mktemp -d /private/tmp/hn-card-topic-phases-XXXXXX)
env -i HOME="$RUN/home" PATH="$PATH" NODE_ENV=test HYPERNEO_DATA_DIR="$RUN/data" \
  bun .claude/skills/verify/card-topic-phases.ts verify 9375 "$RUN" enabled
```

Repeat in another new directory with `disabled` instead of `enabled`. On the
regression commit use `reproduce`: both modes must show 180 eligibility reads
and max heartbeat lag over 1 s. Fixed `verify` must show exactly one settings
read, including when eligibility is false, with heartbeat lag below 1 s and
health below 250 ms. `observed.json` retains phase totals, actual subscriptions,
health latency and any structured lag diagnostics.

With delivery enabled, only the removed todo's two topics end and 360 remain.
With delivery disabled, all 362 topics end. The helper then changes the stored
pack setting, re-subscribes active topics if needed and sweeps again over the
same WebSocket. The changed eligibility must take effect immediately on that
next sweep, in both directions; no value is cached across sweeps. Focused tests
also keep settings unread when there is no followed todo, including an empty
sweep. This keeps the snapshot lazy rather than adding an unconditional read.

The existing activity buffer retains 64 entries and reports dropped entries;
large sweeps expose a suffix of per-todo phases plus the final aggregate. The
helper separately totals every emitted phase in its own instrumentation, without
changing production buffering. Nested totals overlap and must not be added.
This proves the repeated-read path under controlled latency, not the cause of
the historical 20:09 four-second phase or a particular OS wait. The helper closes
its socket, diagnostic observer, Neo service and daemon in `finally`.
