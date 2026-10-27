# Unowned PR reservation and confirmation on the writer

Follow the shared resource guard and isolation rules in SKILL.md. Reuse the
checkout and installed runtimes, and run each heavy job serially.

```sh
python3 .claude/skills/verify/coding-unowned-db-run.py bun before
python3 .claude/skills/verify/coding-unowned-db-run.py deno before --executable "$DENO"
python3 .claude/skills/verify/coding-unowned-db-run.py bun verify
python3 .claude/skills/verify/coding-unowned-db-run.py deno verify --executable "$DENO"
bun --no-install --no-env-file .claude/skills/verify/coding-unowned-proof-binding.ts HEAD
```

DENO must identify an installed runtime; imports use cached-only mode. The runner
refuses memory below 25% or disk below 25 GiB. Before mode restores only
pr-events.ts and pr-unowned.ts from origin/dev and restores the draft in finally;
never edit or run another job concurrently. The failing guarded-main and
read-only-main regressions are committed before the source fix.

Every proof owns a fresh HOME/data/TMPDIR and database. A real daemon listens on
an ephemeral non-8399 port; fake gh refuses all commands and direct HTTP throws.
No keys, real GitHub, model turn, browser, installed Desktop or live database is
used. The runner saves evidence and removes temporary daemon data immediately.

The actual job processor claims and settles persisted synthetic jobs. Their
handler invokes the production coding pack sweep with synthetic repository
facts. PR ledger updates, unowned selection, reservation, watch filtering and
confirmation use production code. The notification receiver checks that the
reservation is already committed before recording the attempted wake key; it
may refuse or accept. This is a test receiver, not actual Neo mailbox delivery
or a model response. No real workflow or PR merge is started.

Two new human PRs appear in one notice; draft, bot and pre-activation PRs do not.
A refused notification retains its batch and retries with the same stable key,
without relisting. Reopen preserves the exact batch and listed rows. An accepted
retry clears only its matching pending key; subsequent sweeps do not wake again.
The committed focused suites also retain owner exclusion, watch/alias changes,
restart and pending-batch filtering. Production notification effects occur after
reservation commit, and confirmation runs only after accepted delivery.

Main SQL instrumentation covers pack_coding_pr_unowned and its state table.
Setup and assertion SQL are excluded. Before mode must observe target main SQL;
verify mode requires zero. Worker commands retain whole reservation transactions
including their reads. This is not whole-daemon SQL absence or a latency claim.
Gateway elapsed time and argument/reply sizes are retained without separate
SQL, queue and clone attribution.

Run the new writer regression, unowned PR and watched-repository suites in the
CI runner plus full checks. The proof binding identifies one committed
application for both runtime proofs. After that commit only this journey and
its evidence folder may change. The audit checks ancestry, application trees,
helper blobs, successful run receipts and the complete post-proof change list.
Source, test or helper edits require a new committed proof head and fresh runs.
