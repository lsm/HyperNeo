# Build data-only ask settlement (#8712 core 4a)

Follow SKILL.md's resource guard and guarded metadata-only wrapper, with
existing dependencies and a fresh absolute evidence directory:

```sh
bash .claude/skills/verify/proof-run.sh "$EVIDENCE" .claude/skills/verify/ask-settlement-build.ts verify
```

This build rung leaves runtime callers unchanged. Before construction, the
same proof fails because the settlement worker commands are not registered.
It then runs real reader/writer workers and observes full Work cards through
`neo.ask.read` over WebSocket.

A late todo write failure must roll back the header, todos and card retirement
together, emitting no table changes. Hold a WAL lock: no receipt or notification
may precede commit, while card and health reads still answer. After release,
unfinished work is visibly closed unverified, never certified done; its entire
Unicode report remains in the receipt and public card. Current stop context
must retain the actual ask, worker ref, adopted status and live state without
stopping anything.

Split-parent settlement ends only an empty parent with children, leaving
child work and human cards unchanged. A retired child card with no pending
answer must release its needs-human hold through the existing #9072 state
policy. Units also pin a pending child answer retaining that hold, explicit
settlement overriding it, late changes to a prior snapshot, failure diagnostics,
missing/settled asks, late card failure and competing settlement attempts.

Repeated split settlement and stale explicit settlement must stay quiet.
The build must issue no Neo event or worker stop/dispatch, and admission/state
SQL must not execute on main. Run focused settlement, ask, state-policy and
session-repository tests, then the full check. The required Deno smoke runs
this same helper; local Deno is unverified if unavailable.

The helper closes its transport and daemon in finally, writes
`ask-settlement-build.json`, and the wrapper saves evidence before deleting
its synthetic HOME/data. No GUI, real provider, live database or latency-target
pass is claimed. Shared stop-context wiring and settlement caller activation
remain separate rungs.
