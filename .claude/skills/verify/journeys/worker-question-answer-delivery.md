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

Unit contracts also exercise external worker acceptance, definite refusal/retry,
and a lost or unconfirmed external response. External sends are durably claimed
before dispatch; after an uncertain result, a repeated refresh reads the peer's
recorded input marker and never blindly sends the answer again. Missing peer
evidence keeps the hold. A newer unanswered card or changed worker assignment
must prevent an old accepted answer from releasing the hold.

Keep evidence/button.json, observed.json, model request files, proof.log and
cleanup.json. The helper closes its app/model, verifies both owned listening ports
can be rebound, removes its temporary data and then exits explicitly so SDK idle
timers cannot retain the proof process. Assertions and cleanup failures retain a
nonzero exit status. This proves RPC, queue, SDK consumption and synthetic restart
recovery. External desktop behavior is covered by contract tests here; native
external-app delivery, GUI rendering and agent triage are not claimed.
