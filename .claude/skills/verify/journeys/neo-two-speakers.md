# Two speakers in dual mode

Run `neo-two-speakers.ts` through `proof-run.sh` with pinned Bun and the
checkout head as its argument. The helper owns a synthetic HOME, database and
random daemon port. It stops job processing, runs the registered `neo.front`
handler by hand and calls the front session's real tools, so no provider turn
runs.

Enable dual mode and send a human input. Mark it received by the front, then
have the front call `reply` with one line. Every reply hands off now, so that one
call must publish the reply, report `started: true`, store owner `neo` and give
Neo the recorded human message with that reply in `<already-said>`; no part of
that block names who wrote it. A second reply for the same input publishes
again and still reports `started: true`, and the reserve enqueues the input only
once. A reply that carries two `replyTo` IDs hands off both inputs. Neo then
publishes its answer with the original `replyTo` through
`neo.publication.publish`, and the stored row records `publishedBy: 'neo'`. The
full session's prompt carries no instruction to acknowledge before working, and
single mode still gets its per-input note. Neo speech must pass the speaker gate
(it stops at `voice_replies_off` because no client listens). The input settles as
handed off.

Retain `observed.json`, the proof log and wrapper exit status. Require passed and
resourcesClosed true and exit 0. The wrapper removes the isolated daemon data.
