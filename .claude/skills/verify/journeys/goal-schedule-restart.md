# Completed goal schedules survive restart

Run with the isolated proof wrapper:

```sh
TMPDIR=/tmp bash .claude/skills/verify/proof-run.sh "$EVIDENCE" \
  .claude/skills/verify/goal-schedule-restart.ts
```

The helper creates a goal over RPC, changes its two schedules to synthetic
one-shot cadences, and fires each through the daemon's registered handler.
It restarts the daemon against the same synthetic database and reads
`schedule.session.list` over RPC. Both schedule IDs must remain done without
pending jobs. Inspect `goal-schedule-restart.json` and the wrapper exit status.
The helper also pauses both schedules of another active goal over RPC and checks
that neither pause is undone by the restart.
