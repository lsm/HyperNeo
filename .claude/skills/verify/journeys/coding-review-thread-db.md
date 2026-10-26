# Review-thread observation commands on the DB gateway

Use the existing checkout and installed runtimes only. Run each heavy job
serially after the shared resource check. The runner refuses less than 25%
free memory or 25 GiB free disk; no install, simulator or live daemon is used.

```sh
python3 .claude/skills/verify/coding-review-thread-db-run.py bun before
python3 .claude/skills/verify/coding-review-thread-db-run.py deno before --executable "$DENO"
python3 .claude/skills/verify/coding-review-thread-db-run.py bun verify
python3 .claude/skills/verify/coding-review-thread-db-run.py deno verify --executable "$DENO"
```

DENO names an existing Deno executable. Deno uses cached modules only. Each run
owns a fresh HOME/data/TMPDIR, a fresh SQLite database and an ephemeral non-8399
daemon. Synthetic gh refuses unknown commands; direct HTTP throws. Provider
credentials, real GitHub, live databases, browser/model turns and Git writes are
not involved. Raw JSON is saved before immediately removing temporary daemon
data. The helper closes both daemon instances in finally.

Before mode temporarily restores only the two connector reader files from the
pinned dev revision, then restores the draft in finally. Do not run it alongside
an edit, test, check or another proof. Fixture SQL and row assertions are excluded
from the measurement window. Runtime, source head, resource guards and cleanup
are recorded in each run.json.

The proof sends actual neo.coding.merge.prepare requests through the daemon's
WebSocket operation RPC. No assignments are seeded: the production operation
refuses after collecting GitHub facts. The persisted review-thread observations
and errors are asserted; no successful merge eligibility or external merge is
claimed. Five concurrent demands share one two-page GitHub acquisition and one
committed observation. Later demands refresh and advance only observation
revision when value is unchanged. Failed transport, incomplete pagination and
head changes preserve prior successful JSON and success time. Aliases use one
canonical subject. Reopen retains the exact row before the next refresh.

A held late RPC acquisition cannot replace a newer committed writer observation.
The stale receipt returns accepted=false with the same winning snapshot. A
separate process then holds the synthetic WAL writer for 1.2 seconds during an
actual merge-prepare RPC. system.health must remain below 250 ms and loop lag
below one second. The affected RPC necessarily exceeds 250 ms under that lock;
retain this latency miss instead of changing durability or timeout policy.

Main instrumentation covers all poll-fact SQL plus connector identity alias
reads. Fixture SQL is excluded; no whole-daemon SQL absence is claimed. Gateway
elapsed timing and argument/reply sizes are retained, without separate queue,
SQL and clone attribution. Basic connector PR observation writes and other
row-26 families are separate follow-ups.

The committed regressions reject target SQL on main and reject read-only main
writes despite a bound writer. Focused CI-runner tests also preserve paginated
coverage, rate limiting, head identity, one-winner fencing, failure history and
production hook behavior. The shared connector target's host validation still
precedes database/GitHub access.

The latest observed.json proofBinding names one committed application tree for
both runtime proofs and retains packages/scripts trees and helper blobs. After
that commit only this journey and this evidence folder may change. Audit the
final candidate explicitly:

```sh
bun --no-install --no-env-file .claude/skills/verify/coding-review-thread-proof-binding.ts HEAD
```

The audit verifies ancestry, unchanged application trees/helper blobs, both
successful runtime proof receipts and the full post-proof change list. A source,
test or helper change requires a new committed proof head and fresh runs.
