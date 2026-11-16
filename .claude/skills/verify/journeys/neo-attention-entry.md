# The Neo attention entry delivers each step once (Build)

Use shared isolation and cleanup in `../SKILL.md`. This construction proof boots
one fresh synthetic daemon on an ephemeral loopback port, opens the root Neo
session with `neo.open`, and stops the job processor so no model is called. No
provider, browser or external HTTP is used.

```bash
bash .claude/skills/verify/proof-run.sh /absolute/fresh/evidence-directory \
  .claude/skills/verify/neo-attention-entry.ts
```

The helper builds `neo.attention.tell` with the production delivery
(`neoAttentionDelivery`) on the daemon's own database and raises synthetic
events. Observe `neo-attention-entry.json` and the job queue it was read from:

- a `todo.neo_step` raised twice before its 1 h rung is one mailbox entry for
  the root Neo session; raised twice after the rung it is one more;
- a `todo.blocked` raised twice is one held note (`neo_notes`) and no wake;
- the same step under an open card is dropped, logged as `covered by card`, and
  adds nothing to either queue.

Nothing calls the entry in production yet, so this does not show a wake in
Neo's conversation, the 5-minute sweep, or any producer; those need their own
wiring slices and journeys.
