# Every session schedule firing leaves a run

Follow SKILL.md for runtime, resource checks and isolation. Run:

```sh
TMPDIR=/tmp bash .claude/skills/verify/proof-run.sh "$EVIDENCE" \
  .claude/skills/verify/session-schedule-runs.ts
```

The helper starts a real daemon with a fresh HOME/data/DB, a loopback ephemeral
port and the refusing GitHub stub. The owner-only local socket authenticates RPC.
No provider, model or real credential is used. The helper restores its clock and
closes the daemon in finally.

A reminder is created through `schedule.session.create` on an idle session. The
daemon's registered `sessionSchedule.fire` handler then fires it four times:
the first delivers (`fired`), the second is unchanged (`skipped_unchanged`), the
third finds the session queued (`skipped_busy`), and the fourth runs after
`session.delete` (`target_gone`). `schedule.session.runs` over RPC must return
those four runs newest first. Each run carries its due and fired time, its skip
reason, and the message id only for the delivered run. Inspect
`schedule-runs.json` for the firings and the RPC reply.

Before the change the operation does not exist and the run list is empty. The
`skipped_needs_you` and `source_gone` outcomes are covered by the
`schedule.session.runs` unit contract, which CI runs.
