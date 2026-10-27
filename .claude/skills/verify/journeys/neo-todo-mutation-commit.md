# Build atomic todo mutation commits (#8712 core 1b)

Use the shared guarded metadata-only wrapper from SKILL.md. Run from the task
checkout with existing dependencies and a fresh absolute evidence directory:

```sh
bash .claude/skills/verify/proof-run.sh "$EVIDENCE" .claude/skills/verify/todo-mutation-commit.ts verify
```

Before this build, the same proof fails because the writer operation is absent.
The fixed proof runs the registered command in the real daemon writer worker,
using only a synthetic HOME/database and refusing external network and GitHub.
No new public mutation RPC or runtime caller is activated in this slice.

A synthetic connection holds the WAL writer lock while a full-report edit is
queued. The command must stay pending, announce nothing, and leave the actual
public `neo.ask.read` card unchanged; `system.health` must still answer. After
releasing the lock, the committed receipt and public card contain the entire
Unicode report, and committed table notifications precede caller resumption.
This is a correctness proof, not a contention-latency target measurement.

The proof then changes a completion check before committing a previously
observed result, opens an unanswered todo card, injects a late SQL failure after
todo/card writes, and settles the ask. Stale completion and unanswered-card
attempts must be refused; rollback and settled-ask no-ops must announce nothing
and leave the public card unchanged. Todo mutation SQL must stay off main.

Run the atomic-commit, planning, completion and pack-boundary unit contracts,
plus the full repository check. Required Deno smoke runs this same helper;
local Deno is unverified when not installed. The helper closes all resources in
finally, writes `todo-mutation-commit.json`, and the wrapper saves evidence then
removes temporary proof data. GUI layout, real provider checks, runtime caller
activation, stop and next-work dispatch remain outside this build.
