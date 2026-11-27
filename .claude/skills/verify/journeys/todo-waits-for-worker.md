# A todo for a busy worker waits in the queue

The fixture seeds approved initial todos targeting a HyperNeo worker that is mid-turn. None reaches it: each stays
todo, unstarted, with a reason that says what it waits on. A wait past the stall step
tells Neo and the todo keeps waiting. When the worker frees up the higher priority
todo goes first, and the next one goes only after that one is done.

Read SKILL.md's shared isolation setup. This helper owns a real test daemon with
a fresh database and home. No provider, model, GUI or port 8399.

```bash
bash .claude/skills/verify/proof-run.sh /absolute/fresh/evidence-directory \
  .claude/skills/verify/todo-waits-for-worker.ts
```

The worker's turn is simulated by setting its session's processing state. The
authenticated `neo.snapshot` RPC shows the worker as working, queued, and then
waiting for review. A GitHub stub supplies the open PR that keeps the idle
worker reserved. The queued todo's reason names that PR. Backdate the wait,
refresh twice and confirm one new Neo wake with the replacement instructions.
The worker then frees up and the queued todo goes. Evidence is in `observed.json`
and the wrapper records the exit code.

Ordinary follow-up acceptance and post-turn delivery use the separate
worker-input-delivery journey. This journey exercises the initial todo scheduler.
