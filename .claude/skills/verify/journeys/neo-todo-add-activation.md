# Atomic built-in todo creation (#8712)

Use SKILL.md's guarded metadata-only wrapper with existing dependencies and a
fresh absolute evidence directory:

```sh
bash .claude/skills/verify/proof-run.sh "$EVIDENCE" .claude/skills/verify/todo-add-activation.ts verify
```

This owns an isolated daemon, real reader/writer workers, the actual todo-add
WebSocket RPC, ask-open agent MCP handler and public Work-card reader. It uses
no model, native worker, browser, real GitHub, credentials or port 8399.

The committed red proof fails on a visible partial todo after a synthetic late
start-question insert failure. Fixed code must leave the entire public card and
notifications unchanged on rollback. Hold the writer for 1.2 seconds when the
public add reaches its commit: receipt and notification must remain pending,
while health and the current card still answer. Release the lock and require
the receipt to match the committed blocked state, preserve the complete Unicode
instruction/hash and notify connected clients. Report affected write latency
against 250 ms separately from health and max loop lag; the held write misses
that target. RSS/WAL are end samples; peaks and phase timings are unverified.

Concurrent public additions must retain every selected todo in one start card.
An injected writer failure must reject with unchanged public state and no main
fallback. The cached-statement canary must fail before measurement; require zero
target main SQL throughout the built-in public todo-add calls. Ask-open must
call the same writer and retain additions to open child cards after their split
parent settles. Its other family/creation/routing reads remain on main and are
outside this slice's SQL claim. Custom callback policies remain an explicit
unported route selected by pack identity, never a fallback after worker failure.

Run the build journey as well for real worker-death/lost-reply boundaries. Run
the unchanged target-resolution, child-routing, bookkeeping and PR-admission
regressions plus full repository checks. The add receipt now describes current
persisted state rather than the legacy pre-blocked snapshot. Deno smoke runs
this same helper; label local Deno unverified when unavailable.

Keep todo-add-activation.json, proof.log and wrapper exit status. Require clean
worker/daemon shutdown and exit zero. Temporary HOME/data are removed after
evidence is saved. External worker dispatch, browser layout and the 250 ms
contention target are not verified. Keep #8712 open for remaining routes/deletion.
