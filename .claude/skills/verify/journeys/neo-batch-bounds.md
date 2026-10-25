# Oversized Neo batches remain complete through a bounded reference

Use the in-process RPC setup in SKILL.md with
`PROOF=.claude/skills/verify/neo-batch-bounds.ts`. Preflight port 8000 only.
The helper owns its isolated daemon, synthetic HOME/data, refusing GitHub stub
and loopback SSE model. External registry MCP servers and the SDK sandbox are
disabled only for this transport proof.

Send 120 free-form reports, each with 2,048 repeated payload bytes and a unique
sequence label, then an explicit blocked report. All must be accepted. The
coordinator must start once with at most 64 KiB of user prompt content. Read the
complete reference actually present in that model request through the real
handoff.read operation, following nextOffset until complete. Every sequence
label and its full payload must survive in order, followed by the blocker.

Retain evidence/bounds.json, evidence/observed.json, model request JSON files
and proof.log. The pre-fix journey fails with an oversized prompt. This verifies
the daemon, bounded model input and hash-verified file read, not that a real
model chooses to read an attachment or reasons correctly about it. Attachment
delivery confirms receipt of the reference, as with existing large worker sends.

The neo-batch-bounds unit contract also retries the same durable delivery job
and checks that its published reference stays identical and every original byte
is readable. Run it with the Neo queue, mailbox, message-delivery handler,
outbox and prompt-comparison suites.
