# Edit todos through the DB writer

This is row 5c of #8712. Use SKILL.md's guarded metadata-only wrapper with
fresh absolute evidence directories and this helper:

```sh
bash .claude/skills/verify/proof-run.sh "$BEFORE_EVIDENCE" .claude/skills/verify/todo-edit-writer.ts before
bash .claude/skills/verify/proof-run.sh "$AFTER_EVIDENCE" .claude/skills/verify/todo-edit-writer.ts verify
```

Both runs invoke the real `neo.todo.edit` WebSocket operation. A synthetic
refused ask timestamp first reproduces a partial title/card mutation, then
must roll back completely through the writer, as seen by `neo.ask.read`.
Successful title edits and concurrent URL edits must retain both current
claims and exactly one duplicate bookkeeping record. A complete large report
must survive the RPC reply and full-card read as `closed_unverified`.
A new PR requirement reopens a previously done todo for checking; URL bookkeeping
must preserve an existing `closed_unverified` state. Unit cases retain both
close/sweep overlap orders when URL editing yields to the DB worker.

The edit's todo/ask/question/claim SQL must leave main. Hold an owned WAL lock
for 1.2 seconds and measure a real health RPC during the waiting edit. The
affected write still fails the 250 ms target; say so explicitly. This is not
a queue/SQL/clone stage breakdown. Save `todo-edit-writer.json` and the log;
the wrapper removes owned daemon data immediately after saving evidence.

No model, provider, GUI, external HTTP, real GitHub, credentials, live data or
port 8399 is used. Unit cases additionally cover stale checks, new human cards,
and dispatch only after a successful commit. The proof has no artifact input
or successor dispatch; artifact authorization reads and the remaining runner
paths are outside this slice. Close/remove callers remain on their old paths.
The Deno smoke runs the same RPC helper and prints its JSON evidence before
the smoke's shared cleanup removes temporary daemon data.

After #8894, RPC snapshots are summaries. These helpers use `neo.ask.read`
for visible full card bodies, including the unabridged report. The edit proof
also changes a completion check to core evidence and verifies its derived label.
The writer uses the current pure core/coding policies; final peer admission and
check/card revalidation remain in the same writer transaction.

The RPC proof also edits an already-settled ask and observes a successful
`ask_settled` bookkeeping receipt with the full visible card unchanged. Unit
regressions cover settlement before preparation and while a completion check
is in flight; neither case writes state, prunes cards or starts another worker.

A real `neo.changed` subscription must receive each committed edit after the
worker transaction commits. The RPC proof compares the subscription counter
around an edit, and unit regressions assert that rollback and settled-ask
bookkeeping do not announce a write. Gateway change records are replayed on
main only after a successful transaction; the existing Neo event refreshes
the web surfaces that subscribe to it.
