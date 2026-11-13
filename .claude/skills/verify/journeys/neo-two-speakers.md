# Two speakers in dual mode

Run `neo-two-speakers.ts` through `proof-run.sh` with pinned Bun and the
checkout head as its argument. The helper owns a synthetic HOME, database and
random daemon port. It stops job processing, runs the registered `neo.front`
handler by hand and calls the front session's real tools, so no provider turn
runs.

Enable dual mode and send a human input. Mark it received by the front, then
have the front call `reply` with `work_on: true` and a one-sentence
acknowledgment. Require that one call to publish the acknowledgment, report
`started: true`, store owner `neo` and give Neo the recorded human message with
the acknowledgment in `<already-said>`. A second `work_on` reply for that input
collides on the derived progress id and is refused with `publication_conflict`;
a later ordinary front `reply` for the same input is still accepted, since
publish no longer refuses on an existing owner. Neo then publishes its answer with
the original `replyTo` through `neo.publication.publish`, and the stored row
records `publishedBy: 'neo'`. Neo speech must pass the speaker gate (it stops at
`voice_replies_off` because no client listens). The input settles as handed off.

Retain `observed.json`, the proof log and wrapper exit status. Require passed and
resourcesClosed true and exit 0. The wrapper removes the isolated daemon data.
