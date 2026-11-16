# The sweep tells Neo about each todo only Neo can move (Wire)

Use shared isolation and cleanup in `../SKILL.md`. This proof boots one fresh
synthetic daemon on an ephemeral loopback port with the job processor stopped,
so no model, provider, browser or external HTTP is used.

```bash
bash .claude/skills/verify/proof-run.sh /absolute/fresh/evidence-directory \
  .claude/skills/verify/neo-attention-sweep.ts
```

The helper seeds one open ask on a synthetic Neo session and runs the real
pack sweep (`NeoService.sweepPacks`) twice at each time, with a controlled
clock. Observe `neo-attention-sweep.json` and the mailbox queue it reads:

- a failed todo with an idle worker and no card is one "needs your next step"
  wake with its failure, and one more after its 1 h rung;
- a failed todo under an open card, a todo with a start target, and a todo
  waiting on an unfinished prerequisite add nothing;
- once the failed todo is done it is no longer told;
- a finished todo marked `producesFollowUp` with nothing after it is told
  through the same entry;
- a check-only todo (a check, no instruction) adds nothing until 24 h after
  the later of its creation and its last prerequisite finishing, then is one
  "its check has not passed for 24 hours" wake, and one more at its 1 h rung.

This does not show the wake being consumed by a model turn, the pack `waiting`
answer on a real pull request, or live worker status from a driver; the unit
tests cover the idle-worker, pack and queue-hold rows on recorded facts.
