# A card closed by Neo does not come back

Use the shared metadata-only setup in SKILL.md:

```sh
TMPDIR=/private/tmp bash .claude/skills/verify/proof-run.sh "$EVIDENCE" \
  .claude/skills/verify/retired-card-stays-closed.ts verify
```

The helper owns an ephemeral daemon with no provider and a refusing GitHub stub.
A synthetic worker reports `Blocked (needs_human)` through the production writers,
the clock moves past the hour, and the real refresh sweep runs. The card comes
from the daemon fallback when it exists, otherwise from Neo. Over public RPC:

- `neo.question.retire` is refused with `todo_waiting`, and four later sweeps,
  across two more hours, keep the same single card.
- `neo.todo.remove` closes the card with the todo; no card follows.
- `neo.todo.continue` closes the card and returns the todo to doing. The worker
  here never replies, so a later "nobody working on it" card is a separate matter.
- `neo.question.ask` with `replaces` leaves exactly one card.
- A check that passes closes the card by itself on the next pack sweep.

`--expect-bug` asserts the old behavior for a baseline on an earlier revision:
retire succeeds and a sweep opens a new card. No model reasoning is claimed.
