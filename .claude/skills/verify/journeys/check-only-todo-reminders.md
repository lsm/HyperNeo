# Daily Neo reminders for check-only queued todos

Use the shared metadata-only isolated setup and cleanup in SKILL.md:

```sh
TMPDIR=/private/tmp bash .claude/skills/verify/proof-run.sh "$EVIDENCE" \
  .claude/skills/verify/check-only-todo-reminders.ts verify
```

A real ephemeral daemon refresh sees a queued todo with a check but neither an
instruction nor a work target. At 24 hours it queues a reminder to its Neo to
supply both, or hold/remove the todo. Pending delivery must not duplicate it;
a failed receipt must not spend the day. Actual consumed timestamps control
24-hour repeats, including after daemon restart and beyond three reminders.
Creating the synthetic check's evidence must complete the todo and stop reminders.
Read the public snapshot and retain result.json and proof.log. The clock and
receipts are fixtures; model reasoning, browser rendering and wall-clock waits
are unverified. Both daemon instances and sockets close in finally.
