### Historical slice-10 copy journey

Run only on a new synthetic database, larger than the read-only live file-size
observation; never seed from or copy a live DB:

```bash
RUN=$(mktemp -d /private/tmp/hn-sdk-body-copy-XXXXXX)
mkdir -p "$RUN/home"
env -i PATH="$PATH" HOME="$RUN/home" HYPERNEO_DATA_DIR="$RUN/data" NODE_ENV=test \
  bun .claude/skills/verify/sdk-body-copy.ts seed 9338 "$RUN"
env -i PATH="$PATH" HOME="$RUN/home" HYPERNEO_DATA_DIR="$RUN/data" NODE_ENV=test \
  bun .claude/skills/verify/sdk-body-copy.ts reserve-retry 9338 "$RUN"
env -i PATH="$PATH" HOME="$RUN/home" HYPERNEO_DATA_DIR="$RUN/data" NODE_ENV=test \
  bun .claude/skills/verify/sdk-body-copy.ts verify 9338 "$RUN"
env -i PATH="$PATH" HOME="$RUN/home" HYPERNEO_DATA_DIR="$RUN/data" NODE_ENV=test \
  bun .claude/skills/verify/sdk-body-copy.ts backup-reject 9338 "$RUN"
```

The 90,000-row seed uses production derivation, dual writes and normalized
replacement metadata, including 735 KB complete tool results. It removes half
the duplicate side copies to model historical legacy-only rows. The parent
probes real `system.health` and `message.sdkMessages` over WebSocket while the
real daemon migrates. There is no daemon HTTP `/health` route; an HTTP 404 is
not responsiveness evidence. Transcript replies use `sdkMessages`, not `messages`.
The parent closes its WebSocket when the child publishes completion so daemon
cleanup can finish; unexpected RPC errors fail the journey.

The reservation probe restarts its synthetic DB connection and confirms one
durable backup destination, leaving an incomplete `.partial` at that owned path.
The first child SIGKILLs itself after verifying its backup, before any copy cursor
exists; the second reuses that backup and SIGKILLs after its first committed chunk;
the third requires the original verified backup and finishes the migration.
Assert exactly one backup file, no remaining partial, and unchanged backup mtime
at the reserved destination through both restarts. The reservation probe also
creates unrelated backup/manifest/partial sentinels and asserts their bytes remain
unchanged. Never sweep other paths or delete verified backups.
`observed.json` must show zero remaining legacy bodies, an empty suppression
table, the same full ordered logical-body hash, per-chunk transactions <250 ms,
maximum heartbeat lag <1,000 ms and successful health/transcript RPCs. Lag and
transaction maxima include all children. `reservation-retry.json`, `backup-crash.json`,
`crash.json`, `child.json` and logs retain all phases. Peak logical and allocated disk bytes are sampled across
the data tree every probe cycle, including the permanent backup and WAL; this
is a sampled peak, not a physical worst-case bound. Startup and overall runtime
are recorded separately. Seed and final offline hashing are outside daemon lag
measurement. A backup manifest mismatch or missing original backup must reject
verification without altering source bodies; `backup-rejection.json` records it.

Exercise the offline reverse tool only after both children stop:

```bash
env -i PATH="$PATH" NODE_ENV=test bun packages/daemon/scripts/restore-sdk-message-bodies.ts \
  "$RUN/data/daemon.db" --restore-legacy > "$RUN/evidence/reverse.log"
env -i PATH="$PATH" HOME="$RUN/home" HYPERNEO_DATA_DIR="$RUN/data" NODE_ENV=test \
  bun .claude/skills/verify/sdk-body-copy.ts inspect 9338 "$RUN" > "$RUN/evidence/reverse-after.json"
```

