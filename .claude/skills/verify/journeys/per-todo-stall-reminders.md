# Each stalled todo receives bounded reminders

Use the shared metadata-only isolated setup and cleanup in SKILL.md:

```sh
TMPDIR=/private/tmp bash .claude/skills/verify/proof-run.sh "$EVIDENCE" \
  .claude/skills/verify/per-todo-stall-reminders.ts verify
```

The helper owns an ephemeral daemon, disposable data and home, manual synthetic
Neo, and refusing GitHub stub. No provider, live daemon or port 8399 is used.
A fake clock advances the real refresh handler: a stalled todo inside an ask
with a doing sibling and an unrelated open question must get its first steer
at two hours. Mailbox admission alone must not count as delivered. A failed
input must retry as steer without spending a reminder. Following a consumed
receipt and daemon restart, the next reminder must use queue after two hours,
then queue once more after two hours. Three delivered reminders exhaust the
budget; the stalled todo remains visible in the public snapshot.

Retain result.json and proof.log. Receipt facts are synthetic inputs written
through the normal message writer and observed through message.status over
WebSocket; this verifies durable scheduling, failed-delivery reconciliation,
restart behavior, delivery modes and visible state, not model compliance or
wall-clock waiting. The helper closes both daemon instances in finally.
The unit contracts additionally cover independent todo clocks, activity reset,
concurrent refresh, terminal mailbox failure and archived recipients.
