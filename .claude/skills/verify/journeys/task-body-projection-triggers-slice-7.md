### Task body projection triggers (slice 7)

First reproduce the body-source boundary with a fresh isolated run directory:

```bash
RUN=$(mktemp -d /private/tmp/hn-task-body-probe-XXXXXX)
env -i PATH="$PATH" HOME="$RUN/home" HYPERNEO_DATA_DIR="$RUN/data" NODE_ENV=test \
  bun .claude/skills/verify/task-body-projection.ts "$RUN"
```

Old code retains flags 17/subtype `before` after the side body changes. The split
triggers must return flags 18/subtype `after`. Keep the before/after artifact.
Repeat in a fresh directory with `missing` appended after `"$RUN"`: it removes
only the synthetic derived projection, blanks its legacy body, then updates
status. The old split inserts flags 0/subtype null; the corrected update must
restore flags 17/subtype `before` from its side body. CI also covers historical
rows without side bodies. Existing projections skip this body initialization.
For the actual task-feed door and performance proof, use another fresh directory:

```bash
RUN=$(mktemp -d /private/tmp/hn-task-body-door-XXXXXX)
env -i PATH="$PATH" HOME="$RUN/home" HYPERNEO_DATA_DIR="$RUN/data" NODE_ENV=test \
  bun .claude/skills/verify/sdk-live-query-filters.ts seed "$RUN"
env -i PATH="$PATH" HOME="$RUN/home" HYPERNEO_DATA_DIR="$RUN/data" NODE_ENV=test \
  bun .claude/skills/verify/task-body-projection-door.ts 9333 "$RUN"
```

The 55,014-row synthetic seed now uses the production dual-write helper as well
as production derivation and `replacement_metadata_normalized=1`. The verifier
uses the daemon's registered repository, including its reactive notifications,
and real WebSocket subscriptions to full and compact task feeds. It removes a
synthetic action projection and repairs it through the daemon's actual
status-update facade before observing its pin. It then adds 100
ordinary rows so the unresolved action must stay pinned outside the compact
100-row window; resolving it clears the pin, while the full feed reports the
chosen option. It waits for the production feed debounce before taking the next
snapshot. Do not construct a repository without `ReactiveDatabase` to test live
refresh: such a fixture bypasses the production notification path.

End state: full/compact snapshots and all stored body hashes agree across daemon
restart. Status-only changes retain projection body fields even with the legacy
body blanked inside a transaction that is rolled back; copy suppression and its
rollback preserve the projection and restore normal body writes. Deleting one
synthetic message follows the existing cleanup and leaves a different complete
700,000-character tool result unchanged. `observed.json`, `task-*.json`,
`compact-*.json` and `rpc-*.json` hold the real observations. Lag must stay below
1,000 ms and measured hot SQL below 250 ms; hashing is outside measured hot paths
and startup SQL is not individually timed. No model, provider, real DB or GUI is
used. With no provider the separate mailbox input may settle as failed; the
journey verifies storage, projections and feed delivery. Both daemon instances
stop in `finally`. Unit contracts and the unchanged historical pins run in CI.
