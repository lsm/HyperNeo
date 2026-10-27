# Existing workflow runs acquire their definition pin through the writer

Use the shared proof wrapper with a fresh synthetic daemon home and database:

```sh
bash .claude/skills/verify/proof-run.sh /absolute/fresh/pin-evidence \
  .claude/skills/verify/workflow-existing-run-pin.ts verify
```

The helper creates a taskless legacy workflow run, closes the first daemon,
then starts a new daemon against that synthetic database. Real RPC startup
backfills the run before the WebSocket accepts `spaceWorkflowRun.listHookStates`.
The persisted version must retain the full Unicode description and its SHA-256 hash, and a later pin
attempt must return false without replacing it. Instrumentation on the main
connection must observe zero definition-version SQL within the existing-run pin method.
Run `verify` on the regression commit to observe the failing SQL assertion;
`before` instead records and requires that baseline main-thread SQL.

The helper forbids external HTTP, uses an ephemeral port, and cleans up both
daemons and their workers. Evidence includes the actual WebSocket reply and
captured main-thread SQL. The wrapper retains evidence and removes its temporary
database and home. This proves existing-run pin persistence and startup ordering;
new-run creation, snapshot migration, admission reads, GUI behavior, worker death
and held-lock latency are separate verification surfaces.

Run the workflow-run repository and workflow-manager unit files to preserve
snapshot resolution, rollback on a rejected pin, idempotency and backfill failure
isolation. For Deno, run the same wrapper with `VERIFY_PROOF_RUNTIME=deno` and
the supported Deno runtime on PATH. Shared smoke registration belongs to core.
