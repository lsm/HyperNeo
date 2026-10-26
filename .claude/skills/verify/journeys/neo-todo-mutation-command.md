# Build atomic todo mutation commands

This is row 5b of #8712. The command is registered with the real DB writer;
Edit RPC callers now use the writer after row 5c; close/remove callers remain
on their current paths until row 5d. The command receives cloned data, returns next-work candidates,
and performs no external check, worker stop, notification or dispatch.

Use the guarded metadata-only wrapper from SKILL.md, with fresh absolute
evidence directories. No provider, model, GUI, external HTTP, real credentials,
live data or port 8399 is used.

```sh
bash .claude/skills/verify/proof-run.sh "$BEFORE_EVIDENCE" .claude/skills/verify/todo-mutation-command.ts before
bash .claude/skills/verify/proof-run.sh "$AFTER_EVIDENCE" .claude/skills/verify/todo-mutation-command.ts verify
```

The before mode belongs to the pre-writer baseline, not the combined fixed
head. That baseline drives the real legacy edit RPC and refuses its ask timestamp.
It must reproduce a partial mutation visible in the stored todo/question and
the real WebSocket full-card read. The fixed build drives the new worker command
directly: the same refusal rolls back the whole mutation, and the snapshot
must retain its original title and open question. A successful title edit is
then visible in the snapshot.

Concurrent URL edits must retain both changes and one current-ownership
bookkeeping record, without blocking either edit. A stale completion check and
a newly opened human card must refuse closure. An unmet check closes as
`closed_unverified`; a matching passed check can mark done. The successor stays
pending. Complete reported evidence must survive persistence and the reply.

No command SQL may run on main. The helper holds an owned WAL lock for 1.2 s
and observes real health RPC latency while the writer waits. The affected write
still fails the 250 ms target; report that explicitly. Evidence is
`todo-mutation-command.json`. The helper closes its own resources in finally;
the wrapper saves evidence and deletes temporary daemon data immediately.

Unit contracts additionally cover removals, replacement admission, closed asks,
missing/removed todos, malformed checks, derived labels and artifact receipts.
GUI layout, real provider turns, worker-stop wiring, queue/SQL/clone timing and
runtime RPC migration are not proved by this build slice.
The Deno 2.9.4 smoke runs the same worker/snapshot proof and saves its JSON
summary in the smoke log before deleting temporary data. Run that smoke as
one separate guarded heavy job.

After #8894, RPC snapshots are summaries. These helpers use `neo.ask.read`
for visible full card bodies, including the unabridged report. The edit proof
also changes a completion check to core evidence and verifies its derived label.
The writer uses the current pure core/coding policies; final peer admission and
check/card revalidation remain in the same writer transaction.
