# Remove a todo through the DB writer

Use SKILL.md's guarded metadata-only wrapper with fresh absolute evidence
directories and a writable TMPDIR:

```sh
bash .claude/skills/verify/proof-run.sh "$BEFORE_EVIDENCE" .claude/skills/verify/todo-remove-writer.ts before
bash .claude/skills/verify/proof-run.sh "$AFTER_EVIDENCE" .claude/skills/verify/todo-remove-writer.ts verify
```

The real neo.todo.remove RPC must first reproduce a partial state/card mutation
when the ask stamp fails. After the move both must roll back together. Successful
removal stays visible as removed in neo.snapshot. Complete large reports must
survive the receipt and neo.ask.read for the opened card; summary snapshots do
not carry report bodies. Targeted todo/ask/question/session SQL must leave main.

An independent WebSocket client must receive one neo.changed after a successful
commit and refresh to the removed state. The internal subscriber also receives
one; rollback emits neither. Unit cases cover settled-ask no-change receipts,
stop failure, adopted-worker exemption and concurrent reports. A replacement
deleted during stop must produce the current nonblocking replacement_missing
record and remove without a stale link; a valid replacement remains linked.

Hold an owned 1.2-second WAL lock and measure a real health RPC during removal.
The affected write still fails 250 ms; state that explicitly. Save the JSON and
log before the wrapper deletes owned data. Deno smoke runs the same helper and
prints JSON before shared cleanup.

No real worker, model, provider, GUI, external HTTP, real GitHub, credentials,
live data or port 8399 is used. Actual external stop delivery and queue/SQL/clone
stage timings remain unverified. Core completion-check DB reads remain later
work in #8712; removal performs no completion check.
