## A user interrupt ends the current turn and preserves queued inputs

Set `PROOF=.claude/skills/verify/interrupt-queued-inputs.ts` and use the
**In-process RPC proofs** setup in SKILL.md. Ports 8000 and 8001 must be free.

The helper starts an isolated daemon on an ephemeral port, with a fresh HOME,
DB and WebSocket client. The installed SDK talks only to local mock HTTP
servers. The first model request is held open to represent an active turn.
The helper seeds three synthetic enqueued inputs while it runs: two with
pending delivery jobs and one orphan row. It invokes the same
`client.interrupt` RPC as the user, waits for `agent.interrupted`, and records
the message statuses. None may become failed; the current consumed input must
stay consumed. Without any extra send or manual nudge, all queued markers must
reach a later model request and all rows must become consumed.

Evidence: `$RUN/evidence/interrupt.json`, including before/after statuses,
the RPC receipt and marker observations from actual mock-model requests.
The helper stores the dev-proxy credential through provider RPC, never the
environment. GitHub is stubbed. All owned servers and the daemon stop in finally;
the helper does not read the live database or send messages to real sessions.

On reproduction commit `46474db4c`, all three queued rows become failed after
client.interrupt and the helper fails with `interrupt failed queued input: 3 !== 0`.
The focused handler test additionally starts at the delivery retry limit and
observes a pending job with unchanged retry count after interruption.
Explicit teardown (`skipDeferredReplay:true`) retains its cancellation behavior.

This proves RPC interruption, durable queue preservation and model receipt.
Browser rendering and real provider traffic are not exercised.
