# Empty targets rotate and quota failures stay with their credential

Use the shared isolated setup in `../SKILL.md` and run:

```bash
TMPDIR=/absolute/writable/temp bash .claude/skills/verify/proof-run.sh \
  /absolute/fresh/evidence .claude/skills/verify/coding-ledger-fairness.ts verify
```

The helper owns an isolated daemon, synthetic DB and refusing GitHub CLI fixture.
It seeds a healthy PR, then completes a newer empty scan. On the next scan the
older healthy target must run first. The empty target then exhausts its own core
bucket while the healthy target's distinct account still reports CI failure.
The public snapshot RPC must show that failure, the healthy target must retain
complete coverage, and no PR row may be invented for the empty target.
Then recreate the limited reader and scan the limited target first. Its persisted
account/core cooldown must still apply without another eligible miss, while the
following healthy account's CI recovery appears through snapshot RPC. This
separately proves quota isolation rather than relying only on scan ordering.
Account scope is learned through the non-secret CLI `user` response, cached for
one five-minute sweep. Unknown identity is never assumed to share a bucket.
Actual response resource, remaining/reset and Retry-After determine the scoped
cooldown; a separate quota overview cannot override contradictory response headers.
The companion health-wire journey recreates its reader across daemon restart
and verifies persisted same-account/core cooldown and recovery. Unit checks
also cover credential changes, core versus GraphQL resources and unknown identity.
Inspect `fairness.json` and `requests.jsonl`; the wrapper saves evidence and
removes all disposable daemon data. No live daemon, real GitHub, model turn,
credentials or protected checkout is used. The helper refuses direct HTTP.
