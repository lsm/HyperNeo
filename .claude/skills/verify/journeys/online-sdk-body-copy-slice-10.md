### Online SDK body copy (slice 10)

### SDK body next-start mode (online precursor to slice 11)

Use a fresh isolated HOME/data directory and a free port; no GUI, provider or
credentials are needed. The helper seeds consumed inputs, so no model turn is
scheduled. Do not use a live DB or port 8399.

```bash
RUN=$(mktemp -d /private/tmp/hn-sdk-side-only-XXXXXX)
mkdir -p "$RUN/home"
env -i PATH="$PATH" HOME="$RUN/home" HYPERNEO_DATA_DIR="$RUN/data" NODE_ENV=test \
  bun .claude/skills/verify/sdk-body-mode.ts laptop 9372 "$RUN"
```

Repeat with `mixed` and another fresh run/port. Both seed 5,000 synthetic messages,
derive columns through the production chunked backfill, and retain complete tool
results. The mixed fixture deliberately removes half its side copies, retaining
their legacy bodies; startup must serve in dual-write mode. Its own synthetic
missing copies are restored before the next restart. The completed laptop fixture
serves in dual-write/coverage_pending while its read-only coverage worker runs,
then chooses side-only. The helper waits for the final non-pending WARN mode
before exercising writers, including after each restart; pending is never treated
as the final mode. All eight production writers are exercised in
both runs; side bodies remain complete and the logical hash survives restart.
Fifty real health/transcript RPCs return full tool results. This is not a GUI test.

For the single-step old-schema upgrade, create a detached worktree at the observed
iMac build `258b731c` under `~/focus/worktrees/`, install frozen dependencies, and
run `old` in a fresh isolated directory, adding that worktree as the fourth
argument. It creates 60,000 synthetic old-schema rows with consumed inputs and
`replacement_metadata_normalized=1`, never copying the live DB. On the old #7865
head `2014efa`, the same old-schema startup refused before serving (reproduction:
`/private/tmp/sdk-side-old-schema-proof/evidence/observed.json`). Fixed code must
run migrations, bind, serve health/transcript, finish the real background copy,
continue dual-writing in that process, then choose side-only on the next start.

Evidence is `evidence/observed.json`: complete logical hashes/counts, WARN-level
chosen modes, startup/copy/query/lag/RPC timings and missing count. Initial legacy
hash equals the migrated logical hash before new writes; the post-write logical
hash remains identical across restart. Seeding and deliberate full-digest reads
are measurement probes, not production RPC workloads. The helper closes its
WebSocket and daemon in `finally`; unit suites run only in CI.

Mode selection starts after numbered migrations/backfill. An already-completed
copy is checked in bounded yielding batches in a read-only worker while the
daemon serves safely in dual-write mode. Only successful verification enables
side-only writes; missing bodies or worker failure retain dual writes. Copy
completion during a process does not schedule a new verification until restart. Unified reads retain side-first
COALESCE until slice 11; all writes always keep a complete side body, and pending,
reversed or incomplete copies also update the legacy body atomically. Startup
mode is logged at production WARN. Permanent backups are retained. Slice 11 must
accept legitimate nonempty legacy copies from writes during background copying:
side completeness, verified backup and hashes establish authority, not empty
legacy text. Column removal still needs its separately scheduled downtime PR.

For the qualified-predicate regression behind CI's `no such column: m.rowid`
and `m.sdk_message` failures, use a fresh isolated run directory:

```bash
RUN=$(mktemp -d /private/tmp/hn-sdk-body-predicate-XXXXXX)
mkdir -p "$RUN/home"
env -i PATH="$PATH" HOME="$RUN/home" HYPERNEO_DATA_DIR="$RUN/data" NODE_ENV=test \
  bun .claude/skills/verify/sdk-body-predicate.ts verify "$RUN"
```

This uses real in-memory SQLite and the production body writer, testing both
qualified row/body predicates in both modes. Every tool-result byte remains
readable through the repository. On the failing head run `reproduce`: dual-write
must throw both unknown-column errors while side-only succeeds. The UPDATE must
declare the same `m` target alias as the side INSERT. It does not change fixture
assertions, schemas or body semantics. Repeat the real-daemon `laptop` and `mixed`
journeys above to verify all eight production writers and RPC output afterward.
