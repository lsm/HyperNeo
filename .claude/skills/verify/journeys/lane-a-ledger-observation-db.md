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
