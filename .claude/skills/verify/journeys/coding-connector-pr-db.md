# Basic connector PR observation commands on the DB gateway

Use the existing checkout, installed runtimes and the shared resource guard in
SKILL.md. Run one proof or check at a time; the runner refuses memory below 25%
or free disk below 25 GiB and never installs dependencies.

```sh
python3 .claude/skills/verify/coding-connector-pr-db-run.py bun before
python3 .claude/skills/verify/coding-connector-pr-db-run.py deno before --executable "$DENO"
python3 .claude/skills/verify/coding-connector-pr-db-run.py bun verify
python3 .claude/skills/verify/coding-connector-pr-db-run.py deno verify --executable "$DENO"
bun --no-install --no-env-file .claude/skills/verify/coding-connector-pr-proof-binding.ts HEAD
```

DENO selects an already installed Deno; its imports are cached-only. Every run
owns a fresh HOME/data/TMPDIR and a synthetic SQLite database. The real daemon
binds an ephemeral port and refuses 8399. Fake gh accepts only the synthetic PR
lookup, refuses other requests and never discovers credentials. Direct HTTP
throws. Provider keys, live databases, model turns, browser sessions and actual
GitHub requests are absent. Save JSON before immediately removing daemon data.

Before mode temporarily restores only connector-pr-reader.ts from origin/dev,
then restores the draft in finally. Do not edit or run another job concurrently.
It must retain target SQL on the main connection. The failing bound-writer
regression is committed before the source fix.

The fixture enqueues real persisted jobs and lets the actual daemon job
processor claim, execute and complete them. Each synthetic job invokes the
production HookExecutor with the built-in pr_merged validator and the exact
reader wiring used by TaskAgentManager. This proves production hook behavior
through a synthetic job wrapper; it does not create a real workflow run or
claim task-agent dispatch, successful merge admission, GitHub merging or GUI
acceptance. All job outcomes are observed from settled queue records.

Five simultaneous hook demands must share one GitHub acquisition and one
committed observation. A sequential demand refreshes, and a recent MERGED-to-OPEN
change refuses the hook. Failed transport, incomplete payload and mismatched PR
identity preserve prior successful JSON and observation time while refusing.
Aliases share the canonical subject; reopening the daemon retains the exact row.
A delayed acquisition loses against a newer committed observation; the stale
write is refused and returns the same winning snapshot. system.health is called
through the real WebSocket RPC while the GitHub acquisition is held and must
reply below 250 ms. This is not a held-writer contention latency claim.

Main SQL instrumentation covers poll-fact and repository-alias SQL. Fixture
setup/assertion SQL is excluded. Verify mode requires zero target SQL on main;
no whole-daemon SQL absence is claimed. Gateway elapsed times and argument/reply
sizes are retained without separate SQL, queue and clone attribution.

Run the bound-writer, connector PR ledger and workflow connector suites in the
CI runner plus full checks on the final application. The evidence binding names
one committed application tree for both runtime proofs. After that commit only
this journey and its evidence folder may change. The audit verifies ancestry,
application trees, helper blobs, successful receipts and the complete post-proof
change list. Any source, test or helper edit requires a new committed proof head
and fresh Bun/Deno runs. No deployment or live-owner restart is authorized.
