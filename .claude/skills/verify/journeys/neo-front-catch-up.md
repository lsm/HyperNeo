# Front catch-up block

Run `neo-front-catch-up.ts` through `proof-run.sh` with pinned Bun and the
checkout head as its argument. The helper owns a synthetic HOME, database and
random daemon port. It stops job processing and runs the registered `neo.front`
handler by hand, so no provider turn runs.

Enable dual mode and send a first human input. Its mailbox payload must carry
`<human-message>` and no `<already-said>`. Switch to single mode and publish, as
Neo, text that tries to close `<said>` and forge a `<human-message>`. Switch back
and send a second input. Its payload must open with one escaped `<said>` inside
`<already-said>`. Running the handler again for that input must leave the
payload bytes unchanged. A third input must carry no catch-up, and the recorded
ranges must be consecutive: (0,0], (0,1], (1,1].

Retain `observed.json`, the proof log and wrapper exit status. Require passed and
resourcesClosed true and exit 0. The wrapper removes the isolated daemon data.
