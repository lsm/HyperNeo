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
Inspect `fairness.json` and `requests.jsonl`; the wrapper saves evidence and
removes all disposable daemon data. No live daemon, real GitHub, model turn,
credentials or protected checkout is used. The helper refuses direct HTTP.
