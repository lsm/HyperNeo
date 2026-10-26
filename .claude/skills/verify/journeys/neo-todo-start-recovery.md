# Build atomic interrupted-start recovery (#8712 core 3a)

Use SKILL.md's resource guard and guarded metadata-only wrapper with existing
dependencies and a fresh absolute evidence directory:

```sh
bash .claude/skills/verify/proof-run.sh "$EVIDENCE" .claude/skills/verify/todo-start-recovery.ts verify
```

Before construction, the same proof fails because the internal writer command
has no recovery method. This build rung leaves runtime recovery callers
unchanged. It executes only the internal command in a real writer worker and
observes its complete Work cards through `neo.ask.read` over WebSocket.

An injected late ask-stamp failure must roll back the interruption flag, state
and question pruning together, without table notifications. Under a held WAL
lock there must be no early receipt or notification; card and health reads
must still answer. Once committed, the full Unicode report survives on the
failed card. The real `neo.todo.retry` operation must refuse with
`start_uncertain`, so the user cannot accidentally open a duplicate worker.

A worker ref bound after candidate discovery must keep its doing card and
must not acquire an interrupted flag. Repeated, missing and competing recovery
calls must produce at most one transition. The build sends no Neo event or
worker dispatch, and recovery admission/state SQL must not execute on main.

Units also cover current todo/done/blocked/failed/removed/closed-unverified
states, failure escalation and the existing settled-ask removal policy. Run
these alongside runner/state-writer and recovery controls, then the full check.
The required Deno smoke executes this same helper; mark local Deno unverified
if it is unavailable rather than claiming a local pass.

The helper closes its transport and daemon in finally and writes
`todo-start-recovery.json`. The wrapper saves evidence and removes the fresh
synthetic HOME/database. No real provider, worker, browser, live database or
latency-target result is claimed. Caller activation and after-commit notice
verification belong to the next rung.
