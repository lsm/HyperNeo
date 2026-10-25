# Work observations through the DB gateway

Run from the existing checkout using only installed dependencies. The runner
prints data-volume space and refuses to run below 25 GiB free:

```sh
python3 .claude/skills/verify/coding-work-db-run.py bun before
python3 .claude/skills/verify/coding-work-db-run.py bun verify
python3 .claude/skills/verify/coding-work-db-run.py deno before --executable "$DENO"
python3 .claude/skills/verify/coding-work-db-run.py deno verify --executable "$DENO"
```

Set `DENO` to an existing Deno 2.9.4 executable. No runtime or dependency
installation occurs; Deno accepts cached modules only. Each invocation creates
its own synthetic HOME, TMPDIR and DB, starts an ephemeral non-8399 daemon,
and refuses real HTTP and unsupported GitHub commands. No model, provider,
credentials, UI, existing database or real GitHub request is needed.
Evidence JSON and synthetic gh records are copied to a unique folder under
`evidence/coding-work-db/` before the entire temporary daemon directory is
immediately removed. The runner records cleanup and available disk space.

Before mode temporarily restores only `work-facts.ts` from the pinned
origin/dev revision and restores the draft in finally. Run proofs sequentially;
do not run before mode alongside tests or checks. Both runtimes must reproduce
work SQL on main before migration and record zero afterward. Fixture assertions
are excluded from the measurement; identical alias SQL in other fact families
is distinguished by its calling source frame.

Drive the real `neo.github.read` WebSocket operation with five concurrent PR
reads. They must share one work-detail acquisition with no separate reference
lookup. Then change the head and require a fresh view without stale approval;
fail detail acquisition and require unreadable coverage while retaining the
last JSON; reopen the daemon and require retention and successful reacquisition.
Also exercise host/fragment normalization, issue detail and an issue-form PR
redirect through the same public operation.

The fixed run holds a collector until a newer observation commits through the
real writer. The older response must return the winner and leave its revision
unchanged. A separate process then holds the synthetic WAL writer for 1.2
seconds while `system.health` runs over the real WebSocket. Health must finish
under 250 ms and event-loop lag below one second. Writer completion must still
honor the held lock. Both the intentionally delayed 300 ms upstream read and
held write miss the 250 ms affected-operation target; retain those misses in
evidence rather than claiming a full latency pass.

The failing regression commit precedes the fix. Focused unit cases additionally
cover invalid input without upstream work, revision fencing, failed persistence,
three bounded busy attempts, coalescing across retries and a later fresh retry.
The existing work-ledger cases remain unchanged. `observed.json` summarizes the
baseline runs and fixed runs, including the post-rebase repetitions; their raw JSON and request records are the source evidence.
