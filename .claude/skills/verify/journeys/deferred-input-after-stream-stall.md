## A deferred follow-up runs after a silent model request is retried

Set `PROOF=.claude/skills/verify/deferred-startup-retry.ts` and use the
**In-process RPC proofs** setup in SKILL.md. Add
`HYPERNEO_SDK_START_INACTIVITY_TIMEOUT_MS=15000` and
`HYPERNEO_SDK_STREAM_SILENCE_TIMEOUT_MS=2000` to that environment, and pass
`stall` after `"$RUN"` in the helper invocation. Ports 8000 and 8001 must be free.

All subprocesses use the installed SDK executable. The first SDK starts,
receives kickoff and reaches the local model API. The proxy holds every model
request carrying kickoff while attempt 1 owns the query. Holding only one
request is insufficient because the SDK can make concurrent model requests.
No tools remain open. The actual stream-silence watchdog must fire, and the
conversation RPC must show `The model sent nothing` before the helper checks
the replacement's input receipt.

Attempt 2 must receive the original kickoff UUID. Both kickoff and the deferred
follow-up must reach actual mock-model requests, with RPC counts
`consumed=2`, `deferred=0`, without another send or interrupt to advance delivery.
Evidence is `$RUN/evidence/deferred-retry.json`, with retry kind `stall`,
subprocess input receipts and model marker observations. All owned resources
close in finally. Browser rendering and real provider traffic are not exercised.

Before the fix, the unit input receipt goes to `closed SDK`, and the RPC proof
observes the real watchdog/retry notice but fails because attempt 2 never
receives kickoff. Snapshot before teardown, renew the queue generation, then
requeue through the existing pipeline stages.
