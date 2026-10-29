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

For receiving-side proof, run the shared scripted-SDK delivery journey:

```sh
TMPDIR=/private/tmp bash .claude/skills/verify/proof-run.sh "$DELIVERY_EVIDENCE" \
  .claude/skills/verify/per-todo-stall-delivery.ts verify --check-only
```

While the real daemon's current Neo query is held, the daily reminder must be
stored as deferred and absent from its SDK input. Release that query, then
observe the exact daily reminder in the next SDK turn and its completed result.
Retain delivery.json and proof.log. The SDK is scripted; actual model reasoning
remains unverified. Run the same helper without the flag for steer/queue compatibility.

Repeat the SDK command with `--check-only --cancel`. After the reminder has
materialized as deferred, hold its todo through the real DB writer before
releasing the busy query. Its input must be failed/cancelled and must never
reach the next SDK turn. An already consumed reminder and unrelated inputs
must retain their state.
