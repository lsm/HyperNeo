# Activate runner recomputation and start claims (#8712 core 2b)

Follow SKILL.md's resource guard and guarded metadata-only wrapper with existing
dependencies and a fresh evidence directory:

```sh
bash .claude/skills/verify/proof-run.sh "$EVIDENCE" .claude/skills/verify/todo-runner-activation.ts verify
```

This journey runs the actual runner with the daemon's writer worker and a
synthetic dispatch port. Its cards are read through the public `neo.ask.read`
RPC. Before activation, an injected late ask-stamp failure leaves the start
card retired; the saved red proof must fail on that visible difference.
After activation, a failed recomputation or claim preserves the entire card
and emits no change notice or dispatch.

A held WAL lock must delay completion and all effects. After release, the
runner must preserve the complete Unicode report and dispatch its successor
once, using the current stored target. Pruning alone announces a change;
repeated no-ops and a settled ask remain quiet and retain successful receipts.
Competing claims dispatch once. Admission/recomputation execute without main
SQL; the later dispatch preparation and session observation still use existing
main-thread reads and are outside this slice's SQL claim.

The helper also invokes `neo.todo.retry` over the real WebSocket operation
door. Only the work driver operations are replaced by synthetic responses.
The real Neo service must commit the claim before the scripted driver sees
it, and must not use either legacy main-thread claim/recompute method.
No provider, browser, real worker or external service participates.

Unit regressions additionally hold a committed claim's return while recovery
runs: recovery must not mark that active start interrupted. A stale completion
queued behind a changed check must not finish the todo. Run the affected
runner, completion, issue-check and bookkeeping suites and the full check.
The required Deno smoke runs this same helper; local Deno proof is unverified
when that runtime is unavailable.

The helper closes its transport and daemon in finally, writes
`todo-runner-activation.json`, and the wrapper saves evidence before removing
its synthetic HOME/database. This proof makes no latency-target claim.
