# Remove a todo through the DB writer (#9002)

Use SKILL.md's guarded metadata-only wrapper with fresh absolute evidence
directories and existing dependencies:

```sh
bash .claude/skills/verify/proof-run.sh "$EVIDENCE" .claude/skills/verify/todo-remove-writer.ts verify
bash .claude/skills/verify/proof-run.sh "$STOP_EVIDENCE" .claude/skills/verify/todo-stop-context.ts verify
```

The removal helper restores the public-RPC proof from superseded #9014 against
the planner/writer activation merged in #9036. A late ask-stamp failure must
roll back the todo state and human card together. Successful removal must
remain visible in neo.snapshot and preserve the entire 850000-byte report in
both the receipt and the opened neo.ask.read card. Matching todo, ask, question
and session SQL must stay off main.

An independent WebSocket observer must receive exactly one neo.changed after
commit and refresh to the removed state. The internal subscriber receives one;
rollback emits neither. A held 1.2-second WAL lock must leave health responsive.
The affected write still exceeds 250 ms: record that failure explicitly rather
than claiming the contention latency target passed.

The shared stop-context helper additionally exercises real remove RPCs with a
scripted work.stop boundary. Stop failure leaves the public card unchanged,
adopted workers receive no stop, and settled asks are accepted no-change
receipts. A valid todo replacement stays linked. Deleting that replacement
and writing a full report during stop must produce replacement_missing,
remove without a stale link and preserve the concurrent report in the receipt
and opened card. This is distinct from replacing the worker session reference.

Required Deno smoke runs both helpers. Repeat locally with
VERIFY_PROOF_RUNTIME=deno when Deno is installed. The wrapper saves evidence
JSON/logs and removes synthetic daemon data after each helper cleans up.
No real worker stop delivery, provider turn, GUI layout, credentials or external
GitHub request is exercised; label those unverified. No new production wiring
is needed for this journey.
