# Worker report retries compare content independently of routing metadata

Use the in-process RPC setup in SKILL.md with
`PROOF=.claude/skills/verify/worker-report-retry.ts`. Preflight port 8000 only.
The helper owns an isolated daemon, disposable HOME/data directory, refusing
GitHub stub and loopback SSE model. It disables external registry MCP servers
and the SDK sandbox only for this synthetic transport proof.

Deliver a worker report through the daemon's real mailbox and wait for one
persisted result. Retry its identical UUID and content with the structured
blocked kind added, representing history stored without routing metadata.
The retry must complete without a content-conflict error, an extra history row
or another coordinator turn. Keep evidence/observed.json, model request JSON
files and proof.log. Before the fix, the retry records a content-conflict error
and the helper fails; after the fix it completes with one coordinator turn.

Run message-delivery-outbox and prompt-comparison tests too. The outbox cases
cover all four report kinds; existing changed-content cases must still fail.
This is a mailbox/SDK retry proof, not evidence of GUI behavior, OS sandbox
enforcement or the queue slice's immediate-wake policy.
