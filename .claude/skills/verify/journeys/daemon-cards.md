**A ready check-only step, a twice-failed start and an ignored blocker open no card; they reach Neo.**

Use the shared metadata-only isolated setup in SKILL.md. No model, provider,
worker or credential is used; the clock is a fixture.

```sh
TMPDIR=/private/tmp bash .claude/skills/verify/proof-run.sh "$EVIDENCE" \
  .claude/skills/verify/daemon-cards.ts verify
```

On a real daemon, driving its Neo refresh and attention sweep:

- A check-only todo with nothing unfinished before it gets no card and no wake
  while the daemon polls its check.
- A daemon card left open from before (a human-step card) still works: the human
  answers Mark done on the human door (`neo.question.answer`) and, after a
  restart, the daemon carries it out.
- A todo added through the agent door whose start the driver refuses is retried
  twice by the daemon, then is blocked by its failure with no card; the sweep
  wakes Neo once with "it failed: …", and Neo removes it.
- A worker blocker (seeded as the final-line blocker leaves it, with a stopped
  worker) that Neo leaves for two hours gets no card; the sweep wakes Neo with
  "it waits on an answer and no card is open".

Evidence is `result.json` and `proof.log`. This proves the stored rows and the
wakes queued for Neo, not how Neo words its turn.

The helper seeds an accepted historical ask for its unrelated work fixture.
Use new-work-source.md for the real proposal and human-approval path.
