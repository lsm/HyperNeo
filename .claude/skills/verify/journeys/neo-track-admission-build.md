# Build atomic human Track admission (#9122)

Use SKILL.md's guarded metadata-only wrapper with existing dependencies and a
fresh absolute evidence directory. No model, real GitHub, browser, native app or
port 8000 preflight is needed. The helper owns an ephemeral non-8399 daemon,
fresh HOME/database and a refusing GitHub stub; external HTTP is disabled.

```sh
bash .claude/skills/verify/proof-run.sh "$EVIDENCE" .claude/skills/verify/neo-track-admission-build.ts verify
```

The committed baseline fails because the registered writer command is absent.
The fixed proof invokes that command through the real writer worker, then reads
the complete Work card through the public neo.ask.read operation. Human Track
callers stay unchanged in this construction slice; their activation and complete
RPC SQL boundary belong to 5b. Leave #8998, #9002 and #8712 open.

Require current-root and duplicate admission inside the same transaction as ask,
todo, adopted worker ref/link, follow anchor and doing state. A 324000-byte Unicode
title must preserve its bytes/hash in the committed receipt and public card.
The receipt must include the committed worker ref/link. Two competing jobs for
the same ref have one winner; a missing root or duplicate produces no partial
card or mutation notification. A late follow-anchor SQL failure rolls back the
whole card. Changing the root binding before admission must select that root.

A held synthetic WAL writer must keep the receipt and notifications pending;
public card and system.health reads remain responsive. Record the affected
duration, health latency and main-loop lag. The worker timing begins after
BEGIN IMMEDIATE acquires its lock: queueLockAndTransitMs includes lock waiting,
not just queue time. A held 1200 ms lock necessarily misses the 250 ms affected
write target; report that miss without early success or replay. RSS and WAL size
are end-of-run samples, not peak measurements.

The main-SQL guard is installed before daemon startup and wraps selected statement
execution, including cached handles, plus exec. Its cached-statement canary must
fail before measurement; actual registered command calls must execute zero target
SQL on main. The placeholder main operation throws if worker routing falls back.

Worker failure before dispatch must reject without a card or main fallback. A
real worker whose committed reply is discarded must report outcome unknown;
public state must show exactly one card, with no automatic replay and an explicit
repeat refused by authoritative duplicate admission. No driver start/send/stop
or external notification delivery belongs inside the command.

Run the new transaction tests with the existing human Track compatibility tests
and the full repository check. Deno smoke registers this same helper; label local
Deno unverified when unavailable. Independent Verify uses the recorded contract
and exact PR head. Retain neo-track-admission-build.json, proof.log and wrapper
exit status; require exit zero and no closed-database errors. The helper closes
its workers, socket and daemon, and the wrapper saves evidence before removing
the temporary HOME/data. Post-merge smoke checks the containing build's internal
command/public reader; live human Track activation is not claimed by this slice.
