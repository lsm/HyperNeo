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
budget; the stalled todo remains visible in the public snapshot. A consumed
input subsequently marked failed must restore its budget, including after the
cap was reached; a queued replacement must then restore the cap.

Retain result.json and proof.log. Receipt facts are synthetic inputs written
through the normal message writer and observed through message.status over
WebSocket; this verifies durable scheduling, failed-delivery reconciliation,
restart behavior, delivery modes and visible state, not model compliance or
wall-clock waiting. The helper closes both daemon instances in finally.
The unit contracts additionally cover independent todo clocks, activity reset,
concurrent refresh, terminal mailbox failure and archived recipients.

For actual input delivery and the fresh-turn boundary, also run:

```sh
TMPDIR=/private/tmp bash .claude/skills/verify/proof-run.sh "$DELIVERY_EVIDENCE" \
  .claude/skills/verify/per-todo-stall-delivery.ts verify
```

This second helper uses a scripted SDK with the real daemon, mailbox processor,
query runtime and public RPC. It holds a running turn open. The first reminder
must reach and be consumed by the SDK while that turn is held. The second must
materialize as deferred and stay out of the SDK until the held turn produces
its result; it must then arrive and finish its own result. Keep delivery.json
and proof.log. External HTTP is refused. The script releases its held turn and
closes the transport and daemon in finally. This proves actual input ordering
with a deterministic SDK peer, not real-model attention or reasoning.
