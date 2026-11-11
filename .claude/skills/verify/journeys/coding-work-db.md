# Work observations through the DB gateway

Run from the existing checkout using only installed dependencies. The runner
prints data-volume space and refuses to run below 25 GiB free:

```sh
python3 .claude/skills/verify/coding-work-db-run.py bun verify
```

Each invocation creates its own synthetic HOME, TMPDIR and DB, starts an ephemeral
non-8399 daemon, and refuses real HTTP and unsupported GitHub commands. No model,
provider, credentials, UI, existing database or real GitHub request is needed. Evidence
JSON and synthetic gh records are copied to a unique folder under
`evidence/coding-work-db/` before the entire temporary daemon directory is immediately
removed. The runner records cleanup and available disk space.

Use verify mode for the current checkout. The runner also retains its historical
before mode for DB migration comparisons. Run proofs sequentially. The current
run must record zero work SQL on main. Fixture assertions are excluded from the
measurement, and identical alias SQL in other fact families is distinguished by
its calling source frame.

Read one PR and one issue through the coding skill's `gh pr view` and
`gh issue view` commands against the synthetic CLI. Then drive the retained
work-fact reader with five concurrent PR reads and require one shared acquisition.
Change the head and require a fresh view without stale approval. Fail detail
acquisition and require an unknown result while retaining the last JSON. Reopen
the daemon and require retention and successful reacquisition. The helper records
CLI reads separately from ledger acquisitions, and authenticates health RPC with
its disposable daemon's local credential. It exercises the current skill and ledger read paths.

The fixed run holds a collector until a newer observation commits through the
real writer. The older response must return the winner and leave its revision
unchanged. A separate process then holds the synthetic WAL writer for 1.2
seconds while `system.health` runs over the real WebSocket. Health must finish
under 250 ms and event-loop lag below one second. Writer completion must still
honor the held lock. Both the intentionally delayed 300 ms upstream read and
held write miss the 250 ms affected-operation target; retain those misses in
evidence rather than claiming a full latency pass.

The failing regression commit precedes the fix. Focused unit cases additionally cover
invalid input without upstream work, revision fencing, failed persistence, three bounded
busy attempts, coalescing across retries and a later fresh retry. The existing work-ledger
cases remain unchanged.
