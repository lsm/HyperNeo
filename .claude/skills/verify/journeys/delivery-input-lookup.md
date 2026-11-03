# Indexed worker delivery history

Use SKILL.md's metadata-only proof wrapper and resource guard:

```sh
bash .claude/skills/verify/proof-run.sh /absolute/fresh/evidence-directory \
  .claude/skills/verify/delivery-input-lookup.ts
```

The helper owns an isolated daemon, synthetic HOME/database and ephemeral peers.
It seeds 1,466 retained delivery inputs with roughly 5 MB of instruction text and
small JSON outcomes, matching the measured retained-history scale without copying
production data. Before starting the daemon, it removes only the synthetic lookup
index and its migration marker to reproduce the old scan and temporary sort.
Normal daemon startup must upgrade that populated file, preserve exactly the same
ordered IDs and remove both. No schema is changed while the daemon is running.
Save the EXPLAIN plans and 20 before/after lookup
durations in observed.json. Timings are observations, not a flaky CI threshold or
a claim to reproduce a production machine's 1.3-second outlier.

Keep the fixture present while the real driver-refresh job reconciles completed
worker turns. Require the real work.status RPC, exact full Unicode report on the
todo and in Neo's stored inbox, and no extra report when the same terminal record
is observed twice. This proves the consumer of the lookup, not just an isolated
SQL example. Unit coverage additionally proves a populated upgrade is
byte-preserving and repeatable, local missing/null daemon matches remain distinct
from empty/remote values, equal-time row order is preserved, and other adapters,
failed outcomes and pending inputs do not match.

The wrapper saves proof.log and observed.json before removing temporary data;
the helper closes all its listeners and daemons. No live daemon, model, installed
desktop app or production credential is involved. The index addition does
not change retry, replay, delivery admission or scanner behavior.

The recipient inbox is the acceptance surface; no provider is registered, so
model consumption and GUI rendering are not claimed. The broader worker-turn
journey's new-terminal-ID replay check is a separate contract, not replaced by
this same-terminal observation proof.
