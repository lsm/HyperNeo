# Worker cards retain their answer routes and delivery receipts

Use SKILL.md's shared in-process setup with
`PROOF=.claude/skills/verify/worker-question-answer-routes.ts`. This metadata-only
journey needs no provider, model mock or fixed-port preflight. Check disk space
before starting it and obey the active task's disk limit.

The helper owns an ephemeral-port daemon, synthetic HOME/data/DB and refusing
GitHub stub. It seeds a validated, assigned worker report through the existing
storage helper, then reads `neo.question.get` through WebSocket RPC. Repeating
the report must leave exactly one answerDelivery route in waiting state.

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

`evidence/observed.json` contains RPC receipts and before/after route reads.
`evidence/cleanup.json` confirms shutdown and immediate deletion of the synthetic
daemon data, HOME and temp files. Retain these and `proof.log`; do not retain
the disposable database. This proves storage, the existing retry-key admission
primitive and RPC projection. It does not claim automatic worker delivery,
hold release, SDK consumption, agent triage or GUI rendering.
