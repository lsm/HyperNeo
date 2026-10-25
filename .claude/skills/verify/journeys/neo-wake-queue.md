# Neo wakes only for structured events

Use the in-process RPC setup in SKILL.md with
`PROOF=.claude/skills/verify/neo-wake-queue.ts`. Preflight port 8000 only.
The helper owns an ephemeral isolated daemon, disposable HOME/data directory,
refusing GitHub stub and loopback Anthropic SSE server. It disables external
registry MCP servers and the SDK sandbox only for this transport proof.
It waits for the isolated database's startup body copy before submitting reports.

Send twenty distinct free-form worker messages through the real message.send
operation. All twenty must be accepted, with zero coordinator model requests.
Send an explicit kind=blocked report: a separate batch request must contain all
twenty queued messages in order, followed by the unchanged blocker in its own
request. Send a kind=question report and observe one more request immediately. Send two further
free-form messages and immediately submit human input through neo.message.send;
both pending messages must arrive in a separate system-forwarded batch request
before the unchanged human request. These add two coordinator requests; the
final count is five. The human request may retain the prior batch in history.

Before the blocker, message.status must report queued for all twenty parked
notes. After the blocker is consumed, it must report delivered for those notes.
The helper pauses only its owned job processor to capture the original blocker
envelope, then retries that exact UUID and content after the batch is consumed.
The persisted original content must remain unchanged, the retry must complete
without a conflict, and no extra model turn may start. Preserve
queued-statuses.json, read-statuses.json and batch-retry.json as well.

Oversized batches use the separate neo-batch-bounds journey. They preserve all
queued content in one hash-checked reference rather than discarding overflow.

Keep evidence/burst.json, evidence/observed.json, the model request JSON files and
proof.log. Title-generation calls are recorded but excluded from coordinator
turn counts. This proves the daemon/operation/SDK path, not GUI rendering, real
worker compliance, real-model reasoning, or OS sandbox enforcement.

Run the neo-wake-queue mailbox tests as well. They exercise pending-mailbox
capture, unchanged delivery claims, a retried batch without duplication, queue
repository reconstruction, and the fifteen-minute fallback boundary. The time
boundary is advanced synthetically in that contract test; the journey does not
claim fifteen minutes of wall-clock observation. Run the Neo intake, question,
PR-event, note-delivery, mailbox delivery and registration suites too.

The existing neo-quiet-wake journey still verifies notify:false/status-only
history and read-only main-connection writes. Its two urgent-overlap fixtures
now mark an explicit daemon event; a worker turn end alone is queued regardless
of text or driver status.
