# Todo notes reach Neo through the attention entry (Wire)

Use shared isolation and cleanup in `../SKILL.md`. This proof boots one fresh
synthetic daemon on an ephemeral loopback port with the job processor stopped,
so no model, provider, browser or external HTTP is used.

```bash
bash .claude/skills/verify/proof-run.sh /absolute/fresh/evidence-directory \
  .claude/skills/verify/neo-attention-todo-notes.ts
```

The helper seeds two open asks on a synthetic Neo session, then runs the real
todo runner (`checkNow`, `refresh`), the real driver refresh
(`NeoService.refreshDriverWork`) and the real pack sweep
(`NeoService.sweepPacks`), each twice, with a controlled clock. Observe
`neo-attention-todo-notes.json`, which lists the wake queue (`mailbox`) and
the digest queue (`neo_notes`) after each pass:

- a todo the runner finishes and a start the runner finds interrupted add
  nothing by themselves: the done note is dropped and the failure is not a
  note of its own;
- the driver refresh tells the ask whose last todo finished once, as "All
  todos are finished", through the stalled-ask producer;
- the sweep then tells the failed start once, as a "needs your next step"
  wake that carries the failure;
- a todo that was never approved and has no card is one digest line, and one
  more a day later;
- the finished todo itself is never named in either queue.

This does not show a wake being consumed by a model turn, a stall or rescue
note from a real idle worker, or the digest flush; the unit tests cover the
stall, turn-question, tracker and start-fault notes on recorded facts.