The reverse hash must match `before.json`. Side bodies and the pinned backup
remain; the reversed marker disables automatic copying. All children, workers
and sockets must stop; delete only this run's synthetic data after retaining
evidence. Unit suites run in CI, including insufficient/unknown disk refusal,
verification failure, runtime-capacity/worker refusal, durable backup reservation,
rollback, restart, authoritative-side conflicts, malformed
bytes and concurrent normal writers. No GUI, model or credentials are used.

Exercise the lifecycle/error boundary in another fresh directory (65-second
observation spans the former automatic retry interval):

```bash
RUN=$(mktemp -d /private/tmp/hn-sdk-copy-lifecycle-XXXXXX)
mkdir -p "$RUN/home"
env -i PATH="$PATH" HOME="$RUN/home" HYPERNEO_DATA_DIR="$RUN/data" NODE_ENV=test \
  bun .claude/skills/verify/sdk-body-copy-lifecycle.ts verify 9337 "$RUN"
```

`lifecycle.json` must show no copy logs after a delayed Space-ready callback runs
on a closed core; a corrupt synthetic backup manifest must produce one error-level
operator-action log with the backup path, one disk admission, no deferred retries,
responsive real health RPCs and unchanged complete logical-body hash. The manifest
is restored in `finally`; no verified backup is deleted. The same helper's
`reproduce` mode takes an optional baseline worktree as the final argument and
must observe the closed-DB warning plus two verification attempts across 65 s on
the unfixed code. Stop all owned daemons/workers and remove the baseline worktree.
Transient creation failures may retry; a verification failure requires operator
action and has no automatic retry. Never repair, delete or replace a live backup
to make the check pass.

The lifecycle helper also accepts a source-worktree path and a fault name as
its final arguments: `verify 9337 "$RUN" "$PWD" audit` or `path` exercises
disagreeing persisted copy hashes or an invalid original backup location.
Each fresh synthetic run observes 65 seconds: one error-level operator-action
log (including the pinned path), one disk admission, no retry, responsive health
RPCs and unchanged complete-body hash. `reproduce` against an unfixed worktree
must show two admissions/warnings instead. `reservation`, `json` and `shape`
faults additionally model a moved reservation, malformed JSON and invalid cursor
shape; CI also pins a cursor beyond its high-water mark. All stop before any backup worker starts, without changing the
stored marker or complete tool result. These are terminal state errors, not an
instruction to repair/delete any live marker or backup.

For slow-chunk handling use another fresh isolated directory and
`bun .claude/skills/verify/sdk-body-copy-slow.ts verify 9337 "$RUN"` with the same
cleared environment/own HOME/data-dir setup. It deliberately injects one 300 ms
synchronous delay into a synthetic copy UPDATE to cross the pause threshold;
this is a control-flow fault injection, not a physical disk performance result.
`slow-chunk.json` must show one backup verification, one `slow_chunk_pause`, no
deferred run, successful health RPCs and unchanged full-body hash after completion.
The same helper's `reproduce` mode on the unfixed source must observe a deferred
run and a second complete backup verification after 60 seconds. It records the
source-file SHA-256; no production clock/timeout is changed by the helper.
Shutdown during the cancellable pause is pinned in the CI contract. Slow chunks
pause asynchronously for one second inside the current run, preserving its
verified worker channel; a process restart still requires full backup verification.
Repeat the ordinary 90k-row journey separately for actual performance numbers.

Before merging, require Neo's explicit go-ahead, latest-head bot approval and
green CI. Read-only stat/free-space checks must show room for 2× the live DB
plus the permanent backup; the production admission itself requires 2× DB+WAL.
After automatic deployment, read live logs only: `disk_check_passed`,
`backup_verified` (path, bytes, `quickCheck: ok`, hashes), per-chunk progress,
`complete` (matching copy audit chains, runtime) and `run_finished` (max lag).
The copy hashes cover the full versions actually moved, transaction by
transaction, across resumes. Normal writes can change two whole-DB snapshots
online, so do not call that a static global-hash comparison. Report any missing
or failed evidence to Neo; do not restart, write to, or restore the live DB.
