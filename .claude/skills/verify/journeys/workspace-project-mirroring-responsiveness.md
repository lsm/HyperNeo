## Workspace project mirroring responsiveness

```bash
RUN=$(mktemp -d /Users/lsm/focus/verification/project-mirror-XXXXXX)
env -i HOME="$RUN/home" PATH="$PATH" NODE_ENV=test HYPERNEO_DATA_DIR="$RUN/data" \
  bun .claude/skills/verify/project-mirror-lag.ts verify 9380 "$RUN"
```

Use a fresh directory outside the OS temporary folder: discovery deliberately
excludes temporary workspaces. This starts an isolated daemon and calls the real
`operation.invoke` / `work.find` WebSocket door with 40 synthetic tool projects,
each backed by a synthetic session recorded as started by this instance.
One controlled 1.4 s filesystem wait runs inside the production mirror worker.
An independent child probes `system.health` during that wait; a concurrent
synthetic project edit must complete before the wait ends and survive mirroring.
The reply must retain all 40 groups and their original folder/project ownership.
A second mirror exercises the default production worker entry without injection.

`observed.json` records max main-loop lag, health latency, edit timing and the
default worker timing. Fixed `verify` requires lag below 1 s and health below
250 ms. `reproduce` instead runs the mirror synchronously and requires both lag
and health latency above 1 s. The fixture observes the injected wait exactly
once; operation latency still includes that wait. Unit contracts retain false
results, serialize same-database mirrors, surface failures and allow later retry.
Every owned worker, probe, socket, timer and daemon closes before exit. No live
DB, existing workspace, credentials, provider, GitHub or GUI is used.

Repeat with `memory` instead of `verify` in another fresh directory. That mode
uses the daemon's supported private `:memory:` database and retains its original
connection synchronously, since another connection cannot share it. Without an
injected filesystem wait, the real RPC must still mirror all projects and aliases,
preserve the concurrent edit and create no `:memory:` file in its own working
directory. Its 220 ms edit barrier is fixture time, not a production latency.
The unresponsive-worker contract advances a fake clock 30 seconds, requires an
explicit timeout error and termination, and confirms the queued mirror proceeds
and completion clears its timer. This is technical worker failure protection;
the private memory fallback does not claim off-thread filesystem responsiveness.

For the associated scheduler wake-history query, run `wake-live-size.ts verify 9379
"$RUN"` in another fresh isolated HOME/data directory using the same environment.
It seeds 107,991 synthetic SDK headers and 2,112 pending
`session_schedule_wakes` metadata rows across 13 sessions,
then checks zero and two scheduled wakes through the repository and snapshot
RPC. It reports execution plans, VM steps and SQLite page-cache misses. These
are synthetic cardinalities, not copied live layout or physical disk reads.
Neither proof attributes historical no-SQL gaps or establishes that every
off-CPU stall is fixed.
