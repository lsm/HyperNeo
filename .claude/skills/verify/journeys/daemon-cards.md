**An overdue check, a twice-failed start and an ignored blocker each end in one card.**

Use the shared metadata-only isolated setup in SKILL.md. No model, provider,
worker or credential is used; the clock is a fixture.

```sh
TMPDIR=/private/tmp bash .claude/skills/verify/proof-run.sh "$EVIDENCE" \
  .claude/skills/verify/daemon-cards.ts verify
```

On a real daemon, driving its Neo refresh and answering on the human door
(`neo.question.answer`):

- A check-only todo gets no card before 24 hours and exactly one at 24 hours,
  even with two refreshes at once and after a restart. No note goes to Neo.
  Keep waiting holds the next card off for another 24 hours; Mark done finishes it.
- A todo added through the agent door whose start the driver refuses is retried
  twice by the daemon, then waits on one Retry / Mark done / Remove card.
  A retry from Neo retires that card; the new failures get two fresh automatic
  retries and one new card. Remove removes it.
- A worker blocker (seeded as the final-line blocker leaves it, with a stopped
  worker) that Neo leaves for an hour gets one card with the worker's words as
  its document. Mark done finishes it.

Evidence is `result.json` and `proof.log`. This proves the stored cards and the
daemon's handling of answers, not how the web renders them or how Neo words its turn.
