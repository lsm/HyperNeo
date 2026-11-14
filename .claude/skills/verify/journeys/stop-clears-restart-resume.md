### Stopping a session the restart left waiting lets it be archived

A daemon restart during a rate-limit cooldown leaves a session
`interrupted` with reason `restart` and a `resumeAt`, which reads as queued.
`work.stop` must drop that pending resume, so `neo.session.archive` succeeds.

```bash
RUN=$(mktemp -d /private/tmp/hn-stop-restart-XXXXXX); rmdir "$RUN"
.claude/skills/verify/stop-restart-interrupted.sh "$RUN" 9377
```

The helper starts an isolated metadata-only daemon (`env -i`, `NODE_ENV=test`,
its own HOME and DB, no model), creates a session, writes the restart marker
into the run's DB while the daemon is down, restarts it, opens the session
(`session.get`, as the UI does, so it is loaded), then stops and archives it
over RPC with no wait between them. It stops its daemon on exit.

End state: the helper prints `PASS` and exits 0. `stop` replied `stopped:true`,
`archive` replied `archived:true`, and
the session row is `archived` with processing state `{"status":"interrupted"}`.
Evidence is in `$RUN/evidence/`.
