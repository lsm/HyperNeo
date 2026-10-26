# Worker reports persist as existing human cards

Use the shared in-process RPC proof setup in SKILL.md with
`PROOF=.claude/skills/verify/worker-question-storage.ts`. No provider turn,
HTTP model mock, or 8000/8001 preflight is needed. Preserve TMPDIR in the
scrubbed environment, as the RPC subprocess uses the selected temporary area.

The helper owns a real daemon on an ephemeral port and a fresh synthetic DB.
It calls the internal storage entry point (message.send wiring is slice 2),
then reads the existing card API and Neo snapshot over actual WebSocket RPC.
A Chinese title and options, original report, and validated worker source must
survive storage. Ten simultaneous repeats must reuse one open card. A foreign
worker must be refused.
Asking a distinct question through `neo.question.ask` on the same todo must
return `todo_question_open`, retaining the original card. Worker repeats still
reuse the card; explicit replacement is covered by the operation tests.
After stopping and reopening that daemon's own DB,
routine activity and a completion judgement must leave the todo blocked with
its needs-human hold and the card still readable. The free-text answer route
is the existing card reply control; no new card UI is introduced.

The helper then seeds a persisted human answer without delivering it, attempts
an ordinary doing update, and restarts again. RPC must show the answered card
while the todo retains its needs-human hold. This is the staged contract from
the approved design: answering a card is not acknowledgement that its worker
received the answer. Slice 1 builds storage only; slice 2 wires reports and
nudges; #8732 (slice 3) adds retry-safe answer delivery and releases the hold
only after accepted delivery and dependency checks. Missing/open/retired card
state alone must never release it. This journey exercises the storage helper;
worker-question-wire.md covers its production message.send caller in slice 2.

`evidence/observed.json` retains the replies and persisted hold;
`evidence/cleanup.json` confirms owned daemon cleanup. This proves storage and
RPC projection, not GUI rendering, message routing, nudges, wakes or answer
delivery/resume.
