## Feed metadata I/O responsiveness

Use a new synthetic HOME/data/DB and a free non-8399 port. The helper drives the
real timed Codex/Claude feed pipelines over an isolated daemon WebSocket while
requesting `system.health` on the same connection. It injects a 1.4 s delay only
for selected synthetic directory listing, existence and known-file stat calls:
blocking `Atomics.wait` for synchronous calls, asynchronous timers for promise
calls, both delegating to the real filesystem. This models slow metadata I/O;
it is not a reproduction of the laptop's particular kernel wait.

```bash
RUN=$(mktemp -d /private/tmp/hn-feed-listing-proof-XXXXXX)
env -i HOME="$RUN/home" PATH="$PATH" NODE_ENV=test HYPERNEO_DATA_DIR="$RUN/data" \
  bun .claude/skills/verify/feed-listing-lag.ts verify 9374 "$RUN"
```

On the regression commit use `reproduce` in another fresh directory. Each of
Codex listing, Claude listing, retained-path prune and unfinished known-path
metadata must show max heartbeat lag over 1 s. Fixed code must keep max lag
below 1 s and health latency below 250 ms. The unfinished old transcript must
still be read despite its age; content, file sizes, complete offsets and mtimes
are asserted in `observed.json`. The retained-path prune must not change offsets.
The helper closes its own socket and daemon in `finally`. It uses no model or
credentials and never reads the real session directories. Feed content reads
remain synchronous in this slice; this journey verifies metadata I/O only.
