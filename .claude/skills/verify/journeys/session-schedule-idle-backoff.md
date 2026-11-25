# Idle schedules remain status, never conversation messages

Follow SKILL.md for runtime, resource checks and isolation. Run the actual
registered scheduler handler through the in-process daemon/RPC proof:

```sh
TMPDIR=/tmp bash .claude/skills/verify/proof-run.sh "$EVIDENCE" \
  .claude/skills/verify/session-schedule-idle.ts
```

The owner-only synthetic socket authenticates RPC. The fresh HOME/data/DB,
loopback ephemeral port and refusing GitHub stub never use real credentials.
The helper closes the daemon and restores its clock in finally. On macOS the
shared resource check runs first. No provider or model is needed.

The schedule is a reminder created through `schedule.session.create`; goal
schedules no longer back off (see [goal work wakes](goal-work-wakes.md)).
Ten unchanged wakes preserve skipped_unchanged status and back off from twenty
minutes to eight hours. They add zero publications, SDK inputs or mailbox jobs.
New human input in the target immediately resets the cadence and the next wake
fires. Later unchanged wakes, renaming the recipient, and a 20,000-character
title add no idle publication or input. Inspect schedule-idle.json for counts,
outcomes, due times and the public conversation response. Before the fix the
third unchanged check fails the zero-publication assertion.

The focused scheduler contracts remain CI-owned. The historical
session-schedule-idle.sh wrapper also runs those tests; do not run that wrapper
on a host where local test suites are prohibited.
