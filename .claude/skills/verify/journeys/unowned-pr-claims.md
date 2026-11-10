# Recheck unowned PR claims before delivery

Use the shared metadata-only wrapper and resource guard from SKILL.md:

```sh
bash .claude/skills/verify/proof-run.sh "$EVIDENCE" .claude/skills/verify/unowned-pr-claims.ts
```

The helper owns an ephemeral daemon, disposable HOME/DB, refusing GitHub stub
and authenticated local RPC. A persisted synthetic job runs the production
coding-pack sweep. First delivery is refused. Then a current owner claims one
PR, and the public neo.todo.edit addUrls operation links a second PR to an
unassigned todo. The next attempted notice must contain only the third PR.
Its original delivery ID survives trimming and daemon restart; its accepted
retry reaches Neo's mailbox once. A second batch is admitted, then loses its
separate acknowledgement write. After restart and a new claim, its durable admission reconciles without a
second send. A later fully claimed batch retires only after proven non-admission.
Removing those claims must notify the never-admitted PRs, while removing a claim
from the admitted batch must preserve its once-only history. Receipt lookup uses
the recorded original recipient and stable batch ID. Legacy array/null batches
and batches with deleted or unbound recipients retire without sending, preserve
once-only history and allow the next unrelated batch. The helper exercises all
four shapes through the production sweep, including a real binding removal.
Still-bound unknown or in-flight receipts retain their original batch for retry.

Main-thread SQL guards cover pending-notice state and the claim lookup. Keep
unowned-pr-claims.json and proof.log with exit status and resourcesClosed=true.
This proves production selection, public link editing and durable mailbox
admission with synthetic repository reads and rejected-delivery injection.
No model, real GitHub request, GUI or live daemon is used. The daemon, service
and socket are closed in finally. Also run coding-unowned-db for the original
writer-bound reservation and confirmation contract.
