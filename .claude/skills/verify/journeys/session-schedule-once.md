# A one-shot reminder fires once at its time and ends

Follow SKILL.md for runtime, resource checks and isolation. Run:

```sh
TMPDIR=/tmp bash .claude/skills/verify/proof-run.sh "$EVIDENCE" \
  .claude/skills/verify/session-schedule-once.ts
```

The helper starts a real daemon with a fresh HOME/data/DB, a loopback ephemeral
port and the refusing GitHub stub. The owner-only local socket authenticates RPC.
No provider, model or real credential is used. The helper restores its clock and
closes the daemon in finally.

It first creates a repeating reminder, then reruns the schedule-table rebuild
(migration 523). That reminder's row must come back unchanged apart from a null
`once_at` and `delivery_receipt`, with both schedule indexes present.

Over RPC, `schedule.session.create` with `cadence: { kind: 'once', at }` refuses
a past time with `invalid_cadence`, and accepts a future one with `nextRunAt`
equal to `at`. The daemon's registered `sessionSchedule.fire` handler then runs
it twice:

- At `at` the target is queued: `skipped_busy`, the schedule stays active and
  retries one minute later, and nothing is delivered.
- At the retry the target is idle: `fired`, one mailbox wake carrying the note,
  and the schedule is `done` with no next run or job. The wake's message ID is
  built from `at`, not the retry time, so every retry is the same occurrence.

`schedule.session.list` returns the `once` cadence with its time. Inspect
`schedule-once.json` for the upgrade rows, each wake and the list reply. The
web Schedules panel renders the cadence as "Once: <time>"; its component test
is CI-owned.
