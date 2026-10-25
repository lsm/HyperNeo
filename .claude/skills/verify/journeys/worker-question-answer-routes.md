# Worker cards retain their answer routes and delivery receipts

Use SKILL.md's shared in-process setup with
`PROOF=.claude/skills/verify/worker-question-answer-routes.ts`. This metadata-only
journey needs no provider, model mock or fixed-port preflight. Check disk space
before starting it and obey the active task's disk limit.

The helper owns an ephemeral-port daemon, synthetic HOME/data/DB and refusing
GitHub stub. It seeds a validated, assigned worker report through the existing
storage helper, then reads `neo.question.get` through WebSocket RPC. Repeating
the report must leave exactly one answerDelivery route in waiting state.

Replace a worker card with a later manual question through `neo.question.ask`,
keeping todoId and sourceSession on the manual card. Read it before and after
restarting only the fixture daemon: its answerDelivery must remain empty while
the todo retains its needs-human hold. Historical route recovery runs only
behind the one-time migration marker; ordinary startup must not synthesize routes.
`evidence/manual-restart.json` retains both RPC reads. Retire this fixture-only
manual card and send a new validated worker report before continuing below.

Rebind that todo to a second synthetic worker through `neo.todo.bind`, then
report its blocker through the validated writer. The open card ID must stay
the same while answerDelivery points to the replacement worker. Record that
read in `evidence/rebind.json`; the answer admission below targets that worker.
An already accepted route must preserve its worker and receipt on later binds.

Answer the card through the real `neo.question.answer` RPC. The same read must
show the human's immutable answer, button provenance and a pending delivery.
The todo must retain its needs-human hold: this build slice stores the answer;
automatic delivery and hold release are the next PR of #8732.

Exercise the existing delivery primitive explicitly: send the answer using
`message.send` with the stored route ID as idempotencyKey. Five identical retries
must return the same admission and message IDs. Changed text under that key
must be rejected with idempotency_conflict; a different valid origin has its
own key scope. Store that accepted message ID through the internal answer-route
receipt writer, restart only the fixture daemon, then read the same accepted
receipt and human provenance through RPC. A retry after restart must still
return the original admission.

Unit contracts additionally cover chat answers, competing answers, answer/route
write rollback, rejecting premature acknowledgement, and upgrading historical
held cards without overwriting accepted receipts on repeated upgrades.
Two-connection SQLite regressions interleave a peer answer with the card read
and competing acknowledgements with receipt writes. Reads must return a coherent
question/answerDelivery snapshot, and only one acknowledgement may succeed;
the losing attempt cannot replace the accepted receipt.

`evidence/observed.json` contains RPC receipts and before/after route reads.
`evidence/cleanup.json` confirms shutdown and immediate deletion of the synthetic
daemon data, HOME and temp files. Retain these and `proof.log`; do not retain
the disposable database. This proves storage, the existing retry-key admission
primitive and RPC projection. It does not claim automatic worker delivery,
hold release, SDK consumption, agent triage or GUI rendering.
