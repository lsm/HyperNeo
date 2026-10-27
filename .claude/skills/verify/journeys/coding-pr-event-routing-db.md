# Pending PR event routing through the DB gateway

Use the shared resource guard and isolation setup in SKILL.md. Reuse the
existing checkout and runtimes, running heavy jobs serially.

```sh
python3 .claude/skills/verify/coding-pr-event-routing-db-run.py bun before
python3 .claude/skills/verify/coding-pr-event-routing-db-run.py deno before --executable "$DENO"
python3 .claude/skills/verify/coding-pr-event-routing-db-run.py bun verify
python3 .claude/skills/verify/coding-pr-event-routing-db-run.py deno verify --executable "$DENO"
bun --no-install --no-env-file .claude/skills/verify/coding-pr-event-routing-proof-binding.ts HEAD
```

DENO names an existing runtime, with cached-only imports. Every run owns a
fresh synthetic HOME/data/TMPDIR and real daemon on an ephemeral non-8399 port.
HTTP throws and gh refuses all commands. No keys, live database, actual Neo
mailbox, model, browser or external service is involved. Save evidence before
immediately deleting temporary daemon data. Before mode restores pr-events.ts
from origin/dev and restores the draft in finally; do not edit concurrently.
The observable guarded-main regression is committed before the fix.

A synthetic persisted daemon job invokes the production PR-event delivery
pipeline on a synthetic merged PR. The real job processor claims and settles
it. A receiver records the destination, stable event key and message after
checking that the event remains durable. It first refuses delivery; repeated
jobs retain the same event and key. Reopening the daemon preserves the pending
event. Two overlapping delivery calls share the existing exclusive sequencer:
only one accepted notification occurs and its matching acknowledgement clears
the pending event. A large Unicode event body crosses the reader and writer
boundaries unchanged: confirmation must match its complete immutable JSON.
Later calls do not resend.

A newly seeded pending event is suppressed when its repository is unwatched.
Rewatching enables delivery again. During that notification the fixture changes
the owner: the old owner's acknowledgement must not clear the pending event.
The next job routes to the successor and clears only the matching receipt.
Existing tests cover owner/head changes and terminal-event identity guards.
No test asserts exactly-once delivery across an external accepted-but-lost
receipt; that uncertainty and retry policy are unchanged.

Instrument pack_coding_pr_ledger, neo_pack_preferences and
pack_coding_repo_aliases on main while delivery jobs run. Fixture and assertion
queries are excluded. Baseline requires target SQL; fixed runs require zero.
Pending event selection and watch filtering share one reader snapshot. Each
fresh destination lookup also runs through the gateway, outside notification
waits. The existing writer confirmation keeps its head/state/owner/event CAS.
This is not an entire coding-pack sweep or whole-daemon SQL absence proof.
Command elapsed times and argument/reply sizes are retained without separate
SQL, queue and clone attribution; no latency target or GUI claim is made.

Run the writer regression, existing PR-event and watched-repository tests in
Bun and the CI runner, plus full checks. Evidence binds one committed source
and helper tree to both successful runtime proofs. After that commit only this
journey and its evidence folder may change; other edits require fresh proofs.
