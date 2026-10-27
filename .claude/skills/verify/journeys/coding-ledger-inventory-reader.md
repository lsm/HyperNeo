# PR sweep and daily counts read ledger inventories off main

Follow SKILL.md's shared resource, isolation and cleanup rules. Use pinned Bun
1.4.2 and fresh absolute evidence directories. No provider, live data, simulator,
real GitHub or GUI is used; acquisition uses the refusing synthetic gh fixture.

```bash
TMPDIR=/private/tmp bash .claude/skills/verify/proof-run.sh /absolute/fresh/sweep-evidence .claude/skills/verify/coding-ledger-slim.ts off-main
TMPDIR=/private/tmp bash .claude/skills/verify/proof-run.sh /absolute/fresh/daily-evidence .claude/skills/verify/daily-dropped-work.ts off-main
```

The first helper forbids lastReads/list SQL on the daemon main connection while
twelve synthetic five-minute sweeps preserve PR review, CI, merge and owner
transitions through neo.snapshot RPC. It must record zero mainSql entries in
slimming.json while retaining its acquisition budget. Before the fix it fails
at the first lastReads query. This is off-main routing proof on ordinary data,
not a production query-speed measurement or physical-storage attribution.

The second helper forbids list SQL on every opened main connection. It drives
real pack sweeps and reads the human conversation through WebSocket RPC. The
daily publication must include the ready-to-merge count; restart must not repeat
it, and the next day must preserve history. A failed pack still reports unavailable
without suppressing core or healthy counts. Before the fix the coding hook
reports unavailable and the required ready-count assertion fails. result.json
retains the publications. Both wrappers save logs and remove synthetic data.
