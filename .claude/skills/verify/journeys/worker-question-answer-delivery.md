# Human card answers go directly to the worker and release its hold

Use SKILL.md's shared in-process SDK setup with
`PROOF=.claude/skills/verify/worker-question-answer-delivery.ts`. Preflight port
8000 only and obey the active disk limit. The helper owns an ephemeral-port
daemon, synthetic HOME/data/DB, refusing GitHub stub and loopback Anthropic SSE
model. It disables external registry MCP servers and the SDK sandbox for this
transport fixture only; this does not prove OS sandbox enforcement.

The bound worker's real session door sends a blocked report. Answer its card
through `neo.question.answer` over WebSocket RPC. Before returning, the answer
must have an accepted worker admission and the todo must be doing. Start the
owned job processor and observe the actual worker SDK consume that receipt.
Neo's model input must contain the answer in its durable context.
Identify those requests by the root Neo system prompt, so worker requests cannot
satisfy the coordinator-context assertion.

Create another card and reply through `neo.message.send` with a question quote,
using a new requestId. The free-text answer must retain chat provenance, reach
the worker SDK and release the hold without waiting for Neo to interpret it.

For failure recovery, create a third card, make only the fixture worker unavailable,
then answer it. The answer stays pending and the todo stays needs-human. Restart
only this daemon, restore the fixture worker and make its persisted driver-refresh
job due immediately. The real job handler must retry delivery and return doing.
Replay the original chat request and a closed button answer: each of the three
answer receipts must still identify exactly one consumed worker user-message row.

Inline dispatch is scoped to the answered question for both buttons and chat.
An unrelated pending route must neither send nor be recomputed before this
answer returns. The refresh job retains the full sweep for restart recovery.

Use the metadata-only companion with
`PROOF=.claude/skills/verify/worker-question-answer-scope.ts` and SKILL.md's
proof-run.sh wrapper. It needs no model or fixed port. It seeds another pending
HyperNeo route on a synthetic remote daemon and holds only that transport's
response behind a controlled barrier. The real target answer RPC must return
without starting that unrelated transport; the target resumes while the other
todo stays held. evidence/observed.json records which action happened first.

Use the same metadata-only wrapper with
`PROOF=.claude/skills/verify/worker-question-answer-concurrency.ts` to overlap
the real answer RPC with a delivery sweep for the same card. A controlled
sender-title read pauses the real message.send after limiter admission; the
competing sweep receives its real duplicate rejection before the first send
commits. The card must still show accepted and the todo doing when the RPC
returns. Keep observed.json with both transport outcomes and the final card/todo,
plus cleanup.json and run-status.json. This helper needs no model or fixed port.

For external-worker answers, run worker-question-answer-external.md. It covers
certainty-aware refusal retry and lost-acknowledgement reconciliation through the
production Codex adapter. This SDK journey still covers only HyperNeo sessions.

Keep evidence/button.json, observed.json, model request files, proof.log and
cleanup.json. The helper closes its app/model, verifies both owned listening ports
can be rebound, removes its temporary data and then exits explicitly so SDK idle
timers cannot retain the proof process. Assertions and cleanup failures retain a
nonzero exit status. This proves RPC, queue, SDK consumption and synthetic restart
recovery. Native external apps, GUI rendering and agent triage are outside this
SDK journey; the companion external journey covers synthetic external delivery.
