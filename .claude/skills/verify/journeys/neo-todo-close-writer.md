# Close a todo through the DB writer

Use SKILL.md's guarded metadata-only wrapper with fresh absolute evidence
directories and a writable TMPDIR:

```sh
bash .claude/skills/verify/proof-run.sh "$BEFORE_EVIDENCE" .claude/skills/verify/todo-close-writer.ts before
bash .claude/skills/verify/proof-run.sh "$AFTER_EVIDENCE" .claude/skills/verify/todo-close-writer.ts verify
```

The real neo.todo.close RPC must first reproduce a partial state/card mutation
when the ask stamp fails. After the move, state and card must roll back together,
as observed through neo.snapshot. A successful close without a passed check is
closed_unverified. Snapshots retain summary state; complete large reports must
survive the receipt and neo.ask.read when the card is opened, following the
work-card-summaries journey.
Todo/ask/question/session SQL, including stop-context reads, must leave main.

Hold an owned 1.2-second WAL lock and measure a real health RPC during close.
The affected write still fails 250 ms; state that explicitly. Save the JSON and
log before the wrapper deletes owned data. Deno smoke runs the same helper and
prints its JSON before shared cleanup.

No real worker, model, provider, GUI, external HTTP, real GitHub, credentials,
live data or port 8399 is used. Unit cases drive the actual runner stop path
with a synthetic driver, preserving stop refusal, adopted-worker exemption,
settled-ask no-change receipts and full reports received during stop. Actual
external stop delivery and queue/SQL/clone stage timings remain unverified.
Remove wiring remains a later slice.
