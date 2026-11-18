# A goal's work schedule fires every due time within its daily limit

Follow SKILL.md for runtime, resource checks and isolation. Run:

```sh
TMPDIR=/tmp bash .claude/skills/verify/proof-run.sh "$EVIDENCE" \
  .claude/skills/verify/goal-work-wakes.ts
```

The helper starts a real daemon with a fresh HOME/data/DB, a loopback ephemeral
port and the refusing GitHub stub. The owner-only local socket authenticates RPC.
No provider, model or real credential is used. The helper restores its clock and
closes the daemon in finally.

Root Neo creates a goal through `goal.session.create` with a one-minute cadence
and `dailyRunLimit: 2`. The daemon's registered `sessionSchedule.fire` handler
then fires four due times with no fact change in between:

- The first and second are `fired`; the second mailbox wake says "Nothing moved;
  check what can advance." because the due time itself is the reason to work.
- The third is `skipped_budget` with skip reason `budget` and delivers one
  notice naming the daily run limit of 2.
- The fourth is `skipped_budget` with no second notice. The schedule stays
  active.

`schedule.session.runs` over RPC lists the same four outcomes newest first.

The goal is then completed and reactivated through `goal.session.update`, which
replaces its schedule. The next due time is still `skipped_budget` with no new
notice, because the limit counts the goal's runs, not the schedule's. After the
clock moves 24 hours past the first run and the goal is reactivated again, the
next due time is `fired`.

The Neo-owned goal's separate review is then fired through the daemon handler.
Its mailbox wake contains the journal review instruction, and a review result
appended through RPC is readable through `goal.journal.list`.
With an empty journal, the review wake does not suggest a paging call.
`operations.describe` for goal creation and updates also states that ordinary
top-level session owners do not receive a review schedule.
The opened Neo session's actual system prompt states the same exclusion. This
does not exercise an SDK model turn.
An RPC update to the review cadence also records `reviewCadence` as a changed
field in the synthetic daemon's audit log.

Inspect `goal-work-wakes.json` for each wake's outcome, delivery and text.
Before the change the second due time is `skipped_unchanged` and nothing is
delivered.
