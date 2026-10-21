## A deferred follow-up runs after a transient connection retry

Set `PROOF=.claude/skills/verify/deferred-startup-retry.ts` and use the
**In-process RPC proofs** setup in SKILL.md. Add
`HYPERNEO_SDK_START_INACTIVITY_TIMEOUT_MS=15000` to that environment and pass
`transient` after `"$RUN"` in the helper invocation. Ports 8000 and 8001 must
be free.

The helper sends kickoff through actual WebSocket RPC. Its first synthetic
subprocess accepts SDK transport input and emits no output. After a follow-up
is durably deferred, the helper breaks the first stdout stream with
`stream closed`. The installed SDK must propagate this transient connection
error; the conversation RPC must show `The connection was interrupted.
Retrying` so a startup timeout cannot accidentally satisfy the journey.

The replacement subprocess uses the real installed SDK executable. Its input
tee must observe the original kickoff UUID, and actual local mock-model
requests must contain both kickoff and follow-up markers. Final RPC counts
must be `consumed=2`, `deferred=0`, without another send or interrupt to nudge
delivery. Delivery back into the closed SDK cannot pass the receipt assertion.

Evidence is `$RUN/evidence/deferred-retry.json`, including retry kind, input
receipts by subprocess attempt, model marker observations and RPC counts.
Resources close in finally. GitHub is stubbed; credentials are stored through
provider RPC only in the fresh synthetic DB. Browser rendering and real
provider traffic are not exercised.

The unit fixture runs the same input ownership assertion for startup and
transient connection retries. Before the transient fix, startup passes and
transient fails with recipient `closed SDK` instead of `replacement SDK`.
The RPC reproduction similarly shows the transient retry notice, but no
kickoff in attempt 2. Renewing the queue after the early enqueue is too late:
snapshot before teardown, then enqueue after the generation is renewed.
