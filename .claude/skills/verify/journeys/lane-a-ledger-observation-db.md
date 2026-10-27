# Ledger observations commit coverage and PR rows together

Use shared isolation and the resource guard in SKILL.md; heavy jobs run serially.

```sh
python3 .claude/skills/verify/lane-a-ledger-observation-db-run.py bun before
python3 .claude/skills/verify/lane-a-ledger-observation-db-run.py bun verify
python3 .claude/skills/verify/lane-a-ledger-observation-db-run.py deno verify --executable "$DENO"
```

DENO names an existing runtime with cached imports. Every run owns a fresh
synthetic HOME/data/TMPDIR, daemon and ephemeral non-8399 listener. HTTP is refused.
A gh fixture answers only synthetic REST/GraphQL reads and logs its requests.
No credentials, live daemon/data, model or GUI is involved. The runner retains
proof evidence before removing temporary daemon data. Before mode restores the
old ledger implementation from origin/dev, then restores the draft in finally;
do not edit concurrently. Commit failing evidence before the fix.

Real persisted daemon jobs invoke reconcileCodingPrLedger with its production
collector and synthetic GitHub responses. A trigger rejects PR insertion after a
complete response. The job must fail without advancing coverage health or
changing PR rows. The baseline advances completeAt despite rejected persistence.
CI also asserts this observable rejection through the reconciliation API.

Invalid coverage preserves prior PR rows and raises one incident after three
misses. Rate-limited reads retain their account/resource deadline, and a tail
sharing that account records cooldown without another miss. Restart retains
health; cooldown makes no additional reads, and expiration resumes polling and
complete empty coverage recovers. Protected polling history is unchanged.

Polling order/context use reader snapshots. After each external response, one
writer command rechecks watches, derives policy/health, records aliases/health
and replaces PR rows together. Logging happens after commit. No transaction
spans external collection. Existing final prune/owner commands remain separate.

During jobs, instrument coding tables and pack preferences on the main connection.
Fixtures and assertions are excluded. Fixed runs require zero target SQL on main;
before mode requires target SQL. Evidence retains command duration and argument/
reply sizes without separate SQL, queue or cloning attribution. This proves
reconciliation jobs with synthetic external data, not a full pack sweep, actual
GitHub quota savings, Neo delivery, GUI, whole-daemon SQL absence or latency goals.

The fixed helper also holds a synthetic writer lock while reading the polling
snapshot and context. Both finish before release; the reader needs no writer
reservation. CI uses cloned gateway arguments/replies, read-only reader commands
and a main connection that refuses SQL. Competing observations produce one state
transition; unwatching during collection rejects the response without updating
coverage or stored PR state.

The original `bun-verify` directory is the deliberately failing pre-fix run,
committed in the regression commit despite its mode name. It records 53 target
main SQL statements and coverage advancing after rejected PR persistence.
`deno-verify` is an inconclusive fixture launch failure: its synthetic gh used
Deno as a bare shebang interpreter. The corrected fixture uses existing Bun for
only that stub; the daemon and worker proof still runs under the selected runtime.
`observed.json.proofBinding.runs` identifies the final passing Bun and Deno pair.

After the bound proof commit, change only this journey and its evidence directory.
Check the committed application trees, helper blobs, run heads and post-proof
change list before pushing:

```sh
bun --no-install --no-env-file .claude/skills/verify/lane-a-ledger-observation-proof-binding.ts HEAD
```

No health/affected RPC latency, RSS or WAL benchmark is claimed. Gateway command
durations and JSON byte sizes do not separately measure queue, SQL or clone time.

The current binding was refreshed after merging dev with the approved stage-target
reader. Both runtime proofs identify that merged code head. Only the registry
append conflicted; the resolution preserves the base reader and this slice's
reader. Against the base, the shared-file diff remains exactly the granted import
and DB_OPS entry. Prior successful proof bindings remain historical.

Dev advanced again with the inventory readers for sweep/daily counts (#9218).
The second merge retained its public read facade and op registration. The
reconciliation conflict uses this slice's whole polling snapshot/context; its
per-response writer remains atomic. Both runtimes were refreshed on that merged
commit, and the neighboring sweep/daily-count contracts were included in checks.
This merge does not claim a fresh execution of #9218's separate full-pack journeys.

A subsequent dev advance added the turn-vector writer (#9208). Its import and
registration are preserved. This slice's granted import now follows the existing
imports, avoiding first-line insertion conflicts; its DB_OPS entry remains
appended. Against the base the shared diff is exactly two added lines. Final
runtime runs identify the new committed code; earlier pairs remain historical.
