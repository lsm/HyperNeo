# Continue and bind wait for unfinished prerequisites

No model, provider, browser or GitHub is involved. Run from the worktree root with
a fresh absolute evidence directory:

```bash
bash .claude/skills/verify/proof-run.sh "$EVIDENCE" .claude/skills/verify/todo-prerequisite-gate.ts
```

The helper starts its own daemon (NODE_ENV=test, fresh HOME, data dir and DB,
ephemeral port) and calls the operations through the MCP door as Neo. `work.send`
and `work.status` are counted stubs, so the proof shows what reaches the worker
door, not delivery to a live worker.

With a prerequisite running or reopened, `neo.todo.add` with a bind target,
`neo.todo.continue` and `neo.todo.continue` on a failed step (its retry) each
return `not_ready`, send nothing and leave the steps as they were (the refused add
records no todo). Once the prerequisite is done, the same calls succeed; the bound
todo is doing and the retry queues its follow-up for the worker.
`evidence/todo-prerequisite-gate.json` holds one row per call.

The helper seeds an accepted historical ask for its unrelated work fixture.
Use new-work-source.md for the real proposal and human-approval path.
